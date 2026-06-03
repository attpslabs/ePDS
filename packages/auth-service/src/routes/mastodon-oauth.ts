/**
 * "Sign in with Mastodon" OAuth endpoints for registered API clients.
 *
 * Mastodon has no central OAuth server — every instance is its own
 * authorization server and requires per-instance dynamic app registration
 * (POST /api/v1/apps) before the authorize/token flow. So this is split into:
 *
 *   POST /_internal/mastodon/start    — discover instance, register+cache app,
 *                                        return the authorize URL + state
 *   POST /_internal/mastodon/callback — exchange code, verify identity, then
 *                                        log in / signup / ask for a handle
 *   POST /_internal/mastodon/complete — finish a brand-new signup once the
 *                                        client has collected a handle
 *
 * Both are authenticated via x-api-key (same as the headless OTP endpoints)
 * and reuse handleLogin/handleSignup so Mastodon issues AT Protocol sessions
 * exactly like email OTP does. A verified Mastodon identity is linked to a
 * self.surf DID via the connected_account table, so returning users sign
 * back into the same account.
 *
 * All outbound calls to arbitrary user-supplied instances go through the
 * SSRF-hardened safeFetch.
 */
import { Router, type Request, type Response } from 'express'
import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { createLogger, makeSafeFetch } from '@certified-app/shared'
import type { AuthServiceContext } from '../context.js'
import { resolveLoginHint } from '../lib/resolve-login-hint.js'
import {
  authenticateApiKey,
  checkAllowedOrigin,
  checkApiClientRateLimit,
} from '../lib/headless-auth.js'
import {
  handleLogin,
  handleSignup,
  getPdsUrl,
  getHandleDomain,
} from '../lib/account-session.js'

const logger = createLogger('auth:mastodon-oauth')

const PROVIDER = 'mastodon'
const SCOPES = 'read:accounts'
const FLOW_TTL_MS = 10 * 60 * 1000
const VERIFIED_TTL_MS = 10 * 60 * 1000

// SSRF-hardened fetch for talking to arbitrary Mastodon instances.
// EPDS_ALLOW_PRIVATE_IPS mirrors the opt-out used elsewhere for docker e2e.
const safeFetch = makeSafeFetch({
  timeoutMs: 5_000,
  maxBodyBytes: 100_000,
  allowPrivateIps: process.env.EPDS_ALLOW_PRIVATE_IPS === 'true',
})

interface DiscoveredEndpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
}

/**
 * Parse `@alice@mastodon.social` / `alice@mastodon.social` into
 * `{ username, instance }`. Returns null if not a valid acct form.
 */
function parseMastodonHandle(
  raw: string,
): { username: string; instance: string } | null {
  const cleaned = raw.trim().replace(/^@/, '')
  const parts = cleaned.split('@')
  if (parts.length !== 2) return null
  const [username, instance] = parts
  if (!username || !instance) return null
  // Instance must look like a hostname; reject anything with a path/scheme.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(instance)) return null
  return { username: username.toLowerCase(), instance: instance.toLowerCase() }
}

/**
 * Discover OAuth endpoints via RFC 8414 metadata (Mastodon 4.3.0+),
 * falling back to the conventional paths on older instances.
 */
async function discoverEndpoints(
  instance: string,
): Promise<DiscoveredEndpoints> {
  const base = `https://${instance}`
  const fallback: DiscoveredEndpoints = {
    authorizationEndpoint: `${base}/oauth/authorize`,
    tokenEndpoint: `${base}/oauth/token`,
    registrationEndpoint: `${base}/api/v1/apps`,
  }
  try {
    const res = await safeFetch(
      `${base}/.well-known/oauth-authorization-server`,
    )
    if (!res.ok) return fallback
    const meta = (await res.json()) as {
      authorization_endpoint?: string
      token_endpoint?: string
      registration_endpoint?: string
    }
    return {
      authorizationEndpoint: meta.authorization_endpoint ?? fallback.authorizationEndpoint,
      tokenEndpoint: meta.token_endpoint ?? fallback.tokenEndpoint,
      // Mastodon's metadata uses /api/v1/apps; registration_endpoint may be absent.
      registrationEndpoint: meta.registration_endpoint ?? fallback.registrationEndpoint,
    }
  } catch (err) {
    logger.warn({ err, instance }, 'OAuth metadata discovery failed; using fallback paths')
    return fallback
  }
}

/** Look up cached app creds for an instance, or register a new app and cache them. */
async function getOrRegisterApp(
  ctx: AuthServiceContext,
  instance: string,
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const cached = ctx.db.getMastodonApp(instance)
  if (cached) {
    return { clientId: cached.clientId, clientSecret: cached.clientSecret }
  }

  const clientName = process.env.SMTP_FROM_NAME ?? 'Linkname'
  const res = await safeFetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Registration uses `scopes` (plural) and `client_name`.
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: redirectUri,
      scopes: SCOPES,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    logger.error({ instance, status: res.status, body }, 'Mastodon app registration failed')
    throw new Error('Could not register with that Mastodon server')
  }
  const app = (await res.json()) as {
    client_id?: string
    client_secret?: string
  }
  if (!app.client_id || !app.client_secret) {
    throw new Error('Mastodon server returned incomplete app credentials')
  }
  ctx.db.upsertMastodonApp(instance, app.client_id, app.client_secret)
  return { clientId: app.client_id, clientSecret: app.client_secret }
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * Synthetic, non-deliverable email for a Mastodon-created account.
 * Mastodon's verify_credentials doesn't return the user's email, and
 * Mastodon login never relies on email (identity resolves via
 * connected_account), so a unique placeholder is sufficient for
 * createAccount. A real recovery email can be added later via the
 * existing backup-email flow.
 */
function syntheticEmail(instance: string, mastodonId: string): string {
  return `mastodon-${mastodonId}@${instance}.mastodon.invalid`
}

export function createMastodonOauthRouter(ctx: AuthServiceContext): Router {
  const router = Router()

  /** Shared guard: API key + origin + rate limit. Returns true if the request may proceed. */
  function guard(req: Request, res: Response, action: string): boolean {
    const apiClient = authenticateApiKey(req, ctx.db)
    if (!apiClient) {
      logger.warn({ ip: req.ip }, `Mastodon ${action}: invalid API key`)
      res.status(401).json({ error: 'Unauthorized' })
      return false
    }
    if (!checkAllowedOrigin(apiClient.allowedOrigins, req.headers.origin)) {
      res.status(403).json({ error: 'OriginNotAllowed' })
      return false
    }
    if (!checkApiClientRateLimit(ctx.db, apiClient.id, apiClient.rateLimitPerHour)) {
      res.status(429).json({ error: 'RateLimitExceeded' })
      return false
    }
    ctx.db.recordApiClientUsage(apiClient.id, `mastodon_${action}`)
    ctx.db.updateApiClientLastUsed(apiClient.id)
    return true
  }

  // ─── POST /_internal/mastodon/start ─────────────────────────────────
  router.post('/_internal/mastodon/start', async (req: Request, res: Response) => {
    if (!guard(req, res, 'start')) return

    const handle = ((req.body?.handle as string) || '').trim()
    const redirectUri = ((req.body?.redirectUri as string) || '').trim()
    const claimHandle =
      ((req.body?.claimHandle as string) || '').trim().toLowerCase() || null

    if (!handle || !redirectUri) {
      res.status(400).json({ error: 'handle and redirectUri are required' })
      return
    }

    const parsed = parseMastodonHandle(handle)
    if (!parsed) {
      res.status(400).json({ error: 'Enter your full Mastodon handle, e.g. you@mastodon.social' })
      return
    }
    const { instance } = parsed

    try {
      const endpoints = await discoverEndpoints(instance)
      const { clientId } = await getOrRegisterApp(
        ctx,
        instance,
        endpoints.registrationEndpoint,
        redirectUri,
      )

      const { verifier, challenge } = pkce()
      const state = randomBytes(32).toString('base64url')

      ctx.db.createMastodonOauthFlow({
        state,
        instance,
        tokenEndpoint: endpoints.tokenEndpoint,
        codeVerifier: verifier,
        redirectUri,
        claimHandle,
        expiresAt: Date.now() + FLOW_TTL_MS,
      })

      // Authorize endpoint uses `scope` (singular).
      const authorizeUrl = new URL(endpoints.authorizationEndpoint)
      authorizeUrl.searchParams.set('response_type', 'code')
      authorizeUrl.searchParams.set('client_id', clientId)
      authorizeUrl.searchParams.set('redirect_uri', redirectUri)
      authorizeUrl.searchParams.set('scope', SCOPES)
      authorizeUrl.searchParams.set('state', state)
      authorizeUrl.searchParams.set('code_challenge', challenge)
      authorizeUrl.searchParams.set('code_challenge_method', 'S256')

      res.json({ authorizeUrl: authorizeUrl.toString(), state })
    } catch (err) {
      logger.error({ err, instance }, 'Mastodon start failed')
      const message = err instanceof Error ? err.message : 'Could not start Mastodon sign-in'
      res.status(502).json({ error: message })
    }
  })

  // ─── POST /_internal/mastodon/callback ──────────────────────────────
  router.post('/_internal/mastodon/callback', async (req: Request, res: Response) => {
    if (!guard(req, res, 'callback')) return

    const code = ((req.body?.code as string) || '').trim()
    const state = ((req.body?.state as string) || '').trim()
    if (!code || !state) {
      res.status(400).json({ error: 'code and state are required' })
      return
    }

    const flow = ctx.db.getMastodonOauthFlow(state)
    if (!flow) {
      res.status(400).json({ error: 'Sign-in expired. Please try again.' })
      return
    }
    // Single-use: consume the flow row immediately.
    ctx.db.deleteMastodonOauthFlow(state)

    const app = ctx.db.getMastodonApp(flow.instance)
    if (!app) {
      logger.error({ instance: flow.instance }, 'Mastodon callback: no cached app for instance')
      res.status(500).json({ error: 'Mastodon sign-in misconfigured. Please try again.' })
      return
    }

    try {
      // Exchange code → access token.
      const tokenRes = await safeFetch(flow.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: app.clientId,
          client_secret: app.clientSecret,
          redirect_uri: flow.redirectUri,
          code_verifier: flow.codeVerifier,
        }).toString(),
      })
      if (!tokenRes.ok) {
        const body = await tokenRes.text().catch(() => '')
        logger.warn({ status: tokenRes.status, body }, 'Mastodon token exchange failed')
        res.status(400).json({ error: 'Mastodon sign-in failed. Please try again.' })
        return
      }
      const token = (await tokenRes.json()) as { access_token?: string }
      if (!token.access_token) {
        res.status(400).json({ error: 'Mastodon did not return an access token' })
        return
      }

      // Verify identity. `acct` is bare for the own account, so build the
      // canonical provider_account from username + the known instance.
      const meRes = await safeFetch(
        `https://${flow.instance}/api/v1/accounts/verify_credentials`,
        { headers: { Authorization: `Bearer ${token.access_token}` } },
      )
      if (!meRes.ok) {
        logger.warn({ status: meRes.status }, 'Mastodon verify_credentials failed')
        res.status(400).json({ error: 'Could not verify your Mastodon account' })
        return
      }
      const me = (await meRes.json()) as { id?: string; username?: string; acct?: string }
      const username = (me.username || me.acct || '').split('@')[0].toLowerCase()
      if (!me.id || !username) {
        res.status(400).json({ error: 'Mastodon returned an incomplete profile' })
        return
      }
      const providerAccount = `${username}@${flow.instance}`

      const pdsUrl = getPdsUrl()
      const internalSecret = process.env.EPDS_INTERNAL_SECRET ?? ''

      // Returning user: linked DID exists → log in.
      const existingDid = ctx.db.getDidByConnectedAccount(PROVIDER, providerAccount)
      if (existingDid) {
        const email = await resolveLoginHint(existingDid, pdsUrl, internalSecret)
        if (!email) {
          logger.error({ did: existingDid }, 'Mastodon login: could not resolve linked DID to email')
          res.status(500).json({ error: 'Sign-in failed. Please try again.' })
          return
        }
        const result = await handleLogin(email, pdsUrl)
        res.json(result)
        return
      }

      // New user. A forced/claimed handle (AAA claim path) signs up immediately.
      const email = syntheticEmail(flow.instance, me.id)
      if (flow.claimHandle) {
        const result = await handleSignup(email, flow.claimHandle, getHandleDomain(), pdsUrl)
        ctx.db.addConnectedAccount({
          id: randomUUID(),
          did: result.did,
          provider: PROVIDER,
          providerAccount,
          providerEmail: null,
        })
        res.status(201).json(result)
        return
      }

      // New user, login path: stash the verified identity and ask the client
      // for a handle. code/state are spent, so the chooser submits this token.
      const verifiedToken = randomBytes(32).toString('base64url')
      ctx.db.createMastodonVerified({
        verifiedToken,
        instance: flow.instance,
        providerAccount,
        email,
        expiresAt: Date.now() + VERIFIED_TTL_MS,
      })
      res.json({
        needsHandle: true,
        provider: PROVIDER,
        providerAccount,
        suggestedHandle: username.replace(/[^a-z0-9-]/g, ''),
        verifiedToken,
      })
    } catch (err) {
      logger.error({ err, instance: flow.instance }, 'Mastodon callback failed')
      const message = err instanceof Error ? err.message : 'Mastodon sign-in failed'
      res.status(502).json({ error: message })
    }
  })

  // ─── POST /_internal/mastodon/complete ──────────────────────────────
  // Finish a brand-new signup after the client has collected a handle.
  router.post('/_internal/mastodon/complete', async (req: Request, res: Response) => {
    if (!guard(req, res, 'complete')) return

    const verifiedToken = ((req.body?.verifiedToken as string) || '').trim()
    const handle = ((req.body?.handle as string) || '').trim().toLowerCase()
    if (!verifiedToken || !handle) {
      res.status(400).json({ error: 'verifiedToken and handle are required' })
      return
    }

    const verified = ctx.db.getMastodonVerified(verifiedToken)
    if (!verified) {
      res.status(400).json({ error: 'Sign-in expired. Please try again.' })
      return
    }
    // Single-use.
    ctx.db.deleteMastodonVerified(verifiedToken)

    try {
      const pdsUrl = getPdsUrl()
      const result = await handleSignup(verified.email, handle, getHandleDomain(), pdsUrl)
      ctx.db.addConnectedAccount({
        id: randomUUID(),
        did: result.did,
        provider: PROVIDER,
        providerAccount: verified.providerAccount,
        providerEmail: null,
      })
      res.status(201).json(result)
    } catch (err) {
      logger.error({ err }, 'Mastodon complete (signup) failed')
      const message = err instanceof Error ? err.message : 'Account creation failed'
      res.status(500).json({ error: message })
    }
  })

  return router
}

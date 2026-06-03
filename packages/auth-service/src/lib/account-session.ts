/**
 * Shared account session-issuing helpers.
 *
 * Extracted from headless-otp.ts so multiple auth strategies (email OTP,
 * recovery, Mastodon OAuth) issue AT Protocol sessions through exactly the
 * same path. No behavior change — these are the original headless-otp
 * implementations moved verbatim.
 *
 * - handleLogin: ephemeral-password → com.atproto.server.createSession
 * - handleSignup: invite code → com.atproto.server.createAccount
 */
import { randomBytes } from 'node:crypto'
import { createLogger } from '@certified-app/shared'
import { getDidByEmail } from './get-did-by-email.js'
import { ensurePdsUrl } from './pds-url.js'

const logger = createLogger('auth:account-session')

export function adminAuth(): string {
  const password = process.env.PDS_ADMIN_PASSWORD
  if (!password) throw new Error('PDS_ADMIN_PASSWORD is not configured')
  return `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`
}

export function getPdsUrl(): string {
  return ensurePdsUrl(
    process.env.PDS_INTERNAL_URL,
    `https://${process.env.PDS_HOSTNAME ?? 'localhost'}`,
  )
}

export function getHandleDomain(): string {
  return process.env.PDS_HOSTNAME ?? 'localhost'
}

// ─── Login: ephemeral password → session tokens ────────────────────────
export async function handleLogin(
  email: string,
  pdsUrl: string,
): Promise<{
  did: string
  handle: string
  accessJwt: string
  refreshJwt: string
}> {
  const internalSecret = process.env.EPDS_INTERNAL_SECRET ?? ''
  const did = await getDidByEmail(email, pdsUrl, internalSecret)
  if (!did) {
    throw new Error('No account found with this email address')
  }

  // Ephemeral password: set → use → discard
  const ephemeralPassword = randomBytes(32).toString('hex')

  // Reset password via admin API
  const resetRes = await fetch(
    `${pdsUrl}/xrpc/com.atproto.admin.updateAccountPassword`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: adminAuth(),
      },
      body: JSON.stringify({ did, password: ephemeralPassword }),
    },
  )
  if (!resetRes.ok) {
    const error = await resetRes.text()
    logger.error(
      { did, status: resetRes.status, error },
      'Failed to reset password',
    )
    throw new Error('Failed to authenticate account')
  }

  // Create session with ephemeral password
  const sessionRes = await fetch(
    `${pdsUrl}/xrpc/com.atproto.server.createSession`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: email, password: ephemeralPassword }),
    },
  )
  if (!sessionRes.ok) {
    const error = await sessionRes.text()
    logger.error(
      { did, status: sessionRes.status, error },
      'Failed to create session',
    )
    throw new Error('Login failed')
  }

  const session = (await sessionRes.json()) as {
    did: string
    handle: string
    accessJwt: string
    refreshJwt: string
  }

  return {
    did: session.did,
    handle: session.handle,
    accessJwt: session.accessJwt,
    refreshJwt: session.refreshJwt,
  }
}

// ─── Signup: invite → account → session tokens ─────────────────────────
export async function handleSignup(
  email: string,
  handle: string,
  handleDomain: string,
  pdsUrl: string,
): Promise<{
  did: string
  handle: string
  accessJwt: string
  refreshJwt: string
  created: boolean
}> {
  const ephemeralPassword = randomBytes(32).toString('hex')
  const fullHandle = `${handle}.${handleDomain}`

  // Mint invite code
  const inviteRes = await fetch(
    `${pdsUrl}/xrpc/com.atproto.server.createInviteCode`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: adminAuth(),
      },
      body: JSON.stringify({ useCount: 1 }),
    },
  )
  if (!inviteRes.ok) {
    const error = await inviteRes.text()
    logger.error(
      { status: inviteRes.status, error },
      'Failed to mint invite code',
    )
    throw new Error('Account creation temporarily unavailable')
  }
  const { code: inviteCode } = (await inviteRes.json()) as { code: string }

  // Create account
  const createRes = await fetch(
    `${pdsUrl}/xrpc/com.atproto.server.createAccount`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        handle: fullHandle,
        password: ephemeralPassword,
        inviteCode,
      }),
    },
  )
  if (!createRes.ok) {
    const errorData = (await createRes.json()) as {
      error?: string
      message?: string
    }
    const errorCode = errorData.error || ''
    const errorMessages: Record<string, string> = {
      HandleNotAvailable: 'This handle is already taken',
      InvalidHandle: 'Invalid handle format',
      EmailNotAvailable: 'An account with this email already exists',
    }
    throw new Error(
      errorMessages[errorCode] ||
        errorData.message ||
        'Account creation failed',
    )
  }

  const session = (await createRes.json()) as {
    did: string
    handle: string
    accessJwt: string
    refreshJwt: string
  }

  return {
    did: session.did,
    handle: session.handle,
    accessJwt: session.accessJwt,
    refreshJwt: session.refreshJwt,
    created: true,
  }
}

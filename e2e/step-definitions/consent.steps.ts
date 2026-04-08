/**
 * Step definitions for consent-screen.feature.
 *
 * TODO: The @manual "client branding" scenario is not automated yet —
 * it depends on custom CSS injection being wired into the consent route
 * (renderConsent() needs to accept and apply clientBrandingCss from the
 * client metadata).
 */

import { Given, Then, When } from '@cucumber/cucumber'
import { expect } from '@playwright/test'
import type { EpdsWorld } from '../support/world.js'
import { testEnv } from '../support/env.js'
import {
  getPage,
  resetBrowserContext,
  assertDemoClientSession,
} from '../support/utils.js'
import {
  createAccountViaOAuth,
  startSignUpAwaitingConsent,
} from '../support/flows.js'
import { sharedBrowser } from '../support/hooks.js'
import { waitForEmail, extractOtp, clearMailpit } from '../support/mailpit.js'

function requireUntrustedDemoUrl(): string {
  const url = testEnv.demoUntrustedUrl
  if (!url) {
    throw new Error(
      'E2E_DEMO_UNTRUSTED_URL is not set — required by consent-screen scenarios ' +
        'that exercise the trusted-vs-untrusted client distinction. Set it in ' +
        'e2e/.env (locally) or in the GitHub Actions workflow (CI).',
    )
  }
  return url
}

// Note: When('the user clicks {string}') lives in common.steps.ts — it is a
// generic UI interaction step used here for "Authorize" and "Deny access" buttons.

Then('a consent screen is displayed', async function (this: EpdsWorld) {
  const page = getPage(this)

  // 1. The Authorize button is the most reliable marker that we're
  //    actually on the consent page (as opposed to e.g. /welcome,
  //    which has no Authorize button).
  await expect(page.getByRole('button', { name: 'Authorize' })).toBeVisible({
    timeout: 30_000,
  })

  // 2. The demo clients request `atproto transition:generic`. For that
  //    scope set, @atproto/oauth-provider-ui's ScopeDescription renders
  //    multiple permission cards — including one titled "Authenticate"
  //    via the RpcMethodsDetails component, which fires on
  //    hasTransitionGeneric. Assert that card is visible: this proves
  //    the scope was actually parsed and rendered a permission summary,
  //    not that the page loaded blank with just an Authorize button.
  //
  //    We deliberately do NOT assert on the raw scope strings
  //    (`atproto`, `transition:generic`) being visible on the page —
  //    those only appear inside a collapsed "Technical details"
  //    <Admonition> panel that is hidden (HTML `hidden` attribute +
  //    aria-hidden="true") until the user clicks its disclosure
  //    button. Asserting on the user-facing scope card is both more
  //    meaningful (what users actually see) and more resilient
  //    (doesn't depend on the details-panel implementation).
  await expect(
    page.getByRole('heading', { name: 'Authenticate' }),
  ).toBeVisible()
})

/**
 * Fetches the client_name from a demo client's metadata document and
 * asserts that exact string is visible on the currently-displayed page.
 * Shared between the trusted / untrusted variants of the "shows the
 * demo client's name" step.
 */
async function assertClientNameVisibleFromMetadata(
  world: EpdsWorld,
  baseUrl: string,
): Promise<void> {
  const metadataUrl = `${baseUrl}/client-metadata.json`
  const res = await fetch(metadataUrl)
  if (!res.ok) {
    throw new Error(
      `Demo client metadata not found: ${res.status} at ${metadataUrl}`,
    )
  }

  const body = (await res.json()) as Record<string, unknown>
  const clientName =
    typeof body.client_name === 'string' ? body.client_name.trim() : ''
  if (!clientName) {
    throw new Error(
      `client-metadata.json at ${metadataUrl} is missing client_name`,
    )
  }

  const page = getPage(world)
  await expect(page.getByText(clientName, { exact: true })).toBeVisible()
}

Then(
  "it shows the untrusted demo client's name",
  async function (this: EpdsWorld) {
    await assertClientNameVisibleFromMetadata(this, requireUntrustedDemoUrl())
  },
)

When(
  'the untrusted demo client initiates an OAuth login',
  async function (this: EpdsWorld) {
    const page = getPage(this)
    await page.goto(requireUntrustedDemoUrl())
  },
)

Then(
  'the browser is redirected to the PDS with an access_denied error',
  async function (this: EpdsWorld) {
    const page = getPage(this)
    // Deny redirects to <PDS>/oauth/authorize?request_uri=...&error=access_denied
    await page.waitForURL('**/oauth/authorize**error=access_denied**', {
      timeout: 30_000,
    })
  },
)

Then('no consent screen is shown', async function (this: EpdsWorld) {
  const page = getPage(this)
  // If no consent screen, the user should have landed directly on /welcome.
  // We check the URL rather than asserting the button is absent, because
  // by the time this step runs the page has already navigated away.
  await page.waitForURL('**/welcome', { timeout: 30_000 })
})

// ---------------------------------------------------------------------------
// Sign-up consent-skip scenarios (trusted vs. untrusted demo clients)
// ---------------------------------------------------------------------------

When(
  'a new user signs up via the trusted demo client',
  async function (this: EpdsWorld) {
    if (!testEnv.mailpitPass) return 'pending'
    const email = `trusted-signup-${Date.now()}@example.com`
    await createAccountViaOAuth(this, email, testEnv.demoTrustedUrl)
  },
)

When(
  'a new user starts signing up via the untrusted demo client',
  async function (this: EpdsWorld) {
    if (!testEnv.mailpitPass) return 'pending'
    const email = `untrusted-signup-${Date.now()}@example.com`
    await startSignUpAwaitingConsent(this, email, requireUntrustedDemoUrl())
  },
)

Then(
  'the browser is redirected back to the trusted demo client with a valid session',
  async function (this: EpdsWorld) {
    await assertDemoClientSession(this, testEnv.demoTrustedUrl)
  },
)

Then(
  'the browser is redirected back to the untrusted demo client with a valid session',
  async function (this: EpdsWorld) {
    await assertDemoClientSession(this, requireUntrustedDemoUrl())
  },
)

Given(
  'a returning user signed up via the trusted demo client with consent skipped',
  async function (this: EpdsWorld) {
    if (!testEnv.mailpitPass) return 'pending'

    const email = `carryover-${Date.now()}@example.com`

    // Sign up via the trusted demo — the consent-skip code path fires
    // server-side because all three conditions hold (PDS flag,
    // PDS_OAUTH_TRUSTED_CLIENTS membership, client metadata opt-in).
    // createAccountViaOAuth waits for /welcome, so reaching this point
    // without a consent screen confirms the skip actually happened.
    await createAccountViaOAuth(this, email, testEnv.demoTrustedUrl)

    // Reset browser context so the second OAuth flow (against a different
    // client) starts without cookies from the sign-up — we want to test
    // whether the SCOPE authorisation carries over, not the browser session.
    await resetBrowserContext(this, sharedBrowser)
  },
)

When(
  'the user later initiates an OAuth login via the untrusted demo client',
  async function (this: EpdsWorld) {
    if (!testEnv.mailpitPass) return 'pending'
    if (!this.testEmail) {
      throw new Error(
        'No testEmail on world — the "signed up via the trusted demo client" ' +
          'Given must run first',
      )
    }

    const page = getPage(this)
    // Clear stale OTP emails before firing the new send so waitForEmail
    // below reads the code generated by this flow, not a leftover one.
    await clearMailpit(this.testEmail)

    await page.goto(requireUntrustedDemoUrl())
    await page.fill('#email', this.testEmail)
    await page.click('button[type=submit]')
    await expect(page.locator('#step-otp.active')).toBeVisible({
      timeout: 30_000,
    })

    const message = await waitForEmail(`to:${this.testEmail}`)
    const otp = await extractOtp(message.ID)
    await page.fill('#code', otp)
    await page.click('#form-verify-otp .btn-primary')
  },
)

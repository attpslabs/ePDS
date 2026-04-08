/**
 * Step definitions for consent-screen.feature.
 *
 * TODO: Scenario 5 (consent page shows client branding) is tagged @manual.
 * Automate once custom CSS injection is merged into the consent route
 * (renderConsent() needs to accept and apply clientBrandingCss from client metadata).
 */

import { Then } from '@cucumber/cucumber'
import { expect } from '@playwright/test'
import type { EpdsWorld } from '../support/world.js'
import { testEnv } from '../support/env.js'
import { getPage } from '../support/utils.js'

// Note: When('the user clicks {string}') lives in common.steps.ts — it is a
// generic UI interaction step used here for "Authorize" and "Deny access" buttons.

// Exact scope set requested by both demo clients (trusted and untrusted).
// Sourced from packages/demo/src/app/client-metadata.json/route.ts — if the
// demo clients ever change which scopes they request, update this list in
// lock-step. Order is not significant: the assertion sorts both sides.
const DEMO_CLIENT_REQUESTED_SCOPES = ['atproto', 'transition:generic']

Then('a consent screen is displayed', async function (this: EpdsWorld) {
  const page = getPage(this)

  // Assert the Authorize button is rendered.
  await expect(page.getByRole('button', { name: 'Authorize' })).toBeVisible({
    timeout: 30_000,
  })

  // Assert the permissions-request preamble. This is the fixed English
  // copy rendered by @atproto/oauth-provider-ui in its consent-form view,
  // just above the <ul> listing the requested scopes. Anchoring on it
  // ensures we're looking at the real consent screen (not e.g. an empty
  // layout that happens to contain an Authorize button).
  await expect(
    page.getByText(
      'This application is requesting the following list of technical permissions',
    ),
  ).toBeVisible()

  // Assert the exact set of scopes rendered in the <code> list items below
  // the preamble. The upstream view renders each scope as
  // <li><code>{scope}</code></li>. Checking the exact set (not just a
  // substring match) catches both under-asking and over-asking regressions.
  const byLocale = (a: string, b: string): number => a.localeCompare(b)
  const renderedScopes = (await page.locator('ul li code').allTextContents())
    .map((s) => s.trim())
    .sort(byLocale)
  expect(renderedScopes).toEqual(
    [...DEMO_CLIENT_REQUESTED_SCOPES].sort(byLocale),
  )
})

Then("it shows the demo client's name", async function (this: EpdsWorld) {
  const res = await fetch(`${testEnv.demoUrl}/client-metadata.json`)
  if (!res.ok) {
    throw new Error(
      `Demo client metadata not found: ${res.status} at ${testEnv.demoUrl}/client-metadata.json`,
    )
  }

  const body = (await res.json()) as Record<string, unknown>
  const clientName =
    typeof body.client_name === 'string' ? body.client_name.trim() : ''
  if (!clientName) {
    throw new Error('client-metadata.json is missing client_name')
  }

  const page = getPage(this)
  await expect(page.getByText(clientName, { exact: true })).toBeVisible()
})

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

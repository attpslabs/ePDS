/**
 * SSRF-hardened fetch utility.
 *
 * Thin wrapper around @atproto-labs/fetch-node's safeFetchWrap, which
 * provides proper DNS-level SSRF protection via a custom undici dispatcher
 * (no TOCTOU race between DNS resolution and connection).
 *
 * Re-exported as `makeSafeFetch` so callers keep the same API surface.
 */

import { safeFetchWrap } from '@atproto-labs/fetch-node'

export type SafeFetchOptions = {
  /** Request timeout in milliseconds. Default: 5_000 */
  timeoutMs?: number
  /** Maximum allowed response body in bytes. Default: 100_000 (100 KB) */
  maxBodyBytes?: number
}

/**
 * Returns an SSRF-hardened fetch function. The returned function has the same
 * signature as the standard `fetch` API but restricted to safe, public URLs.
 *
 * The upstream safeFetchWrap captures its `fetch` parameter at construction
 * time. We defer construction to the first call so that test mocks applied
 * to `globalThis.fetch` after module import are respected.
 *
 * @example
 * const safeFetch = makeSafeFetch({ timeoutMs: 5_000, maxBodyBytes: 100_000 })
 * const res = await safeFetch('https://example.com/data.json')
 */
export function makeSafeFetch(options: SafeFetchOptions = {}) {
  const { timeoutMs = 5_000, maxBodyBytes = 100_000 } = options

  let wrappedFetch: ReturnType<typeof safeFetchWrap> | null = null
  let capturedFetch: typeof globalThis.fetch | null = null

  function getWrappedFetch() {
    // Rebuild the wrapper if globalThis.fetch changed (test mocks)
    if (!wrappedFetch || globalThis.fetch !== capturedFetch) {
      capturedFetch = globalThis.fetch
      wrappedFetch = safeFetchWrap({
        fetch: globalThis.fetch,
        timeout: timeoutMs,
        responseMaxSize: maxBodyBytes,
        allowHttp: false,
        allowPrivateIps: false,
        allowImplicitRedirect: false,
      })
    }
    return wrappedFetch
  }

  return async function safeFetch(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    return getWrappedFetch()(url, { redirect: 'error', ...init })
  }
}

/**
 * Tests for makeSafeFetch — thin wrapper around @atproto-labs/fetch-node.
 *
 * These tests verify that our wrapper configures the upstream library
 * correctly. The upstream library's own test suite covers IP blocking,
 * DNS-level SSRF protection, timeout behaviour, and response size limits.
 */
import { describe, it, expect } from 'vitest'
import { makeSafeFetch } from '../safe-fetch.js'

describe('makeSafeFetch', () => {
  it('rejects http:// URLs', async () => {
    const safeFetch = makeSafeFetch()
    await expect(
      safeFetch('http://example.com/data.json'), // NOSONAR — intentional: testing SSRF guard
    ).rejects.toThrow()
  })

  it('rejects non-URL strings', async () => {
    const safeFetch = makeSafeFetch()
    await expect(safeFetch('not-a-url')).rejects.toThrow()
  })

  it('rejects private IP literals', async () => {
    const safeFetch = makeSafeFetch()
    await expect(
      safeFetch('https://127.0.0.1/client-metadata.json'), // NOSONAR
    ).rejects.toThrow()
  })
})

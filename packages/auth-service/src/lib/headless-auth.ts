/**
 * Authentication helpers for headless OTP endpoints.
 *
 * Single auth path: all callers authenticate via `x-api-key` header.
 * The key is SHA-256 hashed and looked up in the `api_clients` table.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'
import type { EpdsDb, ApiClientRow } from '@certified-app/shared'

/**
 * Authenticate a headless OTP request via x-api-key header.
 * Returns the matching ApiClientRow, or null if authentication fails.
 */
export function authenticateApiKey(
  req: Request,
  db: EpdsDb,
): ApiClientRow | null {
  const header = req.headers['x-api-key']
  if (!header || typeof header !== 'string') return null

  const keyHash = createHash('sha256').update(header).digest('hex')
  const client = db.getApiClientByKeyHash(keyHash)
  if (!client) return null

  // Defense-in-depth: timing-safe comparison on the hash even though the DB
  // lookup already matched. Prevents any timing leaks from the query itself.
  const expected = Buffer.from(client.apiKeyHash, 'hex')
  const actual = Buffer.from(keyHash, 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null
  }

  return client
}

/**
 * Check whether the request origin is allowed for this API client.
 * - If `allowedOrigins` is null/empty, all origins are allowed.
 * - If no Origin header is present (server-to-server call), the request is allowed.
 */
export function checkAllowedOrigin(
  allowedOrigins: string | null,
  requestOrigin: string | undefined,
): boolean {
  if (!allowedOrigins) return true
  if (!requestOrigin) return true

  const allowed = allowedOrigins.split(',').map((o) => o.trim())
  return allowed.includes(requestOrigin)
}

/**
 * Check whether the API client is within its per-hour rate limit.
 */
export function checkApiClientRateLimit(
  db: EpdsDb,
  clientId: string,
  limit: number,
): boolean {
  const oneHourMs = 60 * 60 * 1000
  const count = db.getApiClientUsageCount(clientId, oneHourMs)
  return count < limit
}

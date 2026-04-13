import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { EpdsDb } from '@certified-app/shared'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { Request } from 'express'
import {
  authenticateApiKey,
  checkAllowedOrigin,
  checkApiClientRateLimit,
} from '../lib/headless-auth.js'

let db: EpdsDb
let dbPath: string

beforeEach(() => {
  dbPath = path.join(
    os.tmpdir(),
    `epds-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  )
  db = new EpdsDb(dbPath)
})

afterEach(() => {
  db.close()
  try {
    fs.unlinkSync(dbPath)
    // eslint-disable-next-line no-empty
  } catch {}
  try {
    fs.unlinkSync(dbPath + '-wal')
    // eslint-disable-next-line no-empty
  } catch {}
  try {
    fs.unlinkSync(dbPath + '-shm')
    // eslint-disable-next-line no-empty
  } catch {}
})

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function makeReq(headers: Record<string, string> = {}) {
  return { headers } as unknown as Request
}

function createTestClient(
  overrides: Partial<{
    id: string
    name: string
    clientId: string | null
    apiKey: string
    allowedOrigins: string | null
    canSignup: boolean
    rateLimitPerHour: number
  }> = {},
) {
  const apiKey = overrides.apiKey ?? randomBytes(32).toString('hex')
  const id = overrides.id ?? randomUUID()
  db.createApiClient({
    id,
    name: overrides.name ?? 'TestApp',
    clientId: overrides.clientId ?? null,
    apiKeyHash: hashKey(apiKey),
    allowedOrigins: overrides.allowedOrigins ?? null,
    canSignup: overrides.canSignup ?? true,
    rateLimitPerHour: overrides.rateLimitPerHour ?? 10000,
  })
  return { id, apiKey }
}

describe('authenticateApiKey', () => {
  it('returns client for valid API key', () => {
    const { apiKey } = createTestClient({ name: 'ValidApp' })
    const req = makeReq({ 'x-api-key': apiKey })

    const result = authenticateApiKey(req, db)
    expect(result).not.toBeNull()
    expect(result!.name).toBe('ValidApp')
  })

  it('returns null for missing header', () => {
    createTestClient()
    const req = makeReq({})

    expect(authenticateApiKey(req, db)).toBeNull()
  })

  it('returns null for wrong key', () => {
    createTestClient()
    const req = makeReq({ 'x-api-key': 'wrong-key' })

    expect(authenticateApiKey(req, db)).toBeNull()
  })

  it('returns null for revoked client', () => {
    const { id, apiKey } = createTestClient()
    db.revokeApiClient(id)

    const req = makeReq({ 'x-api-key': apiKey })
    expect(authenticateApiKey(req, db)).toBeNull()
  })
})

describe('checkAllowedOrigin', () => {
  it('allows all when allowedOrigins is null', () => {
    expect(checkAllowedOrigin(null, 'https://evil.com')).toBe(true)
  })

  it('allows when no Origin header (server-to-server)', () => {
    expect(checkAllowedOrigin('https://example.com', undefined)).toBe(true)
  })

  it('allows matching origin', () => {
    expect(
      checkAllowedOrigin(
        'https://example.com,https://other.com',
        'https://example.com',
      ),
    ).toBe(true)
  })

  it('blocks mismatched origin', () => {
    expect(checkAllowedOrigin('https://example.com', 'https://evil.com')).toBe(
      false,
    )
  })
})

describe('checkApiClientRateLimit', () => {
  it('allows when under limit', () => {
    const clientId = randomUUID()
    db.recordApiClientUsage(clientId, 'otp_send')

    expect(checkApiClientRateLimit(db, clientId, 10)).toBe(true)
  })

  it('blocks when at limit', () => {
    const clientId = randomUUID()
    for (let i = 0; i < 5; i++) {
      db.recordApiClientUsage(clientId, 'otp_send')
    }

    expect(checkApiClientRateLimit(db, clientId, 5)).toBe(false)
  })

  it('allows when no usage recorded', () => {
    expect(checkApiClientRateLimit(db, randomUUID(), 100)).toBe(true)
  })
})

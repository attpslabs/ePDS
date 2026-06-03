import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { EpdsDb } from '../db.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

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

describe('Mastodon table self-heal backstop', () => {
  it('creates the v11 tables even when schema_version was advanced past 11 without them', () => {
    // Simulate a DB whose version counter reached 11 but the tables never
    // landed (stale/partial prior deploy on a persistent volume).
    db.close()
    const raw = new (require('better-sqlite3'))(dbPath)
    raw.exec('DROP TABLE IF EXISTS mastodon_app')
    raw.exec('DROP TABLE IF EXISTS mastodon_oauth_flow')
    raw.exec('DROP TABLE IF EXISTS mastodon_verified')
    raw.exec('DROP TABLE IF EXISTS connected_account')
    raw.prepare('UPDATE schema_version SET version = ?').run(11)
    raw.close()

    // Reopening via EpdsDb must self-heal the missing tables.
    db = new EpdsDb(dbPath)
    expect(db.getMastodonApp('mastodon.social')).toBeUndefined() // no throw = table exists
    db.upsertMastodonApp('mastodon.social', 'cid', 'secret')
    expect(db.getMastodonApp('mastodon.social')?.clientId).toBe('cid')
  })
})

describe('Mastodon app credential cache', () => {
  it('returns undefined for an unknown instance', () => {
    expect(db.getMastodonApp('mastodon.social')).toBeUndefined()
  })

  it('upserts and retrieves app credentials', () => {
    db.upsertMastodonApp('mastodon.social', 'cid-1', 'secret-1')
    const row = db.getMastodonApp('mastodon.social')
    expect(row?.clientId).toBe('cid-1')
    expect(row?.clientSecret).toBe('secret-1')
  })

  it('upsert overwrites existing credentials for the same instance', () => {
    db.upsertMastodonApp('mastodon.social', 'cid-1', 'secret-1')
    db.upsertMastodonApp('mastodon.social', 'cid-2', 'secret-2')
    const row = db.getMastodonApp('mastodon.social')
    expect(row?.clientId).toBe('cid-2')
    expect(row?.clientSecret).toBe('secret-2')
  })
})

describe('Mastodon OAuth flow state', () => {
  it('creates, retrieves, and single-use deletes a flow', () => {
    db.createMastodonOauthFlow({
      state: 'state-1',
      instance: 'mastodon.social',
      tokenEndpoint: 'https://mastodon.social/oauth/token',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/mastodon/callback',
      claimHandle: 'alice',
      expiresAt: Date.now() + 60_000,
    })

    const row = db.getMastodonOauthFlow('state-1')
    expect(row?.instance).toBe('mastodon.social')
    expect(row?.tokenEndpoint).toBe('https://mastodon.social/oauth/token')
    expect(row?.codeVerifier).toBe('verifier')
    expect(row?.claimHandle).toBe('alice')

    db.deleteMastodonOauthFlow('state-1')
    expect(db.getMastodonOauthFlow('state-1')).toBeUndefined()
  })

  it('does not return expired flows', () => {
    db.createMastodonOauthFlow({
      state: 'state-expired',
      instance: 'mastodon.social',
      tokenEndpoint: 'https://mastodon.social/oauth/token',
      codeVerifier: 'v',
      redirectUri: 'https://app.example/cb',
      expiresAt: Date.now() - 1,
    })
    expect(db.getMastodonOauthFlow('state-expired')).toBeUndefined()
  })

  it('cleanupExpiredMastodonFlows removes only expired rows', () => {
    db.createMastodonOauthFlow({
      state: 'live',
      instance: 'm.example',
      tokenEndpoint: 't',
      codeVerifier: 'v',
      redirectUri: 'r',
      expiresAt: Date.now() + 60_000,
    })
    db.createMastodonOauthFlow({
      state: 'dead',
      instance: 'm.example',
      tokenEndpoint: 't',
      codeVerifier: 'v',
      redirectUri: 'r',
      expiresAt: Date.now() - 1,
    })
    const removed = db.cleanupExpiredMastodonFlows()
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(db.getMastodonOauthFlow('live')).toBeDefined()
  })
})

describe('Mastodon verified (handle-pending) tokens', () => {
  it('creates, retrieves, and single-use deletes a verified token', () => {
    db.createMastodonVerified({
      verifiedToken: 'vt-1',
      instance: 'mastodon.social',
      providerAccount: 'alice@mastodon.social',
      email: 'mastodon-1@mastodon.social.mastodon.invalid',
      expiresAt: Date.now() + 60_000,
    })
    const row = db.getMastodonVerified('vt-1')
    expect(row?.providerAccount).toBe('alice@mastodon.social')
    expect(row?.email).toContain('mastodon.invalid')

    db.deleteMastodonVerified('vt-1')
    expect(db.getMastodonVerified('vt-1')).toBeUndefined()
  })

  it('round-trips imported Mastodon profile fields', () => {
    db.createMastodonVerified({
      verifiedToken: 'vt-profile',
      instance: 'mastodon.social',
      providerAccount: 'alice@mastodon.social',
      email: 'mastodon-9@mastodon.social.mastodon.invalid',
      displayName: 'Alice 🌸',
      bio: '<p>builder &amp; coffee</p>',
      avatarUrl: 'https://mastodon.social/avatars/alice.png',
      expiresAt: Date.now() + 60_000,
    })
    const row = db.getMastodonVerified('vt-profile')
    expect(row?.displayName).toBe('Alice 🌸')
    expect(row?.bio).toBe('<p>builder &amp; coffee</p>')
    expect(row?.avatarUrl).toBe('https://mastodon.social/avatars/alice.png')
  })

  it('defaults profile fields to null when omitted', () => {
    db.createMastodonVerified({
      verifiedToken: 'vt-noprofile',
      instance: 'mastodon.social',
      providerAccount: 'bob@mastodon.social',
      email: 'mastodon-10@mastodon.social.mastodon.invalid',
      expiresAt: Date.now() + 60_000,
    })
    const row = db.getMastodonVerified('vt-noprofile')
    expect(row?.displayName).toBeNull()
    expect(row?.bio).toBeNull()
    expect(row?.avatarUrl).toBeNull()
  })
})

describe('Connected account links', () => {
  it('links a Mastodon identity to a DID and resolves it back', () => {
    db.addConnectedAccount({
      id: randomUUID(),
      did: 'did:plc:alice',
      provider: 'mastodon',
      providerAccount: 'alice@mastodon.social',
      providerEmail: null,
    })
    expect(
      db.getDidByConnectedAccount('mastodon', 'alice@mastodon.social'),
    ).toBe('did:plc:alice')
  })

  it('returns undefined for an unlinked identity', () => {
    expect(
      db.getDidByConnectedAccount('mastodon', 'nobody@mastodon.social'),
    ).toBeUndefined()
  })

  it('is idempotent on duplicate (provider, providerAccount)', () => {
    const account = 'bob@hachyderm.io'
    db.addConnectedAccount({
      id: randomUUID(),
      did: 'did:plc:bob',
      provider: 'mastodon',
      providerAccount: account,
      providerEmail: null,
    })
    // Second insert with the same provider/account is ignored (UNIQUE).
    db.addConnectedAccount({
      id: randomUUID(),
      did: 'did:plc:bob',
      provider: 'mastodon',
      providerAccount: account,
      providerEmail: null,
    })
    expect(db.getConnectedAccounts('did:plc:bob')).toHaveLength(1)
  })
})

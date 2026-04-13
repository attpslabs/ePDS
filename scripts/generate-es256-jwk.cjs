#!/usr/bin/env node

// Generate an ES256 (P-256) private JWK with a deterministic kid.
// Output: compact JSON on stdout, suitable for EPDS_CLIENT_PRIVATE_JWK.
//
// The kid is a short hash of the public coordinates so the same keypair
// always produces the same kid, matching how the runtime client-jwk.ts
// helper derives it.

const crypto = require('crypto')
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = privateKey.export({ format: 'jwk' })
const h = crypto.createHash('sha256')
h.update(jwk.x)
h.update(jwk.y)
jwk.kid = h.digest('base64url').slice(0, 16)
process.stdout.write(JSON.stringify(jwk) + '\n')

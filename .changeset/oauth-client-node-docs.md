---
'ePDS': patch
---

Updated login integration docs to recommend `@atproto/oauth-client-node` and confidential clients.

**Affects:** Client app developers

**Client app developers:** The tutorial and skill reference now document
four login flows instead of two. Flows 2–4 (no hint, handle, DID) use
`@atproto/oauth-client-node`'s `NodeOAuthClient`, which handles PAR,
PKCE, DPoP, and token exchange automatically. Flow 1 (email
`login_hint`) remains hand-rolled. The default client metadata example
has been flipped from `"token_endpoint_auth_method": "none"` to
`"private_key_jwt"` with `jwks_uri` and `token_endpoint_auth_signing_alg`
fields. A new "Confidential vs public clients" section explains the
trade-offs — notably that public clients force a consent screen on every
login (HYPER-270). New sections cover JWKS key generation, publishing,
and rotation.

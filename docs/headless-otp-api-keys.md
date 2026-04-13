# Headless OTP: Per-Client API Keys

The headless OTP endpoints (`/_internal/otp/send` and `/_internal/otp/verify`) allow client apps to handle passwordless login and signup without OAuth redirects. Each client authenticates via an API key registered in the ePDS database.

## Architecture

```
Client App  →  Client Backend Server  →  ePDS Auth Service  →  PDS Core
(no secrets)   (has API key)             (validates key)        (manages accounts)
```

The API key is a **server-side secret**. It lives in your backend's environment variables, never in a mobile app binary or client-side code.

## Registering a client

Run the CLI script on the machine where your ePDS database lives:

```bash
node scripts/create-api-client.mjs --name "MyApp" --db /path/to/epds.sqlite
```

Options:

| Flag | Description | Default |
|------|-------------|---------|
| `--name <name>` | Client display name (required) | — |
| `--client-id <url>` | client-metadata.json URL for email branding | none |
| `--allowed-origins <list>` | Comma-separated allowed origins | all |
| `--no-signup` | Disable account creation for this client | signup enabled |
| `--rate-limit <n>` | Max requests per hour | 10000 |
| `--db <path>` | Path to ePDS SQLite database | `./data/epds.sqlite` |

The script prints the API key once. Save it immediately — it cannot be retrieved later (only the SHA-256 hash is stored).

## Using the API

Both endpoints require the `x-api-key` header.

### Send OTP

```
POST /_internal/otp/send
x-api-key: <your-api-key>
Content-Type: application/json

{
  "email": "alice@example.com",
  "purpose": "login" | "signup",
  "clientId": "https://myapp.com/client-metadata.json"  // optional, for email branding
}
```

Response: `200 { "success": true }`

The response is always 200 regardless of whether the email exists (anti-enumeration).

### Verify OTP

```
POST /_internal/otp/verify
x-api-key: <your-api-key>
Content-Type: application/json

{
  "email": "alice@example.com",
  "otp": "12345678",
  "purpose": "login" | "signup",
  "handle": "alice"              // required for signup only
}
```

Login response (200):
```json
{ "did": "did:plc:...", "handle": "alice.self.surf", "accessJwt": "...", "refreshJwt": "..." }
```

Signup response (201):
```json
{ "did": "did:plc:...", "handle": "alice.self.surf", "accessJwt": "...", "refreshJwt": "...", "created": true }
```

### Error responses

| Status | Error | Meaning |
|--------|-------|---------|
| 401 | `Unauthorized` | Missing or invalid API key |
| 403 | `OriginNotAllowed` | Request origin not in client's allowed list |
| 403 | `SignupNotAllowed` | Client registered with `--no-signup` |
| 429 | `RateLimitExceeded` | Client exceeded `rate_limit_per_hour` |
| 400 | `InvalidCode` | Wrong OTP code |
| 400 | validation errors | Missing required fields |

## Mobile app integration

For iOS/Android apps, the flow is:

1. User enters email in the app
2. App calls **your backend** with the email
3. Your backend calls `/_internal/otp/send` with the API key
4. User receives OTP email, enters code in the app
5. App sends code to your backend
6. Your backend calls `/_internal/otp/verify` with the API key
7. Backend returns `accessJwt` + `refreshJwt` to the app
8. App uses those tokens for AT Protocol API calls

The API key never leaves your backend. The mobile app only knows the URL of your backend server.

## Revoking a client

There is no CLI for revocation yet. Update the database directly:

```sql
UPDATE api_clients SET revoked_at = unixepoch() * 1000 WHERE name = 'MyApp';
```

Revocation is instant — the next request with that key will get 401.

## Security notes

- API keys are 32 random bytes (64 hex chars), stored as SHA-256 hashes
- Per-client rate limiting (default 10,000 requests/hour) prevents abuse
- `allowed_origins` restricts which browser origins can use a key (server-to-server calls bypass this since they don't send an Origin header)
- The ePDS auth service mints invite codes internally using `PDS_ADMIN_PASSWORD` — clients never need or see the admin password
- `can_signup` controls whether a client can create new accounts
- All auth failures are logged with the requester's IP address

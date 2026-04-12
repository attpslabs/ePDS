---
'ePDS': minor
---

The health endpoint now reports the running ePDS version.

**Affects:** Operators

**Operators:** the `/health` endpoint on both pds-core and auth-service now includes a `version` field in its JSON response (e.g. `{ "status": "ok", "service": "epds", "version": "0.2.2+f37823ee" }`). In Docker and Railway deployments the version is automatically set to `<package.json version>+<8-char commit SHA>` at build time. In local dev it falls back to the root `package.json` version (e.g. `0.2.2`). To override, set the `EPDS_VERSION` environment variable to any string. The demo frontend also displays the version in its page footer.

Docker Compose users should now build with `pnpm docker:build` instead of `docker compose build` directly — the wrapper stamps the version before building, and the build will fail if the version stamp is missing.

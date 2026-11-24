# auth

Accounts, sessions, passkeys and share tokens.

| File | What it owns |
| --- | --- |
| `authService.ts` | accounts, password login (async scrypt), session tokens, share-token issue/verify, revocation |
| `passkeyService.ts` | WebAuthn registration and sign-in; only enabled once `PHOTRIX_RP_ORIGIN` is a public origin |
| `loginThrottle.ts` | a global cap on hashes in flight plus a failure budget per client IP |
| `ipLocation.ts` | offline classification of a session's IP: local network, internet, this server |
| `ipGeolocation.ts` | best-effort place name for an internet session; failure just shows "Internet" |

- This module owns its own tables (declared in `indexDatabase/tables.ts`) and
  is handed the SQLite connection by `main.ts`; nothing else queries them.
- Memory answers every request and the database is what it is rebuilt from.
  A new credential is usable at once and persisted in the background; a
  revocation is persisted **first** and only then applied, so a restart can
  never revive it.
- The auth gate itself is in `createServer.ts`; the handlers are
  `requestHandlers/authRequestHandler.ts` and `accountRequestHandler.ts`.
- With neither `PHOTRIX_ACCOUNTS` nor `AUTH_PASSWORD` set, auth is off
  (`isAuthEnabled`; local development only).

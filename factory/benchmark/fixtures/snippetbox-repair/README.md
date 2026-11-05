# SnippetBox

A small shared-notes SaaS. Users register, log in, and keep their own notes.

## API

| Method | Path             | Purpose                              |
|--------|------------------|--------------------------------------|
| GET    | `/api/health`    | Readiness check                      |
| POST   | `/api/auth/register` | Create an account and issue a token  |
| POST   | `/api/auth/login`    | Authenticate and issue a token       |
| POST   | `/api/notes`     | Create a note for the authenticated user |
| GET    | `/api/notes`     | List only the authenticated user's notes |
| GET    | `/api/notes/:id` | Fetch one of the authenticated user's notes |

## Current state

- `GET /api/health` is implemented and returns `200 {"ok":true}`.
- `server/store.js` provides a JSON-file-backed store (`users`, `notes`,
  `tokens` arrays) via `SNIPPETBOX_STORE` (default `data/notes.json`).
- The authentication helpers in `server/auth.js` are **stubs** (`issueToken`
  and `lookupToken` return `null`) and the note routes delegate to
  `server/notes.js`, which does **not exist yet**.
- `public/app.js` is a stub: the page renders but is not wired to the API.

## Task (benchmark)

Implement the missing pieces so the full flow works end to end:

1. Turn `server/notes.js` into a real module exporting per-user note helpers
   backed by the store.
2. Implement `issueToken` / `lookupToken` in `server/auth.js` and complete the
   register/login/notes routes in `server/app.js`.
3. Wire `public/app.js` to log in and list/create notes.

## Verification

```text
node --test test/
```
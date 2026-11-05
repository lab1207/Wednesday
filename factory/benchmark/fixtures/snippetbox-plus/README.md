# SnippetBox-Plus

A small shared-notes SaaS with search and delete. Users register, log in,
keep their own notes, search them, and delete them.

## API

| Method | Path             | Purpose                              |
|--------|------------------|--------------------------------------|
| GET    | `/api/health`    | Readiness check                      |
| POST   | `/api/auth/register` | Create an account and issue a token  |
| POST   | `/api/auth/login`    | Authenticate and issue a token       |
| POST   | `/api/notes`     | Create a note for the authenticated user |
| GET    | `/api/notes`     | List only the authenticated user's notes |
| GET    | `/api/notes?search=q` | Substring-search the user's notes   |
| GET    | `/api/notes/:id` | Fetch one of the authenticated user's notes |
| DELETE | `/api/notes/:id` | Delete one of the authenticated user's notes |

## Current state

- `GET /api/health` is implemented and returns `200 {"ok":true}`.
- `server/store.js` provides a JSON-file-backed store (`users`, `notes`,
  `tokens` arrays) via `SNIPPETBOX_STORE` (default `data/notes.json`).
- The authentication helpers in `server/auth.js` are **stubs** (`issueToken`
  and `lookupToken` return `null`).
- `server/notes.js` exists but is **buggy**: `listNotes` leaks across users,
  `getNote` never matches, `createNote` mints colliding ids, `searchNotes`
  ignores the query, `deleteNote` reports success without deleting.
- `public/app.js` is a stub: the page renders but is not wired to the API.

## Task (benchmark)

Fix and complete the implementation so the full flow works end to end:

1. Fix all five `server/notes.js` defects (isolation, id match, unique ids,
   real substring search, real delete with false on missing/foreign).
2. Implement `issueToken` / `lookupToken` in `server/auth.js`.
3. Wire `public/app.js` to log in and list/create notes.

## Verification

```text
node --test test/
```

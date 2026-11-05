# SnippetBox — captured failure session (LOGS.md)

> These logs were captured from the running app BEFORE any fix. They are
> the primary diagnosis source: read them first, find the root causes in
> `server/`, fix the code, keep the API shapes. Do not modify this file.

## Boot

```text
$ node server/app.js
SnippetBox listening on http://127.0.0.1:4077
```

## Session transcript (failing)

```text
POST /api/auth/register {"username":"ops-ana","password":"secret"}
<- 501 {"error":"registration not implemented"}

POST /api/auth/login {"username":"ops-ana","password":"secret"}
<- 501 {"error":"login not implemented"}
```

> Auth is stubbed: `server/auth.js` `issueToken`/`lookupToken` return
> `null`, so every register/login answers 501 and no token can exist.

```text
# with auth bypassed at the notes layer for diagnosis:
listNotes(data, "ops-bob")  -> 2 notes, owners ["ops-ana", "ops-ana"]
```

> `listNotes` ignores its username argument and returns the whole store —
> one user sees another user's notes. Suspect: `server/notes.js`.

```text
getNote(data, "0", "ops-ana") -> null   (note "0" exists, owned by ops-ana)
GET /api/notes/0 -> 404 {"error":"note not found"}
```

> Fetch-by-id never matches even for the owning user. The stored id is a
> string but the lookup compares against a number — strict equality can
> never succeed. Suspect: `server/notes.js` id comparison.

```text
createNote -> {"id":"2"} ; delete note "1" ; createNote -> {"id":"2"} AGAIN
GET /api/notes/2 -> ambiguous, two rows share id "2"
```

> Ids are minted from `data.notes.length`, so they collide after any
> delete. Two notes end up sharing one id. Suspect: `server/notes.js`
> id allocation.

## Suspect summary (from the logs, not from reading code)

1. `server/auth.js` — token issue/lookup stubbed (501s).
2. `server/notes.js` — user isolation missing (leak).
3. `server/notes.js` — id comparison type mismatch (404s).
4. `server/notes.js` — id allocation collides after deletes.

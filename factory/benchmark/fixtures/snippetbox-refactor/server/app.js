import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { JsonStore } from './store.js'
import { hashPassword, issueToken, lookupToken } from './auth.js'
import { createNote, listNotes, getNote } from './notes.js'

/**
 * SnippetBox app — WORKING but messy starting point for the
 * snippetbox-refactor variant. Every route works (base probes pass) but:
 * nothing is validated (empty usernames, empty passwords, empty note
 * content are all accepted and stored), auth checks are copy-pasted per
 * route, responses are hand-built JSON strings in five places, and the
 * whole file is one long handle function. The run must restructure AND
 * add 400-level validation with `{ error: string }` bodies without
 * breaking any working behavior.
 */

const STORE_PATH =
  process.env.SNIPPETBOX_STORE ??
  join(process.cwd(), 'data', 'notes.json')

export const store = new JsonStore(STORE_PATH)

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function bearerToken(req) {
  const header = String(req.headers.authorization ?? '')
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1] : null
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://snippetbox.local')
  const path = url.pathname

  if (path === '/api/health' && req.method === 'GET') {
    return json(res, 200, { ok: true })
  }

  if (path === '/api/auth/register' && req.method === 'POST') {
    const body = await readBody(req)
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '')
    const data = await store.load()
    let taken = false
    for (const user of data.users) {
      if (user.username === username) taken = true
    }
    if (taken) {
      const text = JSON.stringify({ error: 'username already taken' })
      res.writeHead(409, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
      return
    }
    data.users.push({ username, passwordHash: hashPassword(password) })
    const token = issueToken(username)
    data.tokens.push(token)
    await store.save(data)
    const text = JSON.stringify({ token, username })
    res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
    return
  }

  if (path === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req)
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '')
    const data = await store.load()
    let found = null
    for (const candidate of data.users) {
      if (candidate.username === username && candidate.passwordHash === hashPassword(password)) {
        found = candidate
      }
    }
    if (!found) {
      const text = JSON.stringify({ error: 'invalid credentials' })
      res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
      return
    }
    const token = issueToken(username)
    data.tokens.push(token)
    await store.save(data)
    const text = JSON.stringify({ token, username })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
    return
  }

  if (path === '/api/notes' && req.method === 'POST') {
    const data = await store.load()
    const header = String(req.headers.authorization ?? '')
    const match = /^Bearer\s+(.+)$/i.exec(header)
    const username = lookupToken(data, match ? match[1] : '')
    if (!username) {
      const text = JSON.stringify({ error: 'invalid or missing token' })
      res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
      return
    }
    const body = await readBody(req)
    const note = await createNote(data, username, String(body.content ?? ''))
    await store.save(data)
    const text = JSON.stringify(note)
    res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
    return
  }

  if (path === '/api/notes' && req.method === 'GET') {
    const data = await store.load()
    const header = String(req.headers.authorization ?? '')
    const match = /^Bearer\s+(.+)$/i.exec(header)
    const username = lookupToken(data, match ? match[1] : '')
    if (!username) {
      const text = JSON.stringify({ error: 'invalid or missing token' })
      res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
      return
    }
    const notes = listNotes(data, username)
    const text = JSON.stringify(notes)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
    return
  }

  const noteMatch = /^\/api\/notes\/([^/]+)$/.exec(path)
  if (noteMatch && req.method === 'GET') {
    const data = await store.load()
    const header = String(req.headers.authorization ?? '')
    const match = /^Bearer\s+(.+)$/i.exec(header)
    const username = lookupToken(data, match ? match[1] : '')
    if (!username) {
      const text = JSON.stringify({ error: 'invalid or missing token' })
      res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
      return
    }
    const note = getNote(data, noteMatch[1], username)
    if (!note) {
      const text = JSON.stringify({ error: 'note not found' })
      res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
      return
    }
    const text = JSON.stringify(note)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
    return
  }

  return json(res, 404, { error: 'not found' })
}

export const server = createServer(handle)

export function start(port = 0) {
  return new Promise(resolve => {
    server.listen(port, () => resolve(server.address().port))
  })
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.PORT ?? 4077)
  void start(port).then(actual => {
    console.log(`SnippetBox listening on http://127.0.0.1:${actual}`)
  })
}

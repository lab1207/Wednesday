import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { JsonStore } from './store.js'
import { hashPassword, issueToken, lookupToken } from './auth.js'
import { createNote, listNotes, getNote, searchNotes, deleteNote } from './notes.js'

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
    if (!username || !password) {
      return json(res, 400, { error: 'username and password are required' })
    }
    const data = await store.load()
    if (data.users.some(user => user.username === username)) {
      return json(res, 409, { error: 'username already taken' })
    }
    data.users.push({ username, passwordHash: hashPassword(password) })
    const token = issueToken(username)
    if (!token) {
      return json(res, 501, { error: 'registration not implemented' })
    }
    data.tokens.push(token)
    await store.save(data)
    return json(res, 201, { token, username })
  }

  if (path === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req)
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '')
    if (!username || !password) {
      return json(res, 400, { error: 'username and password are required' })
    }
    const data = await store.load()
    const user = data.users.find(
      candidate =>
        candidate.username === username &&
        candidate.passwordHash === hashPassword(password),
    )
    if (!user) {
      return json(res, 401, { error: 'invalid credentials' })
    }
    const token = issueToken(username)
    if (!token) {
      return json(res, 501, { error: 'login not implemented' })
    }
    data.tokens.push(token)
    await store.save(data)
    return json(res, 200, { token, username })
  }

  if (path === '/api/notes' && req.method === 'POST') {
    const data = await store.load()
    const username = lookupToken(data, bearerToken(req) ?? '')
    if (!username) return json(res, 401, { error: 'invalid or missing token' })
    const body = await readBody(req)
    if (!body.content) return json(res, 400, { error: 'content is required' })
    const note = await createNote(data, username, String(body.content))
    await store.save(data)
    return json(res, 201, note)
  }

  if (path === '/api/notes' && req.method === 'GET') {
    const data = await store.load()
    const username = lookupToken(data, bearerToken(req) ?? '')
    if (!username) return json(res, 401, { error: 'invalid or missing token' })
    const query = url.searchParams.get('search')
    if (query !== null) {
      return json(res, 200, searchNotes(data, username, query))
    }
    return json(res, 200, listNotes(data, username))
  }

  const noteMatch = /^\/api\/notes\/([^/]+)$/.exec(path)
  if (noteMatch && req.method === 'GET') {
    const data = await store.load()
    const username = lookupToken(data, bearerToken(req) ?? '')
    if (!username) return json(res, 401, { error: 'invalid or missing token' })
    const note = getNote(data, noteMatch[1], username)
    if (!note) return json(res, 404, { error: 'note not found' })
    return json(res, 200, note)
  }

  if (noteMatch && req.method === 'DELETE') {
    const data = await store.load()
    const username = lookupToken(data, bearerToken(req) ?? '')
    if (!username) return json(res, 401, { error: 'invalid or missing token' })
    const removed = deleteNote(data, noteMatch[1], username)
    if (!removed) return json(res, 404, { error: 'note not found' })
    await store.save(data)
    return json(res, 200, { ok: true })
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
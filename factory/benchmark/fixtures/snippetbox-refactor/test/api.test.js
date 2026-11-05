import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let base
let port
let server

function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers ?? {}) }
  return fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers })
}

async function register(username, password) {
  const res = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  return { status: res.status, body: await res.json() }
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'snippetbox-test-'))
  process.env.SNIPPETBOX_STORE = join(base, 'data', 'notes.json')
  const mod = await import('../server/app.js')
  port = await mod.start(0)
  server = mod.server
})

after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve))
  }
  await rm(base, { recursive: true, force: true })
})

test('health returns 200', async () => {
  const res = await api('/api/health')
  assert.equal(res.status, 200)
})

test('register returns 201 and a token', async () => {
  const { status, body } = await register('alice', 'secret')
  assert.equal(status, 201)
  assert.ok(body.token, 'register must issue a token')
  assert.equal(body.username, 'alice')
})

test('login returns 200 and a token', async () => {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'alice', password: 'secret' }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(body.token, 'login must issue a token')
})

test('notes require authentication', async () => {
  const res = await api('/api/notes', {
    method: 'POST',
    body: JSON.stringify({ content: 'x' }),
  })
  assert.equal(res.status, 401)
})

test('create a note and list own notes', async () => {
  const { status, body } = await register('bob', 'pw')
  assert.equal(status, 201, 'bob must be able to register before creating notes')
  const auth = { authorization: `Bearer ${body.token}` }

  const created = await api('/api/notes', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ content: 'hello' }),
  })
  assert.equal(created.status, 201)
  const note = await created.json()
  assert.ok(note.id, 'created note must have an id')
  assert.equal(note.username, 'bob')

  const listed = await (await api('/api/notes', { headers: auth })).json()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].content, 'hello')
  assert.equal(listed[0].username, 'bob')
})

test('a user only sees their own notes', async () => {
  const { status, body } = await register('carol', 'pw')
  assert.equal(status, 201, 'carol must be able to register')
  const listed = await (await api('/api/notes', { headers: { authorization: `Bearer ${body.token}` } })).json()
  assert.deepEqual(listed, [])
})

test('notes are persisted to the store file', async () => {
  const raw = await readFile(join(base, 'data', 'notes.json'), 'utf8')
  const data = JSON.parse(raw)
  assert.ok(data.notes.length >= 1, 'notes must be written to the store')
  assert.equal(data.users.filter(user => user.username === 'bob').length, 1)
})

test('empty note content is rejected with 400', async () => {
  const { body } = await register('refactor-dave', 'pw')
  const res = await api('/api/notes', {
    method: 'POST',
    headers: { authorization: `Bearer ${body.token}` },
    body: JSON.stringify({ content: '' }),
  })
  assert.equal(res.status, 400, 'empty content must be rejected, not stored')
  const payload = await res.json()
  assert.equal(typeof payload.error, 'string', 'error body must carry a string message')
})

test('empty username is rejected with 400', async () => {
  const res = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: '', password: 'pw' }),
  })
  assert.equal(res.status, 400, 'empty username must be rejected, not registered')
})

test('error bodies carry a string message', async () => {
  const res = await api('/api/notes', {
    method: 'POST',
    body: JSON.stringify({ content: 'x' }),
  })
  assert.equal(res.status, 401)
  const payload = await res.json()
  assert.equal(typeof payload.error, 'string', '401 body must carry a string message')
})
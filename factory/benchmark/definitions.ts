import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  BenchmarkDefinition,
} from './types'

export const FIXTURES_DIR = fileURLToPath(
  new URL('./fixtures', import.meta.url),
)

/**
 * SnippetBox — SaaS/web-application benchmark family (roadmap §9).
 *
 * Task, requirements, starting repository and evaluation probes are FIXED so
 * the same run can be repeated across model/provider revisions.
 */
export const SNIPPETBOX: BenchmarkDefinition = {
  id: 'snippetbox',
  title: 'SnippetBox — shared-notes SaaS',
  variant: 'snippetbox-v1',
  fixtureDir: join(FIXTURES_DIR, 'snippetbox'),
  objective:
    'Implement the missing SnippetBox API and frontend: token-based ' +
    'registration and login, per-user note creation, listing and fetch with ' +
    'JSON-file persistence, and wire the login page to the API. The starting ' +
    'repository stubs server/auth.js (issueToken/lookupToken return null), ' +
    'server/app.js imports server/notes.js which does not exist yet, and ' +
    'public/app.js is not wired. Make `node --test` pass.',
  role: 'backend',
  stack: 'node',
  constraints: [
    'Work only inside the assigned workspace.',
    'Keep the app dependency-free (Node built-ins only).',
    'Do not change the test suite under test/.',
    'Create server/notes.js exporting createNote, listNotes and getNote matching the app.js imports.',
    'Keep the existing API shapes: JSON bodies, Bearer-token auth, /api/health unchanged.',
  ],
  acceptanceCriteria: [
    'GET /api/health returns 200',
    'POST /api/auth/register returns 201 with a token',
    'POST /api/auth/login returns 200 with a token',
    'Requests without a token are rejected with 401',
    'POST /api/notes creates a note owned by the authenticated user',
    'GET /api/notes returns only the authenticated user\'s notes',
    'Users never see another user\'s notes',
    'The public page can log in through the API',
    'node --test passes',
  ],
  requiredFiles: [
    'server/auth.js',
    'server/notes.js',
    'public/app.js',
  ],
  testCommands: ['node --test'],
  boot: {
    argv: ['server/app.js'],
    healthPath: '/api/health',
    maxWaitAttempts: 40,
  },
  probes: [
    {
      name: 'health endpoint',
      run: async api => {
        const res = await api.request('GET', '/api/health')
        return { passed: res.status === 200, details: `status ${res.status}` }
      },
    },
    {
      name: 'register returns 201 with a token',
      run: async api => {
        const res = await api.request('POST', '/api/auth/register', {
          body: { username: 'probe-alice', password: 'secret' },
        })
        const body = await res.json()
        const hasToken = body !== null && typeof body === 'object' && 'token' in body
        return {
          passed: res.status === 201 && hasToken,
          details: `status ${res.status}, token present: ${hasToken}`,
        }
      },
    },
    {
      name: 'login returns 200 with a token',
      run: async api => {
        await api.request('POST', '/api/auth/register', {
          body: { username: 'probe-bob', password: 'secret' },
        })
        const res = await api.request('POST', '/api/auth/login', {
          body: { username: 'probe-bob', password: 'secret' },
        })
        const body = await res.json()
        const hasToken = body !== null && typeof body === 'object' && 'token' in body
        return {
          passed: res.status === 200 && hasToken,
          details: `status ${res.status}, token present: ${hasToken}`,
        }
      },
    },
    {
      name: 'notes require authentication',
      run: async api => {
        const res = await api.request('POST', '/api/notes', {
          body: { content: 'x' },
        })
        return {
          passed: res.status === 401,
          details: `status ${res.status} (expected 401)`,
        }
      },
    },
    {
      name: 'create note and list own notes',
      run: async api => {
        const register = await api.request('POST', '/api/auth/register', {
          body: { username: 'probe-carol', password: 'secret' },
        })
        const registerBody = await register.json()
        const token =
          registerBody && typeof registerBody === 'object' && 'token' in registerBody
            ? String(registerBody.token)
            : ''
        const created = await api.request('POST', '/api/notes', {
          token,
          body: { content: 'hello' },
        })
        const createdNote = await created.json()
        const createdOk =
          created.status === 201 &&
          createdNote !== null &&
          typeof createdNote === 'object' &&
          'id' in createdNote
        const listed = await api.request('GET', '/api/notes', { token })
        const listedBody = await listed.json()
        const onlyOwn =
          Array.isArray(listedBody) &&
          listedBody.length === 1 &&
          listedBody[0].content === 'hello' &&
          listedBody[0].username === 'probe-carol'
        return {
          passed: createdOk && listed.status === 200 && onlyOwn,
          details: `create status ${created.status}, list status ${listed.status}, list ${JSON.stringify(listedBody)}`,
        }
      },
    },
    {
      name: 'users never see another user\'s notes',
      run: async api => {
        const register = await api.request('POST', '/api/auth/register', {
          body: { username: 'probe-dave', password: 'secret' },
        })
        const registerBody = await register.json()
        const token =
          registerBody && typeof registerBody === 'object' && 'token' in registerBody
            ? String(registerBody.token)
            : ''
        await api.request('POST', '/api/notes', {
          token,
          body: { content: 'daves-secret' },
        })
        const second = await api.request('POST', '/api/auth/register', {
          body: { username: 'probe-erin', password: 'secret' },
        })
        const secondBody = await second.json()
        const secondToken =
          secondBody && typeof secondBody === 'object' && 'token' in secondBody
            ? String(secondBody.token)
            : ''
        const listed = await api.request('GET', '/api/notes', { token: secondToken })
        const listedBody = await listed.json()
        const isolated = Array.isArray(listedBody) && !listedBody.some(note => note.content === 'daves-secret')
        return {
          passed: isolated,
          details: `erin list ${JSON.stringify(listedBody)}`,
        }
      },
    },
    {
      name: 'public page references a working login flow',
      run: async api => {
        // Frontend wiring is structurally checked (fetch to /api/auth/login);
        // this probe re-checks the login endpoint the page must call.
        const res = await api.request('POST', '/api/auth/login', {
          body: { username: 'probe-bob', password: 'secret' },
        })
        return {
          passed: res.status === 200,
          details: `login status ${res.status}`,
        }
      },
    },
  ],
}

/**
 * SnippetBox-Repair — harder Phase C variant of the same app (roadmap §9).
 *
 * Same probes, same contract, harder starting point: server/notes.js EXISTS
 * but is buggy (listNotes leaks across users, getNote never matches,
 * createNote mints colliding ids) and server/auth.js is still stubbed. The
 * app boots (no ERR_MODULE_NOT_FOUND), so probes execute against live
 * behavior and fail — the run must diagnose + fix two files, not create one.
 * Reuses SNIPPETBOX probes so results stay comparable across variants.
 */
export const SNIPPETBOX_REPAIR: BenchmarkDefinition = {
  id: 'snippetbox-repair',
  title: 'SnippetBox-Repair — fix the buggy notes module',
  variant: 'snippetbox-repair-v1',
  fixtureDir: join(FIXTURES_DIR, 'snippetbox-repair'),
  objective:
    'Fix the SnippetBox implementation so all checks pass: server/notes.js ' +
    'exists but is buggy (listNotes leaks other users\' notes, getNote never ' +
    'matches its id, createNote mints colliding ids), and server/auth.js ' +
    'still stubs issueToken/lookupToken (register/login return 501). Diagnose ' +
    'both files, fix them with Node built-ins only, keep the API shapes, and ' +
    'make `node --test` pass.',
  role: 'backend',
  stack: 'node',
  constraints: [
    'Work only inside the assigned workspace.',
    'Keep the app dependency-free (Node built-ins only).',
    'Do not change the test suite under test/.',
    'Fix server/notes.js in place: createNote, listNotes and getNote must match the app.js imports and isolate users.',
    'Implement issueToken/lookupToken in server/auth.js like the base variant.',
    'Keep the existing API shapes: JSON bodies, Bearer-token auth, /api/health unchanged.',
  ],
  acceptanceCriteria: SNIPPETBOX.acceptanceCriteria,
  requiredFiles: [
    'server/auth.js',
    'server/notes.js',
    'public/app.js',
  ],
  testCommands: ['node --test'],
  boot: {
    argv: ['server/app.js'],
    healthPath: '/api/health',
    maxWaitAttempts: 40,
  },
  probes: SNIPPETBOX.probes,
}

/**
 * SnippetBox-Plus — Relentless R3 harder variant (strictly more work than
 * base AND repair): starts from the repair defects (leak, miss, colliding
 * ids, stubbed auth) PLUS two unimplemented endpoints (search ignores its
 * query, delete reports success without deleting). Reuses the 7 base probes
 * so results stay comparable, and adds 3 endpoint probes. A live run must
 * fix five defects and implement two endpoints - the loop count to green
 * is the relentlessness measure.
 */
export const SNIPPETBOX_PLUS: BenchmarkDefinition = {
  id: 'snippetbox-plus',
  title: 'SnippetBox-Plus — repair plus search and delete',
  variant: 'snippetbox-plus-v1',
  fixtureDir: join(FIXTURES_DIR, 'snippetbox-plus'),
  objective:
    'Fix and complete the SnippetBox-Plus implementation so all checks ' +
    'pass: server/notes.js exists but has five defects (listNotes leaks ' +
    "other users' notes, getNote never matches its id, createNote mints " +
    'colliding ids, searchNotes ignores the query, deleteNote reports ' +
    'success without deleting), and server/auth.js still stubs ' +
    'issueToken/lookupToken (register/login return 501). Diagnose both ' +
    'files, fix them with Node built-ins only, keep the API shapes ' +
    '(GET /api/notes?search= filters own notes, DELETE /api/notes/:id ' +
    'removes an owned note or 404s), and make `node --test` pass.',
  role: 'backend',
  stack: 'node',
  constraints: [
    'Work only inside the assigned workspace.',
    'Keep the app dependency-free (Node built-ins only).',
    'Do not change the test suite under test/.',
    'Fix server/notes.js in place: createNote, listNotes, getNote, searchNotes and deleteNote must match the app.js imports and isolate users.',
    'Implement issueToken/lookupToken in server/auth.js like the base variant.',
    'Keep the existing API shapes: JSON bodies, Bearer-token auth, /api/health unchanged.',
  ],
  acceptanceCriteria: [
    ...SNIPPETBOX.acceptanceCriteria,
    'GET /api/notes?search= returns only matching notes of the authenticated user',
    'DELETE /api/notes/:id removes an owned note (later fetch is 404)',
    'DELETE /api/notes/:id of a missing note returns 404',
  ],
  requiredFiles: [
    'server/auth.js',
    'server/notes.js',
    'public/app.js',
  ],
  testCommands: ['node --test'],
  boot: {
    argv: ['server/app.js'],
    healthPath: '/api/health',
    maxWaitAttempts: 40,
  },
  probes: [
    ...SNIPPETBOX.probes,
    {
      name: 'search filters by query',
      run: async api => {
        const register = await api.request('POST', '/api/auth/register', {
          body: { username: 'probe-finn', password: 'secret' },
        })
        const registerBody = await register.json()
        const token =
          registerBody && typeof registerBody === 'object' && 'token' in registerBody
            ? String(registerBody.token)
            : ''
        for (const content of ['buy milk', 'read book']) {
          await api.request('POST', '/api/notes', {
            token,
            body: { content },
          })
        }
        const res = await api.request('GET', '/api/notes?search=milk', { token })
        const body = await res.json()
        const filtered =
          Array.isArray(body) &&
          body.length === 1 &&
          body[0].content === 'buy milk'
        return {
          passed: res.status === 200 && filtered,
          details: `status ${res.status}, body ${JSON.stringify(body)}`,
        }
      },
    },
    {
      name: 'delete removes an owned note',
      run: async api => {
        const register = await api.request('POST', '/api/auth/register', {
          body: { username: 'probe-gus', password: 'secret' },
        })
        const registerBody = await register.json()
        const token =
          registerBody && typeof registerBody === 'object' && 'token' in registerBody
            ? String(registerBody.token)
            : ''
        const created = await api.request('POST', '/api/notes', {
          token,
          body: { content: 'temporary' },
        })
        const createdBody = await created.json()
        const id =
          createdBody && typeof createdBody === 'object' && 'id' in createdBody
            ? String(createdBody.id)
            : ''
        const removed = await api.request('DELETE', `/api/notes/${id}`, { token })
        const fetched = await api.request('GET', `/api/notes/${id}`, { token })
        return {
          passed: removed.status === 200 && fetched.status === 404,
          details: `delete ${removed.status}, fetch-after ${fetched.status}`,
        }
      },
    },
    {
      name: 'delete of a missing note is 404',
      run: async api => {
        const register = await api.request('POST', '/api/auth/register', {
          body: { username: 'probe-hugo', password: 'secret' },
        })
        const registerBody = await register.json()
        const token =
          registerBody && typeof registerBody === 'object' && 'token' in registerBody
            ? String(registerBody.token)
            : ''
        const res = await api.request('DELETE', '/api/notes/does-not-exist', { token })
        return {
          passed: res.status === 404,
          details: `status ${res.status} (expected 404)`,
        }
      },
    },
  ],
}

/**
 * Sitebuild-Landing — website-build benchmark (user question 2026-09-20:
 * "can our system build a website, and can I open the folder and see it?").
 *
 * Pure static files (relative links, no backend), so the result opens
 * straight from disk with a double-click AND served. The run must write
 * real content + CSS + JS; probes check structure and served bytes, never
 * visual design (stated limit: the Factory cannot judge looks).
 */
export const SITEBUILD_LANDING: BenchmarkDefinition = {
  id: 'sitebuild-landing',
  title: 'Sitebuild-Landing — PedalWorks bike-shop page',
  variant: 'sitebuild-landing-v1',
  fixtureDir: join(FIXTURES_DIR, 'sitebuild-landing'),
  objective:
    'Build the PedalWorks landing page so it works opened from disk and ' +
    'served: index.html with nav (toggle button), #hero, #features with ' +
    'exactly 3 .feature-card elements, #pricing with exactly 3 ' +
    '.price-tier elements, #contact, footer with year slot; link ' +
    'styles.css and include app.js with RELATIVE paths only (no backend, ' +
    'no frameworks, no absolute URLs). styles.css must hold real layout ' +
    'rules (>200 bytes). app.js must implement a nav-toggle handler and ' +
    'set the current year. Keep every file dependency-free and make ' +
    '`node --test` pass.',
  role: 'frontend',
  stack: 'node',
  constraints: [
    'Work only inside the assigned workspace.',
    'Keep the site dependency-free (no frameworks, no CDNs, no build step).',
    'Do not change the test suite under test/.',
    'Relative asset paths only - the page must work from disk (file://).',
    'Exactly 3 .feature-card elements and exactly 3 .price-tier elements.',
  ],
  acceptanceCriteria: [
    'GET / returns 200 with <title>PedalWorks</title>',
    'Hero, features, pricing and contact sections exist',
    'Exactly 3 feature cards and exactly 3 pricing tiers',
    'Stylesheet linked, served, and non-trivial',
    'Script included, served, and wires the nav toggle',
    'node --test passes',
  ],
  requiredFiles: [
    'server/app.js',
    'public/index.html',
    'public/styles.css',
    'public/app.js',
  ],
  testCommands: ['node --test'],
  boot: {
    argv: ['server/app.js'],
    healthPath: '/',
    maxWaitAttempts: 40,
  },
  probes: [
    {
      name: 'home has title and sections',
      run: async api => {
        const res = await api.request('GET', '/')
        const text = await res.text()
        const sections = ['id="hero"', 'id="features"', 'id="pricing"', 'id="contact"']
        const missing = sections.filter(marker => !text.includes(marker))
        return {
          passed:
            res.status === 200 &&
            text.includes('<title>PedalWorks</title>') &&
            missing.length === 0,
          details: `status ${res.status}, missing: ${missing.join(',') || 'none'}`,
        }
      },
    },
    {
      name: 'exactly 3 feature cards and 3 pricing tiers',
      run: async api => {
        const res = await api.request('GET', '/')
        const text = await res.text()
        const cards = text.match(/class="feature-card"/g) ?? []
        const tiers = text.match(/class="price-tier"/g) ?? []
        return {
          passed: cards.length === 3 && tiers.length === 3,
          details: `cards ${cards.length}/3, tiers ${tiers.length}/3`,
        }
      },
    },
    {
      name: 'stylesheet served and non-trivial',
      run: async api => {
        const res = await api.request('GET', '/styles.css')
        const text = await res.text()
        return {
          passed: res.status === 200 && text.length > 200,
          details: `status ${res.status}, bytes ${text.length}`,
        }
      },
    },
    {
      name: 'script served with nav behaviour',
      run: async api => {
        const res = await api.request('GET', '/app.js')
        const text = await res.text()
        return {
          passed: res.status === 200 && text.includes('nav-toggle'),
          details: `status ${res.status}, nav-toggle: ${text.includes('nav-toggle')}`,
        }
      },
    },
  ],
}

/**
 * SnippetBox-Refactor — restructure-without-breaking variant (chat-5 gap
 * shape 1: refactor + error handling, tests stay green).
 *
 * The app WORKS (all 7 base probes pass on the starting code): auth issues
 * tokens, notes isolate per user, ids are unique. What is wrong is the
 * shape — one flat module, copy-pasted auth checks and response blocks,
 * magic values — and the missing layer: NO input validation anywhere
 * (empty usernames register, empty note content is stored). The run must
 * restructure the code AND add 400-level validation with a stable
 * `{ error: string }` body, without breaking any working behavior.
 * Reuses the 7 base probes (must stay green) + 2 validation probes (red).
 */
export const SNIPPETBOX_REFACTOR: BenchmarkDefinition = {
  id: 'snippetbox-refactor',
  title: 'SnippetBox-Refactor — restructure plus validation',
  variant: 'snippetbox-refactor-v1',
  fixtureDir: join(FIXTURES_DIR, 'snippetbox-refactor'),
  objective:
    'Restructure the working SnippetBox implementation and add input ' +
    'validation so all checks pass: the app works but server/app.js is one ' +
    'flat handler with copy-pasted auth checks and hand-built responses, ' +
    'and no layer validates input (empty usernames register with 201, ' +
    'empty note content is stored with 201). Split helpers, remove ' +
    'duplication, reject empty username/password/content with 400 and a ' +
    '`{ error: string }` body, keep every working behavior and API shape, ' +
    'and make `node --test` pass.',
  role: 'backend',
  stack: 'node',
  constraints: [
    'Work only inside the assigned workspace.',
    'Keep the app dependency-free (Node built-ins only).',
    'Do not change the test suite under test/.',
    'Do not break any currently-working behavior: all base endpoints keep their shapes and statuses.',
    'Empty username, empty password and empty note content must answer 400 with a `{ error: string }` body.',
    'Keep the existing API shapes: JSON bodies, Bearer-token auth, /api/health unchanged.',
  ],
  acceptanceCriteria: [
    ...SNIPPETBOX.acceptanceCriteria,
    'POST /api/notes with empty content returns 400 with a string error',
    'POST /api/auth/register with an empty username returns 400',
    'node --test passes',
  ],
  requiredFiles: [
    'server/auth.js',
    'server/notes.js',
    'public/app.js',
  ],
  testCommands: ['node --test'],
  boot: {
    argv: ['server/app.js'],
    healthPath: '/api/health',
    maxWaitAttempts: 40,
  },
  probes: [
    ...SNIPPETBOX.probes,
    {
      name: 'empty note content is 400 with a string error',
      run: async api => {
        const register = await api.request('POST', '/api/auth/register', {
          body: { username: 'probe-ivan', password: 'secret' },
        })
        const registerBody = await register.json()
        const token =
          registerBody && typeof registerBody === 'object' && 'token' in registerBody
            ? String(registerBody.token)
            : ''
        const res = await api.request('POST', '/api/notes', {
          token,
          body: { content: '' },
        })
        const body = await res.json()
        const shaped = body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        return {
          passed: res.status === 400 && shaped,
          details: `status ${res.status}, shaped: ${shaped}`,
        }
      },
    },
    {
      name: 'empty username register is 400',
      run: async api => {
        const res = await api.request('POST', '/api/auth/register', {
          body: { username: '', password: 'secret' },
        })
        return {
          passed: res.status === 400,
          details: `status ${res.status} (expected 400)`,
        }
      },
    },
  ],
}

/**
 * SnippetBox-Logs — debug-from-logs variant (chat-5 gap shape 2: error
 * logs + partial code, find the root cause).
 *
 * Same buggy starting point as snippetbox-repair (stubbed auth, leaking
 * listNotes, mismatched getNote, colliding ids), PLUS `LOGS.md`: a
 * captured failing session whose transcript names all four root causes
 * behaviorally. The objective orders log-first diagnosis; grading stays
 * behavioral (the 7 base probes), like every fixture. Red via the same
 * defects; the run must turn them green.
 */
export const SNIPPETBOX_LOGS: BenchmarkDefinition = {
  id: 'snippetbox-logs',
  title: 'SnippetBox-Logs — diagnose from captured logs',
  variant: 'snippetbox-logs-v1',
  fixtureDir: join(FIXTURES_DIR, 'snippetbox-logs'),
  objective:
    'Diagnose the SnippetBox failure from LOGS.md and fix the code so all ' +
    'checks pass: the captured session shows register/login 501s (auth ' +
    'stubbed), cross-user note leaks, fetch-by-id 404s on owned notes, ' +
    'and colliding ids after deletes. Read LOGS.md first, map each ' +
    'symptom to its root cause in server/, fix with Node built-ins only, ' +
    'keep the API shapes, do not modify LOGS.md, and make `node --test` pass.',
  role: 'backend',
  stack: 'node',
  constraints: [
    'Work only inside the assigned workspace.',
    'Keep the app dependency-free (Node built-ins only).',
    'Do not change the test suite under test/.',
    'Do not modify LOGS.md (it is the diagnosis source, not the patient).',
    'Fix server/notes.js in place and implement issueToken/lookupToken in server/auth.js.',
    'Keep the existing API shapes: JSON bodies, Bearer-token auth, /api/health unchanged.',
  ],
  acceptanceCriteria: SNIPPETBOX.acceptanceCriteria,
  requiredFiles: [
    'server/auth.js',
    'server/notes.js',
    'public/app.js',
  ],
  testCommands: ['node --test'],
  boot: {
    argv: ['server/app.js'],
    healthPath: '/api/health',
    maxWaitAttempts: 40,
  },
  probes: SNIPPETBOX.probes,
}

export const DEFINITIONS: Record<string, BenchmarkDefinition> = {
  snippetbox: SNIPPETBOX,
  'snippetbox-repair': SNIPPETBOX_REPAIR,
  'snippetbox-plus': SNIPPETBOX_PLUS,
  'snippetbox-refactor': SNIPPETBOX_REFACTOR,
  'snippetbox-logs': SNIPPETBOX_LOGS,
  'sitebuild-landing': SITEBUILD_LANDING,
}

export function resolveDefinition(idOrPath: string): BenchmarkDefinition {
  const known = DEFINITIONS[idOrPath]
  if (known !== undefined) return known
  const fromPath = idOrPath.trim()
  if (fromPath.length === 0) throw new Error('Benchmark fixture is required.')
  return {
    ...SNIPPETBOX,
    id: fromPath.split(/[\\/]/).pop() ?? 'custom',
    fixtureDir: fromPath,
  }
}
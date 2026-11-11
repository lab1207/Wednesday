import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  buildChatRequest,
  toWireMessages,
  type ChatMessage,
} from '../model-router/chat-stream.js'
import { makeTask } from './harness.js'

/**
 * IMAGES IN THE COMPOSER, END TO END (2026-11-10, operator report).
 *
 *   "im not able add iamges on contol+v on cammnd tab, or drag and drop
 *    iamges to command tab."
 *
 * The proof is the WIRE: a real OpenAI-compatible server receives a request
 * whose user turn carries an `image_url` part with the operator's picture in
 * it. A unit test of the builder alone would pass while the harness still
 * dropped the image on the floor, which is exactly the shape of the bug
 * that was reported.
 */

/** A real 1x1 PNG, so the bytes under test are a real image. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const work = mkdtempSync(join(tmpdir(), 'wednesday-image-attach-'))
const imagePath = join(work, 'shot.png')
writeFileSync(imagePath, Buffer.from(PNG_BASE64, 'base64'))

// ---------------------------------------------------------------------------
// 1. THE BUILDER: the images ride the NEW turn, and only that turn.
// ---------------------------------------------------------------------------

{
  const history: ChatMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]
  const request = buildChatRequest(
    history,
    'what is in this picture',
    ['data:image/png;base64,AAA'],
  )
  const last = request[request.length - 1]!
  assert.equal(last.role, 'user')
  assert.equal(last.content, 'what is in this picture')
  assert.deepEqual(last.images, ['data:image/png;base64,AAA'])

  // The remembered turns carry NO images: a 4MB picture must not be
  // re-sent on every later turn of the conversation.
  assert.equal(request[1]?.images, undefined)

  // No images: the request is byte-identical to what it always was.
  const plain = buildChatRequest(history, 'hello')
  assert.equal(plain[plain.length - 1]?.images, undefined)

  // The wire shape: a turn with images becomes content PARTS.
  const wire = toWireMessages(request)
  const lastWire = wire[wire.length - 1]!
  assert.ok(Array.isArray(lastWire.content), 'the turn with images is parts')
  assert.deepEqual(lastWire.content[0], {
    type: 'text',
    text: 'what is in this picture',
  })
  assert.deepEqual(lastWire.content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AAA' },
  })

  // A turn WITHOUT images stays a plain string.
  const plainWire = toWireMessages(plain)
  assert.equal(
    typeof plainWire[plainWire.length - 1]!.content,
    'string',
    'an ordinary request body does not change shape',
  )
}

// ---------------------------------------------------------------------------
// 2. THE BUILD PATH: the task carries the images.
// ---------------------------------------------------------------------------

{
  const workspace = join(work, 'workspace')
  writeFileSync(join(work, 'placeholder'), '')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(workspace, { recursive: true })
  const task = await makeTask(
    'build a page like this picture',
    ['node -e "process.exit(0)"'],
    [],
    workspace,
    null,
    ['data:image/png;base64,AAA'],
  )
  assert.deepEqual(
    task.modelRequirements?.images,
    ['data:image/png;base64,AAA'],
    'the task carries the images the operator attached',
  )
}

// ---------------------------------------------------------------------------
// 3. THE GESTURE: Ctrl+V on the composer reads the clipboard itself.
// ---------------------------------------------------------------------------

// A TEXT paste never reaches this branch -- the terminal reads the
// clipboard's text and sends it as a bracketed paste. What arrives as a
// KEY is the case the terminal cannot handle: an IMAGE on the clipboard,
// which most terminals paste as nothing at all. So the app reads the
// clipboard itself, and the picture lands in the pending list.
{
  const { stdin } = await import('node:process')
  const { Screen, initialState } = await import('./screen.js')

  const scr = new Screen({
    columns: 80,
    rows: 24,
    isTTY: true,
    write: () => true,
  } as unknown as NodeJS.WriteStream, 80, 24)
  const st = initialState('WEDNESDAY', 'mode live')
  scr.enter()

  let asked = 0
  const line = scr.readLine(st, [], {
    onPasteRequest: async () => {
      asked += 1
      return {
        attachment: {
          name: 'clipboard.png',
          url: 'data:image/png;base64,BBB',
          mimeType: 'image/png',
          bytes: 1234,
        },
      }
    },
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  stdin.emit('data', '\x16')

  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(asked, 1, 'Ctrl+V asked the clipboard')
  assert.equal(
    st.pendingAttachments?.length,
    1,
    'the image is waiting with the request',
  )
  assert.equal(st.pendingAttachments?.[0]?.name, 'clipboard.png')
  assert.ok(
    st.messages.some(message => /clipboard\.png/.test(message.text)),
    'the operator SEES that the picture is attached',
  )

  // A plain "v" still types: the chord is the only thing that is special.
  stdin.emit('data', 'v')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(st.input, 'v', 'a plain v is still text')

  stdin.emit('data', '\r')
  await new Promise(resolve => setTimeout(resolve, 50))
  await line
  scr.exit()
}

// ---------------------------------------------------------------------------
// 4. THE REAL THING: the operator types a path, the server sees the image.
// ---------------------------------------------------------------------------

const ANSWER = 'IMAGE_ATTACH_OK'
let captured = ''

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += String(chunk) })
  req.on('end', () => {
    captured = raw
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = {
      id: 'image-attach',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fake-chat',
      choices: [] as unknown[],
    }
    for (const piece of ANSWER.split(' ')) {
      res.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: `${piece} ` }, finish_reason: null }],
      })}\n\n`)
    }
    res.write(`data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
server.listen(0, '127.0.0.1')
await new Promise<void>(resolve => { server.once('listening', resolve) })
const port = (server.address() as AddressInfo).port

const entry = join(process.cwd(), 'bin', 'wednesday.js')

/** Run the harness with these lines and return what the server received. */
async function drive(
  lines: string[],
  label: string,
): Promise<{ body: any; output: string; code: number | null }> {
  captured = ''
  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FACTORY_LLM_PROVIDER: 'local',
      LOCAL_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      LOCAL_LLM_MODEL: 'fake-chat',
      LOCAL_LLM_API_KEY: 'local',
      WEDNESDAY_STATE_HOME: join(work, '.wednesday', 'state'),
      WEDNESDAY_NO_STARTUP_HEALTH: '1',
      WEDNESDAY_NO_UPDATE_CHECK: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += String(chunk) })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += String(chunk) })

  for (const line of lines) {
    child.stdin.write(`${line}\n`)
    await new Promise(resolve => setTimeout(resolve, 1200))
  }
  child.stdin.write('/exit\n')
  child.stdin.end()

  const timer = setTimeout(() => { child.kill('SIGKILL') }, 60_000)
  const code = await new Promise<number | null>(resolve => {
    child.once('close', value => resolve(value))
  })
  clearTimeout(timer)

  const output = `${stdout}\n${stderr}`
  if (!output.includes(ANSWER)) {
    console.log(`--- stdout (${label}) ---`)
    console.log(stdout.slice(-4000))
    console.log(`--- stderr (${label}) ---`)
    console.log(stderr.slice(-4000))
  }
  assert.ok(output.includes(ANSWER), `the harness did not show the model answer (${label})`)
  assert.equal(code, 0, `the harness exited with ${code} (${label})`)
  assert.ok(captured, `the server received a request (${label})`)
  return { body: JSON.parse(captured), output, code }
}

// THE OPERATOR'S GESTURE: the terminal delivers a dropped file as TEXT --
// the path. That is the shape the harness has to understand.
{
  const { body } = await drive(
    [`what colour is the square in this picture ${imagePath}`],
    'dropped path',
  )
  const userTurn = body.messages.find(
    (message: { role: string }) => message.role === 'user',
  )
  assert.ok(userTurn, 'the request has a user turn')
  assert.ok(
    Array.isArray(userTurn.content),
    'the user turn carries content PARTS, because it has an image',
  )
  const parts = userTurn.content as Array<{
    type: string
    text?: string
    image_url?: { url: string }
  }>
  const imagePart = parts.find(part => part.type === 'image_url')
  assert.ok(imagePart, 'the image is on the wire')
  assert.match(
    imagePart!.image_url!.url,
    /^data:image\/png;base64,/,
    'the wire carries the picture as a data URL',
  )
  assert.ok(
    imagePart!.image_url!.url.length > PNG_BASE64.length,
    'the whole picture is there, not a stub',
  )
  const textPart = parts.find(part => part.type === 'text')
  assert.match(
    textPart?.text ?? '',
    /\[image: shot\.png\]/,
    'the prompt names the image instead of the path the model cannot open',
  )
}

// THE OTHER ROUTE: `/attach` takes the file, and the image rides the NEXT
// request. This is the route that survives a terminal that eats Ctrl+V.
{
  const { body, output } = await drive(
    [
      `/attach ${imagePath}`,
      'what colour is the square in this picture',
    ],
    '/attach',
  )
  assert.match(
    output,
    /image attached/i,
    'the operator is told the picture is waiting',
  )
  const userTurn = body.messages.find(
    (message: { role: string }) => message.role === 'user',
  )
  assert.ok(Array.isArray(userTurn?.content), 'the turn carries parts')
  const parts = userTurn!.content as Array<{
    type: string
    image_url?: { url: string }
  }>
  assert.ok(
    parts.some(part => part.type === 'image_url'),
    'the attached image is on the wire',
  )
}

server.close()

console.log(
  'IMAGE ATTACH TEST: PASS (the builder rides the turn, the task carries the images, Ctrl+V asks the clipboard, a dropped path reaches the wire as an image_url part, and /attach does the same for a terminal that eats Ctrl+V)',
)

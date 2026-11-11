import assert from 'node:assert/strict'
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  collectImageAttachments,
  detectImagePaths,
  describeAttachment,
  formatBytes,
  imageMimeType,
  isImagePath,
  loadImageFile,
  MAX_IMAGE_BYTES,
  readClipboardImage,
} from './attachments.js'

/**
 * IMAGES IN THE COMPOSER (2026-11-10, operator report).
 *
 *   "im not able add iamges on contol+v on cammnd tab, or drag and drop
 *    iamges to command tab."
 *
 * A terminal delivers a dropped file as TEXT (the path), and most
 * terminals eat Ctrl+V and paste the clipboard's text. These tests pin the
 * two halves of the fix: the path is FOUND in whatever the operator typed,
 * and the file behind it is LOADED into something the model can actually
 * look at.
 */

/** A real 1x1 PNG, so the bytes under test are a real image. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const dir = mkdtempSync(join(tmpdir(), 'wednesday-attachments-'))

/** A real image file in the temp dir. */
function imageFile(name: string, bytes = Buffer.from(PNG_BASE64, 'base64')): string {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

// ---------------------------------------------------------------------------
// 1. THE PATH IS FOUND -- in every shape a terminal delivers one.
// ---------------------------------------------------------------------------

// A Windows path, dropped from Explorer.
{
  const paths = detectImagePaths(
    'look at C:\\Users\\me\\Pictures\\shot.png please',
  )
  assert.deepEqual(paths, ['C:\\Users\\me\\Pictures\\shot.png'])
}

// A Windows path WITH SPACES. The terminal quotes it; the quotes are not
// part of the path.
{
  const paths = detectImagePaths(
    'see "C:\\Users\\me\\My Pictures\\shot.png" now',
  )
  assert.deepEqual(paths, ['C:\\Users\\me\\My Pictures\\shot.png'])
}

// A POSIX path.
{
  const paths = detectImagePaths(
    'check /home/me/photos/diagram.png out',
  )
  assert.deepEqual(paths, ['/home/me/photos/diagram.png'])
}

// A UNC share.
{
  const paths = detectImagePaths(
    'open \\\\server\\share\\logo.png',
  )
  assert.deepEqual(paths, ['\\\\server\\share\\logo.png'])
}

// A URL is NOT a local file. The `/logo.png` inside it must never be
// mistaken for a path, or every chat with an image link would try to read
// the operator's disk.
{
  assert.deepEqual(
    detectImagePaths('see https://example.com/logo.png please'),
    [],
  )
}

// A path that is not an image is not an image.
{
  assert.deepEqual(
    detectImagePaths('open C:\\Users\\me\\notes.txt'),
    [],
  )
}

// The extension check agrees with the detector.
{
  assert.equal(isImagePath('a/b/c.PNG'), true)
  assert.equal(isImagePath('a/b/c.jpeg'), true)
  assert.equal(isImagePath('a/b/c.webp'), true)
  assert.equal(isImagePath('a/b/c.txt'), false)
  assert.equal(imageMimeType('a/b/c.JPEG'), 'image/jpeg')
  assert.equal(imageMimeType('a/b/c.txt'), '')
}

// ---------------------------------------------------------------------------
// 2. THE FILE IS LOADED -- and the text says what the model will see.
// ---------------------------------------------------------------------------

{
  const path = imageFile('shot.png')
  const result = await collectImageAttachments(
    `make this look like the attached design ${path}`,
  )

  assert.equal(result.attachments.length, 1, 'the image rides along')
  const attachment = result.attachments[0]!
  assert.equal(attachment.name, 'shot.png')
  assert.equal(attachment.mimeType, 'image/png')
  assert.ok(attachment.bytes > 0, 'the size is known')
  assert.match(
    attachment.url,
    /^data:image\/png;base64,/,
    'the wire form is a data URL',
  )
  assert.deepEqual(result.errors, [], 'nothing went wrong')

  // The path is REPLACED, not kept: the model cannot open the operator's
  // disk, so a path in the prompt reads as a file the model was asked to
  // find instead of a picture it was shown.
  assert.ok(
    !result.text.includes(path),
    'the raw path is gone from the text',
  )
  assert.match(
    result.text,
    /\[image: shot\.png\]/,
    'the text names the image that was attached',
  )
  assert.match(
    result.text,
    /make this look like the attached design/,
    'the operator\'s own words survive',
  )
}

// A path with spaces, quoted the way a terminal delivers it.
{
  const path = imageFile('a file with spaces.png')
  const result = await collectImageAttachments(`look at "${path}"`)
  assert.equal(result.attachments.length, 1, 'a path with spaces is found')
  assert.equal(result.attachments[0]!.name, 'a file with spaces.png')
}

// The same file twice is ONE attachment.
{
  const path = imageFile('twice.png')
  const result = await collectImageAttachments(
    `${path} and again ${path}`,
  )
  assert.equal(result.attachments.length, 1, 'one file, one attachment')
}

// A file that is not there is REPORTED, never silently dropped.
{
  const missing = join(dir, 'not-here.png')
  const result = await collectImageAttachments(`look at ${missing}`)
  assert.equal(result.attachments.length, 0)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0]!, /no such file/)
  assert.ok(
    !result.text.includes(missing),
    'the dead path does not stay in the prompt',
  )
}

// A file that is too big is REPORTED with its size. A silent drop here is
// how the feature gets called broken.
{
  const big = join(dir, 'huge.png')
  writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 1))
  const result = await collectImageAttachments(`look at ${big}`)
  assert.equal(result.attachments.length, 0)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0]!, /too large/i)
  assert.match(result.errors[0]!, /4\.0 MB/)
  // The file is not left behind by the test run.
  unlinkSync(big)
}

// A directory is not an image.
{
  const result = await collectImageAttachments(`look at ${dir}`)
  assert.equal(result.attachments.length, 0)
}

// A text file is TEXT, not an image: the path stays in the prompt and
// nothing is reported, because the operator never asked for an image.
{
  const path = join(dir, 'notes.txt')
  writeFileSync(path, 'hello')
  const result = await collectImageAttachments(`look at ${path}`)
  assert.equal(result.attachments.length, 0)
  assert.deepEqual(result.errors, [], 'a text file is not a failed image')
  assert.match(result.text, /notes\.txt/, 'the path is still just text')
}

// A text with no image is untouched.
{
  const result = await collectImageAttachments('just a sentence')
  assert.equal(result.attachments.length, 0)
  assert.equal(result.text, 'just a sentence')
  assert.deepEqual(result.errors, [])
}

// ---------------------------------------------------------------------------
// 3. THE SINGLE FILE API.
// ---------------------------------------------------------------------------

{
  const path = imageFile('single.gif')
  const attachment = await loadImageFile(path)
  assert.ok(attachment, 'the file loads')
  assert.equal(attachment!.mimeType, 'image/gif')
  assert.equal(
    await loadImageFile(join(dir, 'missing.gif')),
    null,
    'a missing file is null, not a throw',
  )
}

// ---------------------------------------------------------------------------
// 4. THE RECEIPT THE OPERATOR READS.
// ---------------------------------------------------------------------------

{
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(4 * 1024 * 1024), '4.0 MB')
  const path = imageFile('receipt.png')
  const attachment = (await loadImageFile(path))!
  assert.match(
    describeAttachment(attachment),
    /^image attached · receipt\.png \(/,
    'the receipt names the image and its size',
  )
}

// ---------------------------------------------------------------------------
// 5. THE CLIPBOARD.
// ---------------------------------------------------------------------------

// The clipboard read is WINDOWS-ONLY, and on every other platform it is a
// quiet no-op: the app must not fail a session because a clipboard API is
// missing. The test runs wherever it runs.
{
  const image = await readClipboardImage()
  if (process.platform === 'win32') {
    // The value is whatever the operator's clipboard holds; the contract
    // under test is that the call ANSWERS and never throws.
    assert.ok(
      image === null || typeof image.url === 'string',
      'the clipboard read answers with an attachment or null',
    )
  } else {
    assert.equal(image, null, 'no clipboard image off Windows')
  }
}

console.log(
  'ATTACHMENTS TEST: PASS (paths found in every terminal shape, a URL is not a path, the file loads into a data URL, the path is replaced in the prompt, missing/oversized files are reported, the clipboard answers)',
)

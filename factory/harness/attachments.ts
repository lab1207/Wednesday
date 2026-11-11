/**
 * IMAGES IN THE COMPOSER (2026-11-10, operator report).
 *
 *   "im not able add iamges on contol+v on cammnd tab, or drag and drop
 *    iamges to command tab."
 *
 * WHY THIS MODULE EXISTS:
 *
 * A terminal has no "attach a file" gesture. What it HAS is:
 *
 *  1. A DRAG AND DROP, which the terminal delivers as TEXT: the file path.
 *     Windows Terminal, Explorer and most modern terminals put the path of
 *     the dropped file into the input line, quoted when it contains spaces.
 *     This is the cross-platform route, and it is the one that always
 *     works -- because it never needs the app to touch the clipboard.
 *
 *  2. A Ctrl+V, which the terminal ALSO usually intercepts: it pastes the
 *     clipboard's TEXT. When the clipboard holds an IMAGE (a screenshot, a
 *     copied picture) there is no text to paste, so most terminals paste
 *     nothing at all and the operator sees a keypress that did nothing.
 *     When the terminal DOES forward the key (or the clipboard holds a
 *     copied FILE, whose clipboard text is the path), the app reads the
 *     clipboard itself.
 *
 * So this module owns THREE things:
 *
 *  - DETECT a path that names an image, anywhere in the operator's text.
 *  - LOAD it: bytes in, a data URL out, because that is what the
 *    OpenAI-compatible wire format wants.
 *  - READ the clipboard's image on Windows, for the Ctrl+V case.
 *
 * WHY A DATA URL AND NOT THE PATH: the model never sees the operator's
 * filesystem. A data URL is the one form that travels through every
 * OpenAI-compatible endpoint (OpenRouter, NVIDIA, a local Colab tunnel)
 * without the server needing to read the operator's disk.
 *
 * WHY THE LIMITS ARE HERE AND NOT IN THE UI: a data URL is 4/3 of the file
 * size, and the file travels inside EVERY request body. An unbounded
 * attachment would turn a 40MB screenshot into a 55MB request and the run
 * would die on a socket, not on a model.
 */
import { readFile, stat, unlink } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
/** One image on its way to the model. */
export interface ImageAttachment {
  /** The name the operator recognizes (the file name, or the URL's last part). */
  name: string
  /** Where it came from, when it came from a local file. */
  path?: string
  /**
   * The wire form: a `data:` URL for a local file, the URL itself for a
   * remote one. This is what goes into `image_url.url`.
   */
  url: string
  /** The content type. */
  mimeType: string
  /** How many bytes the file is (0 for a remote URL). */
  bytes: number
}

/** The image types the wire format and the common models agree on. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/**
 * The biggest image that will be attached.
 *
 * 4 MB is a deliberate line: the data URL is ~5.4 MB of body, which every
 * endpoint accepts, and a screenshot is almost always under it. A 40MB
 * screenshot is refused with a message that says WHY -- a silent drop would
 * look like the feature does not work.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** How many images ride one request. */
export const MAX_IMAGE_ATTACHMENTS = 6

/** Is this path an image we can attach? */
export function isImagePath(path: string): boolean {
  return MIME_BY_EXT[extname(path).toLowerCase()] !== undefined
}

/** The content type for an image path (empty string when it is not an image). */
export function imageMimeType(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? ''
}

/** `1.4 MB` -- the size the operator reads. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * A path that names an image.
 *
 * The shape is deliberately narrow:
 *
 *  - It must START at a root: a Windows drive (`C:\`), a UNC share
 *    (`\\server\share`), or a POSIX absolute path (`/home/...`).
 *    A relative path (`shot.png`) is matched too, but only after the
 *    absolute forms, because a relative name is also what a sentence
 *    happens to contain.
 *  - It must END at an image extension.
 *  - It may contain SPACES: the character class allows them, so
 *    `C:\Users\me\My Pictures\shot.png` comes out whole. The match is
 *    LAZY, so it stops at the FIRST image extension -- a path is followed
 *    by prose, not by more path.
 *  - It may not contain a quote, so a QUOTED path is matched without its
 *    quotes and the text keeps them.
 *  - It may not start right after a `:` or a word character, so the
 *    `/logo.png` inside `https://example.com/logo.png` is never mistaken
 *    for a local file.
 */
const IMAGE_PATH_RE =
  /(?<![:\w/])((?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n"'<>|*?]*?\.(?:png|jpe?g|gif|webp|bmp))(?![A-Za-z0-9])/gi

interface PathMatch {
  path: string
  index: number
  length: number
}

/** Every image path in the text, with where it sits. */
function findImagePaths(text: string): PathMatch[] {
  const matches: PathMatch[] = []
  IMAGE_PATH_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMAGE_PATH_RE.exec(text)) !== null) {
    matches.push({
      path: match[1]!,
      index: match.index,
      length: match[0].length,
    })
  }
  return matches
}

/** The image paths in the text, as plain strings. */
export function detectImagePaths(text: string): string[] {
  return findImagePaths(text).map(match => match.path)
}

/** Does this file exist? (A directory is not an image.) */
async function isReadableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * The file this candidate really names.
 *
 * The regex can over-capture when the prose before an image name ends in
 * another extension: `C:\a\report.pdf and shot.png` comes out as one
 * candidate, and that file does not exist. When the whole candidate is not
 * a file, its LAST space-separated token is tried on its own -- `shot.png`
 * is the name the operator typed, and it is usually relative to the
 * working directory.
 */
async function resolveExisting(candidate: string): Promise<string | null> {
  const direct = resolve(candidate)
  if (await isReadableFile(direct)) return direct
  const parts = candidate.split(/\s+/)
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const token = parts[index]!
    if (!token || !isImagePath(token)) continue
    const absolute = resolve(token)
    if (await isReadableFile(absolute)) return absolute
  }
  return null
}

/**
 * Read an image file into an attachment.
 *
 * Returns null when the file is not there or is not an image. THROWS when
 * the file is there but too big: the operator must be told the size is the
 * problem, because "nothing happened" is how a feature gets called broken.
 */
export async function loadImageFile(
  path: string,
): Promise<ImageAttachment | null> {
  const absolute = resolve(path)
  if (!isImagePath(absolute)) return null
  let size = 0
  try {
    const info = await stat(absolute)
    if (!info.isFile()) return null
    size = info.size
  } catch {
    return null
  }
  if (size <= 0) return null
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(
      `image too large: ${basename(absolute)} is ${formatBytes(size)} (the limit is ${formatBytes(MAX_IMAGE_BYTES)})`,
    )
  }
  const bytes = await readFile(absolute)
  const mimeType = imageMimeType(absolute)
  return {
    name: basename(absolute),
    path: absolute,
    url: `data:${mimeType};base64,${bytes.toString('base64')}`,
    mimeType,
    bytes: size,
  }
}

/** What the collector found, and what it could not use. */
export interface CollectedAttachments {
  /** The images that will ride the request. */
  attachments: ImageAttachment[]
  /**
   * The text with every attached path replaced by `[image: name]`.
   *
   * The path is replaced rather than kept because the model cannot open it:
   * what it CAN do is look at the image and read the name. A request that
   * says "C:\Users\me\Pictures\shot.png" with the picture attached reads as
   * a path the model was asked to find, not as a picture it was shown.
   */
  text: string
  /** Why an image was not attached (never silent). */
  errors: string[]
}

/**
 * Every image the operator's text points at, loaded.
 *
 * The text is returned with the paths replaced, so the caller can use it as
 * the request without knowing anything about attachments.
 */
export async function collectImageAttachments(
  text: string,
): Promise<CollectedAttachments> {
  const errors: string[] = []
  const seen = new Set<string>()

  // PASS ONE: resolve and load, in the order the paths appear. The order
  // matters for the cap: when there are more images than the cap allows,
  // the FIRST ones are the ones that ride along.
  interface Resolved {
    match: PathMatch
    attachment: ImageAttachment | null
  }
  const resolved: Resolved[] = []

  for (const match of findImagePaths(text)) {
    const absolute = await resolveExisting(match.path)
    if (!absolute) {
      errors.push(
        `image not attached: ${match.path} (no such file)`,
      )
      resolved.push({ match, attachment: null })
      continue
    }
    if (seen.has(absolute)) {
      // The same file twice (the operator dropped it and pasted it too):
      // one attachment, and the second mention goes too.
      resolved.push({ match, attachment: null })
      continue
    }
    seen.add(absolute)
    let attachment: ImageAttachment | null = null
    try {
      attachment = await loadImageFile(absolute)
    } catch (error) {
      // The file IS there and it IS an image -- it is just too big. The
      // reason is already named; saying "not a readable image" on top of it
      // would be two reasons for one problem.
      errors.push(
        error instanceof Error ? error.message : String(error),
      )
      resolved.push({ match, attachment: null })
      continue
    }
    if (!attachment) {
      errors.push(
        `image not attached: ${absolute} (not a readable image)`,
      )
    }
    resolved.push({ match, attachment })
  }

  const attachable = resolved.filter(item => item.attachment !== null)
  const attachments = attachable
    .slice(0, MAX_IMAGE_ATTACHMENTS)
    .map(item => item.attachment!)
  if (attachable.length > MAX_IMAGE_ATTACHMENTS) {
    errors.push(
      `only the first ${MAX_IMAGE_ATTACHMENTS} images were attached (${attachable.length} were given)`,
    )
  }
  const allowed = new Set(
    attachments.map(attachment => attachment.path ?? attachment.url),
  )

  // PASS TWO: rebuild the text from the END, so an earlier replacement
  // cannot move the offsets of a later one.
  let rebuilt = text
  for (const item of resolved.slice().reverse()) {
    const { match, attachment } = item
    const replacement =
      attachment && allowed.has(attachment.path ?? attachment.url)
        ? `[image: ${attachment.name}]`
        : ''
    rebuilt =
      rebuilt.slice(0, match.index) +
      replacement +
      rebuilt.slice(match.index + match.length)
  }

  return {
    attachments,
    text: rebuilt,
    errors,
  }
}

/**
 * The Windows clipboard's image, read straight from the OS.
 *
 * WHY POWERSHELL: .NET is the only clipboard API on a Windows box that
 * needs no native module, and `powershell.exe` is on every Windows
 * install. The image is written to a temp PNG, read as bytes, and the
 * temp file is deleted.
 *
 * The subprocess is `powershell.exe` and NOT a shell built-in: the same
 * lesson as npm-command.ts -- on Windows, `spawnSync('npm', …)` fails with
 * ENOENT because npm is a `.cmd` shim, and `powershell.exe` is a real
 * executable, so it resolves through PATH.
 *
 * Returns null when the clipboard holds no image (the quiet case: the
 * operator pasted TEXT, or the terminal already handled the paste).
 */
export async function readClipboardImage(): Promise<ImageAttachment | null> {
  if (process.platform !== 'win32') return null

  const shell = powershellPath()
  if (!shell) return null

  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($img -eq $null) { exit 3 }',
    '$path = Join-Path ([System.IO.Path]::GetTempPath()) ("wednesday-clip-" + [System.Guid]::NewGuid().ToString("N") + ".png")',
    '$img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$img.Dispose()',
    'Write-Output $path',
  ].join('\n')

  // ASYNCHRONOUS ON PURPOSE: a clipboard read starts a PowerShell process,
  // and PowerShell's own start-up is a few hundred milliseconds. Done
  // synchronously it would FREEZE the terminal for every Ctrl+V -- the
  // screen could not repaint and the composer would look hung. The spawn
  // is async so the loop keeps running while it works.
  const run = await runShell(shell, script).catch(() => null)
  if (!run || run.code !== 0) return null

  const path = run.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .pop()
  if (!path) return null

  try {
    return await loadImageFile(path)
  } finally {
    // The temp file is ours; leaving it behind would fill the temp folder
    // with screenshots nobody asked for.
    await unlink(path).catch(() => undefined)
  }
}

/** One PowerShell run: its exit code and its output. */
async function runShell(
  shell: string,
  script: string,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      shell,
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { windowsHide: true },
    )
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('the clipboard read timed out'))
    }, 15_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout })
    })
  })
}

/** The Windows PowerShell executable, or null when there is none. */
function powershellPath(): string | null {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const absolute = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  return absolute
}

/** The receipt line the operator sees when an image is attached. */
export function describeAttachment(attachment: ImageAttachment): string {
  const size = attachment.bytes > 0 ? ` (${formatBytes(attachment.bytes)})` : ''
  return `image attached · ${attachment.name}${size}`
}

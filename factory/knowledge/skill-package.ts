/**
 * `.skill` PACKAGES — install an operator's skill from a file
 * (2026-11-11, operator ask: external `skills` / `.skill` install).
 *
 * WHAT A `.skill` FILE IS: a ZIP archive holding one skill directory -- a
 * `SKILL.md` with its frontmatter, plus whatever the skill needs beside it
 * (references, examples, templates). It is the same shape as a skill the
 * operator drops into `~/.wednesday/skills/` by hand, so both routes end at
 * the same place.
 *
 * WHY THE ZIP READER IS WRITTEN HERE:
 *
 * The factory ships ONE installable application with a small dependency
 * list, and a ZIP reader is not on it. `node:zlib` is: `inflateRawSync` is
 * the deflate decompressor, and a ZIP's central directory is a documented,
 * fixed-layout index. So the reader below is ~120 lines of buffer arithmetic
 * and no dependency at all.
 *
 * THE GUARDS ARE THE POINT. A package is third-party content that lands on
 * the operator's disk and, after the audit, in the operator's agent prompts:
 *
 *   - A PATH that escapes the target is refused (`../`, an absolute path, a
 *     drive letter). A zip slip is the oldest trick in the book.
 *   - The ENTRY COUNT and the TOTAL SIZE are capped, so a zip bomb cannot
 *     fill the disk.
 *   - Every extracted skill goes through `auditSkillDir` -- the SAME gate
 *     the factory already uses for a skill it did not write. A HIGH finding
 *     (an instruction-override directive, a hidden instruction) REFUSES the
 *     install; a MEDIUM finding installs and is reported.
 *
 * An install never OVERWRITES: a skill already in place is left alone and
 * the operator is told to remove it first. A skill is a thing people edit,
 * and an installer that silently replaces it destroys work.
 */

import { inflateRawSync } from 'node:zlib'
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { auditSkillDir, type SkillAuditResult } from '../verification/skill-audit'

/** One file inside a package. */
export interface PackageEntry {
  /** The path inside the archive (forward slashes). */
  name: string
  /** The bytes. */
  data: Buffer
}

/** The caps a package may not exceed. */
const MAX_ENTRIES = 512
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_FILE_BYTES = 4 * 1024 * 1024

/** ZIP signatures. */
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/**
 * Is this archive path safe to write?
 *
 * A path is safe when it stays under the target: no absolute path, no drive
 * letter, no `..` segment, and no empty segment. The check is on the
 * NORMALIZED path, so `a/../../b` is caught as well as `../b`.
 */
export function isSafePackagePath(name: string): boolean {
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(normalized)) return false
  const segments = normalized.split('/')
  if (segments.some(segment => segment === '..' || segment === '')) {
    // A trailing slash marks a DIRECTORY entry, which is allowed.
    if (normalized.endsWith('/') && segments.slice(0, -1).every(s => s !== '..' && s !== '')) {
      return true
    }
    return false
  }
  return true
}

/**
 * Read a ZIP archive's entries.
 *
 * Only the two methods that matter are supported: STORED (0) and DEFLATE
 * (8). A ZIP64 archive is refused by name rather than half-read: its sizes
 * live in an extra field, and a wrong size is a wrong file.
 *
 * @param bytes - the whole archive.
 * @returns the files, in the archive's order.
 * @throws when the archive is not a ZIP, uses an unsupported method, or
 * breaks a cap.
 */
export function readZipEntries(bytes: Buffer): PackageEntry[] {
  if (bytes.length < 22) throw new Error('not a ZIP archive (too small)')

  // The End Of Central Directory is at the END, but a trailing comment can
  // push it back by up to 64KB. Scan backwards for its signature.
  let eocd = -1
  const lowest = Math.max(0, bytes.length - 22 - 0xffff)
  for (let offset = bytes.length - 22; offset >= lowest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-directory record)')

  const totalEntries = bytes.readUInt16LE(eocd + 10)
  const centralOffset = bytes.readUInt32LE(eocd + 16)
  if (totalEntries > MAX_ENTRIES) {
    throw new Error(`the package holds ${totalEntries} files (the limit is ${MAX_ENTRIES})`)
  }
  if (centralOffset === 0xffffffff) throw new Error('ZIP64 packages are not supported')

  const entries: PackageEntry[] = []
  let cursor = centralOffset
  let totalBytes = 0

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > bytes.length) throw new Error('the package index is truncated')
    if (bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('the package index is damaged')
    }
    const method = bytes.readUInt16LE(cursor + 10)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff) {
      throw new Error('ZIP64 packages are not supported')
    }
    if (!isSafePackagePath(name)) {
      throw new Error(`the package tries to write outside its folder: ${name}`)
    }
    // A directory entry carries no data.
    if (name.endsWith('/')) continue
    if (uncompressedSize > MAX_FILE_BYTES) {
      throw new Error(
        `${name} is ${Math.round(uncompressedSize / 1024)} KB (the limit is ${Math.round(MAX_FILE_BYTES / 1024)} KB)`,
      )
    }
    totalBytes += uncompressedSize
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(
        `the package unpacks to more than ${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MB`,
      )
    }

    // The LOCAL header repeats the name and extra lengths, and they are the
    // ones that decide where the data starts.
    if (localOffset + 30 > bytes.length) throw new Error(`${name} points outside the archive`)
    if (bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`${name} has a damaged local header`)
    }
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > bytes.length) throw new Error(`${name} is truncated`)

    const raw = bytes.subarray(dataStart, dataEnd)
    let data: Buffer
    if (method === 0) {
      data = Buffer.from(raw)
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw)
      } catch {
        throw new Error(`${name} could not be decompressed`)
      }
    } else {
      throw new Error(`${name} uses an unsupported compression method (${method})`)
    }
    entries.push({ name: name.replace(/\\/g, '/'), data })
  }

  return entries
}

/** The result of an install attempt. */
export interface InstallSkillResult {
  ok: boolean
  /** The installed skill's directory name. */
  name?: string
  /** Where it landed. */
  path?: string
  /** How many files it holds. */
  files?: number
  /** The audit that gated it. */
  audit?: SkillAuditResult
  /** Why it did not install. */
  error?: string
  /** Findings worth showing even when the install succeeded. */
  warnings?: string[]
}

/** A directory name that is safe on every platform. */
export function safeSkillDirectory(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/-+$/, '')
  return cleaned.slice(0, 64)
}

/**
 * Where the skill root is inside an extracted package.
 *
 * A package holds either `SKILL.md` at its root, or one directory that holds
 * it. Both are found by looking for the `SKILL.md`, one level deep.
 */
function findSkillRoot(root: string): string | undefined {
  if (existsSync(join(root, 'SKILL.md'))) return root
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const candidate = join(root, entry)
    try {
      if (statSync(candidate).isDirectory() && existsSync(join(candidate, 'SKILL.md'))) {
        return candidate
      }
    } catch {
      // A directory we cannot read is not a skill root.
    }
  }
  return undefined
}

/** Is this path a directory? (sync, tiny, no import churn) */
function statSyncIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Install a skill from a `.skill` package or a skill directory.
 *
 * @param file - the `.skill` archive or the directory to install.
 * @param home - where skills live (defaults to the operator's skills home).
 * @returns what happened, and the audit that gated it.
 */
export async function installSkillPackage(
  file: string,
  home: string,
): Promise<InstallSkillResult> {
  const source = resolve(file)
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(source)
  } catch {
    return { ok: false, error: `no such file: ${file}` }
  }

  const staging = await mkdtemp(join(tmpdir(), 'wednesday-skill-'))
  try {
    let root: string | undefined
    let files = 0

    if (info.isDirectory()) {
      // A skill directory the operator points at directly.
      root = join(staging, 'skill')
      await cp(source, root, { recursive: true })
      files = countFiles(root)
    } else {
      const bytes = await readFile(source)
      let entries: PackageEntry[]
      try {
        entries = readZipEntries(bytes)
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      if (entries.length === 0) {
        return { ok: false, error: 'the package holds no files' }
      }
      for (const entry of entries) {
        const target = join(staging, ...entry.name.split('/'))
        // Belt and braces: the name was checked, and the resolved path is
        // checked again, because a join that escapes the staging folder is
        // the whole attack.
        if (!resolve(target).startsWith(resolve(staging))) {
          return { ok: false, error: `the package tries to write outside its folder: ${entry.name}` }
        }
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, entry.data)
        files += 1
      }
      root = findSkillRoot(staging)
    }

    if (!root) {
      return { ok: false, error: 'no SKILL.md in the package (a skill needs one)' }
    }

    // THE GATE. The same audit the factory uses for a skill it did not
    // write: a HIGH finding refuses the install.
    const audit = auditSkillDir(root)
    if (audit.verdict === 'FAIL') {
      const high = audit.findings
        .filter(finding => finding.severity === 'HIGH')
        .slice(0, 5)
        .map(finding => `${finding.file}:${finding.line} ${finding.detail}`)
      return {
        ok: false,
        audit,
        error: `the skill was NOT installed: the audit found ${high.length} high-severity finding(s).\n  ${high.join('\n  ')}`,
      }
    }

    const directory = safeSkillDirectory(basename(root))
    if (!directory) {
      return { ok: false, error: 'the skill has no usable name' }
    }
    const target = join(home, directory)
    if (existsSync(target)) {
      return {
        ok: false,
        error: `a skill named "${directory}" is already installed — /skills remove ${directory} first`,
      }
    }
    await mkdir(home, { recursive: true })
    try {
      await rename(root, target)
    } catch {
      // A rename across devices fails; a copy does not.
      await cp(root, target, { recursive: true })
    }

    const warnings = audit.findings
      .filter(finding => finding.severity !== 'LOW')
      .slice(0, 8)
      .map(finding => `${finding.file}:${finding.line} [${finding.severity}] ${finding.detail}`)

    return { ok: true, name: directory, path: target, files, audit, warnings }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** How many files a directory holds (the receipt's number). */
function countFiles(root: string): number {
  let count = 0
  const visit = (current: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry)
      if (statSyncIsDirectory(full)) visit(full)
      else count += 1
    }
  }
  visit(root)
  return count
}

/**
 * Remove an installed skill.
 *
 * Only the operator's own home is touched: a project skill belongs to the
 * repository and is removed with it.
 */
export async function removeInstalledSkill(
  name: string,
  home: string,
): Promise<{ ok: boolean; error?: string }> {
  const directory = safeSkillDirectory(name)
  if (!directory) return { ok: false, error: 'that is not a skill name' }
  const target = join(home, directory)
  if (!existsSync(target)) {
    return { ok: false, error: `no installed skill named "${directory}"` }
  }
  await rm(target, { recursive: true, force: true })
  return { ok: true }
}

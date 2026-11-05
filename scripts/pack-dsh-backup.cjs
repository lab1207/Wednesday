/**
 * dsh backup freshness gate (2026-09-24).
 *
 * Rule: every GitHub safety push must ship alongside a current dsh/
 * Drive backup — but re-packing 1GB every commit is wasteful, so this
 * script packs ONLY when dsh/ changed since the last backup (git HEAD
 * or working-tree status differs from the marker).
 *
 * Usage (agent runs before pushing):
 *   node scripts/pack-dsh-backup.cjs --check-only   # report only
 *   node scripts/pack-dsh-backup.cjs                # pack + verify
 *   node scripts/pack-dsh-backup.cjs --mark-current # record state as backed up (after manual upload)
 *
 * Packing uses the built-in tar (WinRAR silently skips .git).
 * Uploading to Drive stays the operator's action — the script prints
 * the exact file to upload. Keys never enter backups by construction
 * (they live outside dsh/ entirely).
 */
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const WEDNESDAY_ROOT = path.resolve(__dirname, '..')
const DSH_DIR = path.join(WEDNESDAY_ROOT, 'dsh')
const MARKER = path.join(WEDNESDAY_ROOT, 'docs', 'WEDNESDAY_DSH_BACKUP_STATE.txt')
const DESKTOP = path.join(process.env.USERPROFILE || '', 'OneDrive', 'Desktop')

function sh(command, cwd) {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fingerprint() {
  const head = sh('git rev-parse HEAD', DSH_DIR)
  const status = sh('git status --porcelain', DSH_DIR)
  const crypto = require('node:crypto')
  return `${head} ${crypto.createHash('sha1').update(status).digest('hex').slice(0, 12)}`
}

function readMarker() {
  try {
    return fs.readFileSync(MARKER, 'utf8').trim()
  } catch {
    return null
  }
}

function main() {
  const checkOnly = process.argv.includes('--check-only')
  const current = fingerprint()
  const recorded = readMarker()
  if (process.argv.includes('--mark-current')) {
    fs.writeFileSync(MARKER, `${current}\n`);
    console.log(`DSH BACKUP: marked current (${current}).`);
    return
  }
  if (recorded === current) {
    console.log(`DSH BACKUP: current (${current}). Nothing to pack.`);
    return
  }
  console.log(`DSH BACKUP: changed since last backup.\n  was: ${recorded ?? '(never)'}\n  now: ${current}`)
  if (checkOnly) {
    console.log('DSH BACKUP: --check-only, not packing. Run without the flag to pack.');
    process.exitCode = 2
    return
  }
  const date = new Date().toISOString().slice(0, 10)
  const out = path.join(DESKTOP, `dsh-backup-${date}-full.zip`)
  console.log(`DSH BACKUP: packing (several minutes for ~1GB) → ${out}`);
  sh(`tar -a -cf "${out}" --exclude=node_modules -C "${WEDNESDAY_ROOT}" dsh`, WEDNESDAY_ROOT)
  const listing = sh(`tar -tf "${out}"`, WEDNESDAY_ROOT)
  for (const must of ['dsh/.git/HEAD', 'dsh/packages/examples/factory-acp-worker/src/bin.ts', 'dsh/apps/wednesday-runtime/']) {
    if (!listing.includes(must)) {
      throw new Error(`DSH BACKUP: verification failed, missing ${must}`)
    }
  }
  const mb = (fs.statSync(out).size / 1048576).toFixed(1)
  fs.writeFileSync(MARKER, `${current}\n`);
  console.log(`DSH BACKUP: verified (${mb} MB, .git + edits present). Marker updated.`);
  console.log(`DSH BACKUP: operator action → upload ${out} to Google Drive.`);
}

main()

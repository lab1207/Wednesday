import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultCommand,
  formatOutcome,
  listTargets,
  parseCommandLine,
  runSetup,
  whichOnPath,
  type SetupResult,
} from './setup'

/**
 * `wednesday setup` test (2026-11-15).
 *
 * The real writer is exercised against a temp home, so every assertion is
 * about bytes on disk: the unrelated keys survive, the backup holds the
 * original, the second run writes nothing, an unknown file is left alone.
 * No network, no client process, no operator config touched.
 */

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'wednesday-setup-'))
  const home = join(root, 'home')
  const command = ['/usr/local/bin/node', '/opt/wednesday/bin/wednesday-mcp.js']

  const env = { PATH: '', XDG_CONFIG_HOME: '' } as NodeJS.ProcessEnv
  const base = {
    home,
    platform: 'linux' as NodeJS.Platform,
    env,
    command,
    stamp: '20261115-090000',
    // No client CLI on PATH: the file writer is what this test proves.
    which: () => undefined,
  }

  try {
    await mkdir(join(home, '.claude'), { recursive: true })
    await mkdir(join(home, '.codex'), { recursive: true })
    await mkdir(join(home, '.cursor'), { recursive: true })
    await mkdir(join(home, '.config', 'opencode'), { recursive: true })

    const claudePath = join(home, '.claude.json')
    const codexPath = join(home, '.codex', 'config.toml')
    const cursorPath = join(home, '.cursor', 'mcp.json')
    const opencodePath = join(home, '.config', 'opencode', 'opencode.json')

    const claudeOriginal = `${JSON.stringify({
      numStartups: 7,
      theme: 'dark',
      mcpServers: { other: { command: 'other-server', args: ['--x'] } },
    }, null, 2)}\n`

    await writeFile(claudePath, claudeOriginal, 'utf8')
    await writeFile(codexPath, 'model = "gpt-5"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n', 'utf8')

    // --- detection -------------------------------------------------------
    const targets = listTargets(base)
    assert.deepEqual(
      targets.map(target => [target.id, target.detected]),
      [
        ['claude-code', true],
        ['claude-desktop', false],
        ['codex', true],
        ['cursor', true],
        ['opencode', true],
      ],
      'detection: config dirs count, an absent Claude Desktop does not',
    )

    // --- first run -------------------------------------------------------
    const first = runSetup(base)
    const byId = (outcome: { results: SetupResult[] }, id: string) =>
      outcome.results.find(result => result.client === id)

    assert.equal(byId(first, 'claude-code')?.action, 'updated')
    assert.equal(byId(first, 'codex')?.action, 'updated')
    assert.equal(byId(first, 'cursor')?.action, 'created')
    assert.equal(byId(first, 'opencode')?.action, 'created')
    assert.equal(byId(first, 'claude-desktop'), undefined, 'undetected clients are not configured')
    assert.equal(first.results.length, 4)

    // Claude Code: unrelated state and the other server survive; ours is stdio.
    const claude = JSON.parse(await readFile(claudePath, 'utf8')) as Record<string, any>
    assert.equal(claude.numStartups, 7)
    assert.equal(claude.theme, 'dark')
    assert.equal(claude.mcpServers.other.command, 'other-server')
    assert.deepEqual(claude.mcpServers.wednesday, {
      type: 'stdio',
      command: command[0],
      args: command.slice(1),
    })

    // The backup is the exact bytes that were there before.
    const backup = byId(first, 'claude-code')?.backup
    assert.ok(backup, 'an updated file names its backup')
    assert.equal(await readFile(backup!, 'utf8'), claudeOriginal)

    // Codex: a TOML table, every other line untouched.
    const codex = await readFile(codexPath, 'utf8')
    assert.match(codex, /^model = "gpt-5"$/m)
    assert.match(codex, /^\[profiles\.fast\]$/m)
    assert.match(codex, /^\[mcp_servers\.wednesday\]$/m)
    assert.match(codex, new RegExp(`^command = "${command[0].replace(/[/.]/g, '\\$&')}"$`, 'm'))

    // Cursor: created with the plain mcpServers shape.
    const cursor = JSON.parse(await readFile(cursorPath, 'utf8')) as Record<string, any>
    assert.deepEqual(cursor.mcpServers.wednesday, { command: command[0], args: command.slice(1) })

    // OpenCode: V2 shape under mcp.servers, with the schema for the editor.
    const opencode = JSON.parse(await readFile(opencodePath, 'utf8')) as Record<string, any>
    assert.equal(opencode.$schema, 'https://opencode.ai/config.json')
    assert.deepEqual(opencode.mcp.servers.wednesday, { type: 'local', command })
    assert.equal(opencode.mcp.wednesday, undefined, 'never the V1 shape')

    // --- second run is a no-op -------------------------------------------
    const second = runSetup(base)
    for (const result of second.results) {
      assert.equal(result.action, 'unchanged', `${result.client} must be idempotent`)
    }
    assert.equal(second.counts.created, 0)
    assert.equal(second.counts.updated, 0)

    const claudeBackups = (await readdir(home)).filter(name => name.includes('.wednesday-backup-'))
    assert.equal(claudeBackups.length, 1, 'a no-op run writes no second backup')

    // --- operator keys inside our TOML table survive a command change -----
    await writeFile(codexPath, codex.replace(
      '[mcp_servers.wednesday]',
      '[mcp_servers.wednesday]\nenv = { WEDNESDAY_LOG = "1" }',
    ), 'utf8')

    const changed = runSetup({ ...base, command: ['/usr/local/bin/node', '/moved/bin/wednesday-mcp.js'] })
    assert.equal(byId(changed, 'codex')?.action, 'updated')
    const codexAgain = await readFile(codexPath, 'utf8')
    assert.equal(codexAgain.match(/^\[mcp_servers\.wednesday\]$/gm)?.length, 1, 'no duplicate table')
    assert.match(codexAgain, /env = \{ WEDNESDAY_LOG = "1" \}/, 'a key the operator added is not deleted')
    assert.match(codexAgain, /\/moved\/bin\/wednesday-mcp\.js/)

    // --- a file that is not strict JSON is reported, not rewritten -------
    await writeFile(cursorPath, '{ "mcpServers": { broken', 'utf8')
    const broken = runSetup({ ...base, clients: ['cursor'] })
    assert.equal(broken.results[0].action, 'skipped')
    assert.match(broken.results[0].detail ?? '', /left untouched/)
    assert.equal(await readFile(cursorPath, 'utf8'), '{ "mcpServers": { broken')

    // --- dry run writes nothing -------------------------------------------
    const dryHome = join(root, 'dry-home')
    await mkdir(join(dryHome, '.cursor'), { recursive: true })
    const dry = runSetup({ ...base, home: dryHome, dryRun: true })
    assert.equal(dry.results[0].action, 'would-create')
    assert.equal(existsSync(join(dryHome, '.cursor', 'mcp.json')), false)

    // --- --all configures absent clients ----------------------------------
    const allHome = join(root, 'all-home')
    await mkdir(allHome, { recursive: true })
    const all = runSetup({ ...base, home: allHome, all: true })
    assert.deepEqual(all.results.map(result => result.action), [
      'created', 'created', 'created', 'created', 'created',
    ])
    assert.ok(existsSync(join(allHome, '.config', 'Claude', 'claude_desktop_config.json')))

    // --- the client's own CLI wins when it exists -------------------------
    const cliHome = join(root, 'cli-home')
    await mkdir(join(cliHome, '.claude'), { recursive: true })
    const claudeJson = join(cliHome, '.claude.json')
    await writeFile(claudeJson, '{"numStartups":1}\n', 'utf8')
    const calls: Array<{ command: string; args: string[] }> = []

    const viaCli = runSetup({
      ...base,
      home: cliHome,
      platform: 'win32',
      env: { PATH: '', APPDATA: join(cliHome, 'AppData', 'Roaming') } as NodeJS.ProcessEnv,
      which: binary => binary === 'claude' ? 'C:\\npm\\claude.cmd' : undefined,
      exec: (cmd, args) => {
        calls.push({ command: cmd, args })
        // The real `claude mcp add` writes the file itself; do the same here
        // so the next run can prove the no-op path.
        writeFileSync(claudeJson, `${JSON.stringify({
          numStartups: 1,
          mcpServers: { wednesday: { type: 'stdio', command: command[0], args: command.slice(1) } },
        }, null, 2)}\n`, 'utf8')
        return { status: 0, stdout: 'Added', stderr: '' }
      },
    })

    assert.equal(viaCli.results[0].action, 'updated')
    assert.match(viaCli.results[0].via ?? '', /^claude mcp add --scope user wednesday -- /)
    assert.equal(calls.length, 1)
    assert.match(calls[0].command, /cmd\.exe$/i, 'a .cmd shim runs through cmd.exe (B241)')
    assert.deepEqual(calls[0].args.slice(0, 4), ['/d', '/s', '/c', 'C:\\npm\\claude.cmd'])
    assert.deepEqual(calls[0].args.slice(4, 9), ['mcp', 'add', '--scope', 'user', 'wednesday'])

    const viaCliAgain = runSetup({
      ...base,
      home: cliHome,
      platform: 'win32',
      env: { PATH: '', APPDATA: join(cliHome, 'AppData', 'Roaming') } as NodeJS.ProcessEnv,
      which: binary => binary === 'claude' ? 'C:\\npm\\claude.cmd' : undefined,
      exec: (cmd, args) => {
        calls.push({ command: cmd, args })
        return { status: 0, stdout: '', stderr: '' }
      },
    })

    assert.equal(viaCliAgain.results[0].action, 'unchanged', 'a registered server is not registered twice')
    assert.equal(calls.length, 1, 'the client CLI is not invoked again')

    // --- helpers ------------------------------------------------------------
    assert.deepEqual(parseCommandLine('node "/a b/bin.js" --flag'), ['node', '/a b/bin.js', '--flag'])
    assert.deepEqual(defaultCommand()[0], process.execPath)

    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'claude.cmd'), '', 'utf8')
    assert.equal(
      whichOnPath('claude', 'win32', { PATH: bin } as NodeJS.ProcessEnv),
      join(bin, 'claude.cmd'),
      'PATH lookup understands the Windows extensions',
    )
    assert.equal(whichOnPath('missing', 'win32', { PATH: bin } as NodeJS.ProcessEnv), undefined)

    const receipt = formatOutcome(first, 'live')
    assert.match(receipt, /wednesday setup/)
    assert.match(receipt, /Claude Code\s+updated/)
    assert.match(receipt, /backup/)

    console.log('WEDNESDAY SETUP TEST: PASS (5 clients, backups, idempotent, TOML preserved, CLI shim, dry run)')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

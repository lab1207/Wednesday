import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { stdin, stdout } from 'node:process'
import { access } from 'node:fs/promises'
import { CONFIG_PATH, saveConfig, validateModel } from './config'

export async function setup(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Setup requires your own interactive terminal; never send API keys through chat or command arguments.')
  try {
    await access(CONFIG_PATH)
    throw new Error('Factory user .env already exists. Edit it privately; setup will not overwrite it.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  console.log(`Local plaintext credentials will be saved to ${CONFIG_PATH}, outside the repository.`)
  console.log('This is not an encrypted credential vault. Protect this file and exclude it from shared backups.')
  let hidden = false
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!hidden) stdout.write(chunk, encoding as BufferEncoding)
    callback()
  } })
  const readline = createInterface({ input: stdin, output, terminal: true })
  readline.on('SIGINT', () => readline.close())
  try {
    const model = (await readline.question('OpenRouter model ID (provider/model): ')).trim()
    validateModel(model)
    stdout.write('OpenRouter API key (hidden): ')
    hidden = true
    const key = (await readline.question('')).trim()
    hidden = false
    stdout.write('\n')
    if ((await readline.question('Save credentials locally? [y/N] ')).trim().toLowerCase() !== 'y') {
      console.log('Setup cancelled; nothing saved.')
      return
    }
    await saveConfig(key, model)
    console.log('Configuration saved. No API request was made; model availability and key validity are not yet verified.')
  } finally {
    hidden = false
    readline.close()
    output.end()
  }
}

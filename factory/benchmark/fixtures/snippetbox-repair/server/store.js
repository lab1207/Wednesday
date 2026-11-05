import {
  readFile,
  writeFile,
  mkdir,
} from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * JSON-file-backed store for SnippetBox benchmark data.
 * Shape: { users: [{username, passwordHash}], notes: [{id, username, content, createdAt}], tokens: [] }
 */

/** @typedef {{ username: string, passwordHash: string }} SnippetBoxUser */
/** @typedef {{ id: string, username: string, content: string, createdAt: string }} SnippetBoxNote */
/** @typedef {{ users: SnippetBoxUser[], notes: SnippetBoxNote[], tokens: string[] }} SnippetBoxData */

export class JsonStore {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath
  }

  /** @returns {Promise<SnippetBoxData>} */
  async load() {
    try {
      return JSON.parse(
        await readFile(this.filePath, 'utf8'),
      )
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { users: [], notes: [], tokens: [] }
      }
      throw error
    }
  }

  /** @param {SnippetBoxData} data @returns {Promise<void>} */
  async save(data) {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8')
  }
}
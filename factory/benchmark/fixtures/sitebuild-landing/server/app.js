import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, normalize, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// Anchored to this module, not the process cwd: the benchmark runner
// boots from the run workspace while offline tests import from the
// repo checkout. Either way public/ sits next to server/.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

export async function handle(req, res) {
  const path =
    req.url === '/' ? '/index.html' : String(req.url).split('?')[0]
  const file = normalize(join(ROOT, path))

  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('forbidden')
    return
  }

  try {
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }
}

export const server = createServer(handle)

export function start(port = 0) {
  return new Promise(resolve => {
    server.listen(port, () => resolve(server.address().port))
  })
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.PORT ?? 4080)
  void start(port).then(actual => {
    console.log(`Landing site on http://127.0.0.1:${actual}`)
  })
}

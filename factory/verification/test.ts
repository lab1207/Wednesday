import { join } from 'node:path'
import { INSTALL_ROOT } from '../paths'
import { VerificationEngine } from './index'

async function main(): Promise<void> {
  const engine = new VerificationEngine()

  const result = await engine.verify(
    join(INSTALL_ROOT, 'dsh-test-workspace'),
    [],
    [
      '.\\.venv\\Scripts\\python.exe -m pytest -q',
    ],
  )

  console.log(JSON.stringify(result, null, 2))
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
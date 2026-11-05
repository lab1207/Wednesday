import { boot, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { join } from 'node:path'
import { DSH_ROOT, WORKER_DIRECTORY } from '../paths'

const configPath = resolveConfigPath(
  join(WORKER_DIRECTORY, 'cordis.yml'),
  undefined,
)

loadEnv('factory-dsh-worker', DSH_ROOT)

const ctx = await boot('factory-dsh-worker', configPath)

// Keep the ACP process alive. The ACP transport owns stdin/stdout.
// Disposal happens when the parent closes the child process.
await new Promise<void>((resolve) => {
  const finish = () => {
    void ctx.fiber.dispose().finally(resolve)
  }

  process.stdin.once('end', finish)
  process.stdin.once('close', finish)
  process.once('SIGTERM', finish)
  process.once('SIGINT', finish)
})

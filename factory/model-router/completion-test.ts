import {
  OpenRouterProvider,
  RegistryModelRouter,
} from './index'

async function main(): Promise<void> {
  const router = new RegistryModelRouter()
  router.register(new OpenRouterProvider())

  const result = await router.complete(
    {
      capability: 'reasoning',
    },
    'Reply with exactly: FACTORY_MODEL_CLIENT_OK',
  )

  console.log(JSON.stringify(result, null, 2))
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
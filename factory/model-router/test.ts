import { OpenRouterProvider, RegistryModelRouter } from './index'

async function main(): Promise<void> {
  const router = new RegistryModelRouter()
  router.register(new OpenRouterProvider())

  const route = await router.select({
    capability: 'coding',
  })

  console.log(JSON.stringify(route, null, 2))
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
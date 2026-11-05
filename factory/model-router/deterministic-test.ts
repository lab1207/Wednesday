import {
  RegistryModelRouter,
} from './router'

import {
  DeterministicProvider,
} from './providers/deterministic'

async function main(): Promise<void> {
  const router =
    new RegistryModelRouter()

  router.register(
    new DeterministicProvider(),
  )

  const route =
    await router.select({
      capability: 'coding',
    })

  console.log(
    JSON.stringify(
      {
        route,
      },
      null,
      2,
    ),
  )

  const result =
    await router.complete(
      {
        capability: 'coding',
      },
      'Architect: design a simple calculator.',
    )

  console.log(
    JSON.stringify(
      result,
      null,
      2,
    ),
  )
}

void main().catch(
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  },
)
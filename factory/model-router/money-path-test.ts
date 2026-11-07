/**
 * Offline test for the MONEY PATH: what a run costs, and who says so.
 * No network, no model, no spend.
 *
 * The gap this closes (2026-11-05): the factory could print tokens but not
 * a price it could stand behind. The built-in table was one line of
 * comments, so every real model reported `null` cost - and a receipt that
 * says "unknown" for every run teaches the operator nothing about whether
 * a team is affordable.
 *
 * The rule now: the built-in table stays short (only what is certain), and
 * the OPERATOR supplies the rest with `FACTORY_PRICE_<MODEL>=<in>,<out>`
 * in USD per million tokens. Their contract, their number. An unpriced
 * model reports null rather than a made-up figure.
 */
import assert from 'node:assert/strict'

import {
  estimateCostUsd,
  estimateSeatCostUsd,
  parsePriceOverride,
  priceEnvName,
  priceForModel,
  type SeatUsageRecord,
  type UsageRecord,
} from './usage'

function record(model: string, promptTokens: number, completionTokens: number): UsageRecord {
  return {
    provider: 'openrouter',
    model,
    calls: 1,
    promptTokens,
    completionTokens,
  }
}

function seat(model: string, promptTokens: number, completionTokens: number): SeatUsageRecord {
  return {
    seat: 'coder',
    provider: 'openrouter',
    model,
    calls: 1,
    promptTokens,
    completionTokens,
    elapsedMs: 1000,
  }
}

async function main(): Promise<void> {
  // 1. THE ENV NAME. The model name is uppercased and every non-alphanumeric
  //    character becomes `_`, so `qwen/qwen3-coder` becomes
  //    `FACTORY_PRICE_QWEN_QWEN3_CODER`.
  assert.equal(priceEnvName('qwen/qwen3-coder'), 'FACTORY_PRICE_QWEN_QWEN3_CODER')
  assert.equal(priceEnvName('openrouter/free'), 'FACTORY_PRICE_OPENROUTER_FREE')
  assert.equal(priceEnvName('  spaced name  '), 'FACTORY_PRICE_SPACED_NAME')
  assert.equal(priceEnvName(''), '')

  // 2. THE PARSE. `<input>,<output>` in USD per million tokens.
  {
    const good = parsePriceOverride('0.30,1.20')
    assert.ok(good)
    assert.equal(good!.input, 0.30)
    assert.equal(good!.output, 1.20)
    // A price of ZERO is valid and means "this costs nothing" - the truth
    // for a free tier. It must not be confused with "unknown".
    const free = parsePriceOverride('0,0')
    assert.ok(free)
    assert.equal(free!.input, 0)
    assert.equal(free!.output, 0)
  }

  // 3. THE REFUSALS. A malformed price is null, never a guess.
  {
    assert.equal(parsePriceOverride(undefined), null)
    assert.equal(parsePriceOverride(''), null)
    assert.equal(parsePriceOverride('   '), null)
    assert.equal(parsePriceOverride('0.30'), null, 'one number is not a price')
    assert.equal(parsePriceOverride('0.30,1.20,2'), null, 'three numbers are not a price')
    assert.equal(parsePriceOverride('abc,def'), null)
    assert.equal(parsePriceOverride('-1,2'), null, 'a negative price is not a price')
    assert.equal(parsePriceOverride('0.30,NaN'), null)
  }

  // 4. THE OPERATOR'S PRICE WINS. Their contract, their number.
  {
    const env = {
      FACTORY_PRICE_QWEN_QWEN3_CODER: '0.30,1.20',
    } as NodeJS.ProcessEnv
    const price = priceForModel('qwen/qwen3-coder', env)
    assert.ok(price)
    assert.equal(price!.input, 0.30)
    assert.equal(price!.output, 1.20)

    // And the cost follows the price: 1M in + 1M out = 0.30 + 1.20.
    const cost = estimateCostUsd(record('qwen/qwen3-coder', 1_000_000, 1_000_000), env)
    assert.ok(cost !== null)
    assert.equal(Math.round(cost! * 1000) / 1000, 1.5)
  }

  // 5. AN UNPRICED MODEL REPORTS NULL. A made-up dollar figure in a receipt
  //    is a claim the factory cannot back.
  {
    assert.equal(priceForModel('some/unknown-model', {} as NodeJS.ProcessEnv), null)
    const cost = estimateCostUsd(record('some/unknown-model', 1000, 1000), {} as NodeJS.ProcessEnv)
    assert.equal(cost, null, 'an unpriced model reports unknown, not zero')
  }

  // 6. A MALFORMED OVERRIDE IS IGNORED, not used. A typo in the env must not
  //    turn into a wrong price.
  {
    const env = { FACTORY_PRICE_QWEN_QWEN3_CODER: 'free' } as NodeJS.ProcessEnv
    assert.equal(priceForModel('qwen/qwen3-coder', env), null)
  }

  // 7. THE FREE TIER COSTS NOTHING, and that is known.
  {
    const env = {} as NodeJS.ProcessEnv
    const price = priceForModel('deepseek/deepseek-chat:free', env)
    assert.ok(price)
    assert.equal(price!.input, 0)
    assert.equal(price!.output, 0)
    const cost = estimateCostUsd(record('deepseek/deepseek-chat:free', 1_000_000, 1_000_000), env)
    assert.equal(cost, 0)
  }

  // 8. A LOCAL MODEL COSTS THE OPERATOR NOTHING IN MONEY (their hardware is
  //    the cost), and the receipt says zero - not "unknown", because zero is
  //    the truth about the money.
  {
    const local: UsageRecord = {
      provider: 'local',
      model: 'qwen2.5-coder-3b-instruct',
      calls: 1,
      promptTokens: 1000,
      completionTokens: 1000,
    }
    assert.equal(estimateCostUsd(local, {} as NodeJS.ProcessEnv), 0)
    const localSeat: SeatUsageRecord = { ...seat('qwen2.5-coder-3b-instruct', 1000, 1000), provider: 'local' }
    assert.equal(estimateSeatCostUsd(localSeat, {} as NodeJS.ProcessEnv), 0)
  }

  // 9. THE SEAT COST FOLLOWS THE SAME RULE as the model cost.
  {
    const env = { FACTORY_PRICE_QWEN_QWEN3_CODER: '0.30,1.20' } as NodeJS.ProcessEnv
    const cost = estimateSeatCostUsd(seat('qwen/qwen3-coder', 1_000_000, 1_000_000), env)
    assert.ok(cost !== null)
    assert.equal(Math.round(cost! * 1000) / 1000, 1.5)
    // Unpriced: the seat reports unknown, so the team table can show
    // "unpriced" instead of a number nobody can check.
    assert.equal(
      estimateSeatCostUsd(seat('other/model', 1000, 1000), {} as NodeJS.ProcessEnv),
      null,
    )
  }

  // 10. THE ROUTER HONOURS THE OPERATOR'S PRICE (2026-11-05).
  //
  //     `ModelRequirements.maxCost` existed from the start and NOTHING read
  //     it, so "a model under $X" was unanswerable - the exact question a
  //     manager of a small-model fleet asks. The cap is now enforced at
  //     selection time, against the operator's own price.
  {
    const { RegistryModelRouter } = await import('./router')
    const { ModelProvider } = await import('./types')
    const router = new RegistryModelRouter()
    const provider: ModelProvider = {
      name: 'openrouter',
      supports: () => true,
      // Two models on offer: one the operator priced above the cap, one
      // under it.
      listModels: async () => ['acme/expensive', 'acme/cheap'],
      complete: async () => 'OK',
    }
    router.register(provider)

    const savedExpensive = process.env.FACTORY_PRICE_ACME_EXPENSIVE
    const savedCheap = process.env.FACTORY_PRICE_ACME_CHEAP
    try {
      // No prices at all: a cost cap cannot be checked, so NO model may
      // satisfy it. The rule is "we do not promise what we cannot check" -
      // and a silent over-budget run is the one outcome a cap must never
      // produce.
      delete process.env.FACTORY_PRICE_ACME_EXPENSIVE
      delete process.env.FACTORY_PRICE_ACME_CHEAP
      await assert.rejects(
        () => router.select({ maxCost: 1 }),
        /fits the requested limits/,
        'an unmeasurable cap refuses every model instead of ignoring the cap',
      )

      // Priced: the model that FITS wins, even though it is not the first
      // one on the list.
      process.env.FACTORY_PRICE_ACME_EXPENSIVE = '10,30'
      process.env.FACTORY_PRICE_ACME_CHEAP = '0.10,0.30'
      const chosen = await router.select({ maxCost: 1 })
      assert.deepEqual(chosen, { provider: 'openrouter', model: 'acme/cheap' })

      // The same cap, no limit: the first model is taken, unchanged.
      const unlimited = await router.select({})
      assert.deepEqual(unlimited, { provider: 'openrouter', model: 'acme/expensive' })

      // An explicit PIN stays the operator's decision, even over the cap:
      // silently swapping in a different model would be worse than
      // overrunning a limit the operator can see in the receipt.
      const pinned = await router.select({
        preferredModel: 'openrouter/acme/expensive',
        maxCost: 1,
      })
      assert.deepEqual(pinned, { provider: 'openrouter', model: 'acme/expensive' })
    } finally {
      if (savedExpensive === undefined) delete process.env.FACTORY_PRICE_ACME_EXPENSIVE
      else process.env.FACTORY_PRICE_ACME_EXPENSIVE = savedExpensive
      if (savedCheap === undefined) delete process.env.FACTORY_PRICE_ACME_CHEAP
      else process.env.FACTORY_PRICE_ACME_CHEAP = savedCheap
    }
  }

  console.log('money-path: PASS')
}

main().catch((err) => { console.error(err); process.exit(1) })

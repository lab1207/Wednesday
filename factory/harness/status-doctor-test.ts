/**
 * Offline tests for status + doctor: render redacts keys, doctor gates
 * and resolves with an injected probe. No network, no profile writes.
 */
import assert from 'node:assert/strict'

import { renderStatus } from './status'
import { renderDoctor, runDoctor } from './doctor'

async function main(): Promise<void> {
  // 1. Status: route + model shown, key value never printed.
  const local = renderStatus({
    FACTORY_LLM_PROVIDER: 'local',
    LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8080/v1',
    LOCAL_LLM_MODEL: 'qwen-1bit',
    LOCAL_LLM_API_KEY: 's3cr3t-value',
    FACTORY_MODELS: 'qwen1b:local/qwen-1bit@http://127.0.0.1:8080/v1',
    FACTORY_ACTIVE_MODEL: 'qwen1b',
  } as NodeJS.ProcessEnv)
  assert.ok(local.includes('Wednesday Status'), 'the answer has Hermes\' status heading')
  assert.ok(local.includes('Route: local'))
  assert.ok(local.includes('qwen-1bit'))
  assert.ok(local.includes('Active: qwen1b (local/qwen-1bit)'))
  assert.ok(!local.includes('s3cr3t-value'), 'key values must never render')
  const solo = renderStatus({} as NodeJS.ProcessEnv)
  assert.ok(solo.includes('Pool: solo'))

  // 1b. The two model paths are named (operator, 2026-11-04: "why separately
  // hi messages goes and build message goes? is there any how ask and build
  // model?"). A question speaks to ONE model; a build runs the pipeline's
  // seats. One model can fill both, and the page says so.
  //
  // The CHAT row is resolved through the SAME resolver the chat turn uses,
  // so it cannot name a model the conversation would not actually speak to.
  // The keys here are FAKE and never rendered (the page shows set/unset).
  {
    const withCrew = renderStatus(
      {
        DSH_LLM_MODEL: 'qwen2.5-coder-3b-instruct',
        NVIDIA_API_KEY: 'fake-nvidia-key',
      } as NodeJS.ProcessEnv,
      undefined,
      {},
      {
        name: 'junun',
        seats: [
          { role: 'planner', model: 'nvidia/google/gemma-3-4b-it' },
          { role: 'coder', model: 'nvidia/google/gemma-3-4b-it' },
          { role: 'vision', model: 'nvidia/google/gemma-3-4b-it' },
        ],
      },
    )
    assert.match(withCrew, /Chat: nvidia\/google\/gemma-3-4b-it/, 'chat speaks to the team\'s first seat')
    // 2026-11-05: the count is SEATS that route, and the word is "seats"
    // not "slots" - a crew of three that fills planner/coder/vision runs
    // three pipeline seats, and the page says so honestly.
    assert.match(withCrew, /Build: junun · nvidia\/google\/gemma-3-4b-it \(3 seats\)/, 'build names the team and the seats the pipeline uses')
    // A team that does not fill every seat: the empty seat falls back to the
    // env/default, and the page says WHICH model that is.
    const partial = renderStatus(
      { OPENROUTER_API_KEY: 'fake-openrouter-key' } as NodeJS.ProcessEnv,
      undefined,
      {},
      {
        name: 'pair',
        seats: [
          { role: 'planner', model: 'seat-a' },
          { role: 'coder', model: 'seat-a' },
        ],
      },
    )
    // 2026-11-05: the build line names EVERY real pipeline seat, not just
    // three. The operator's complaint was "the team had six seats and the
    // status page named three" - so the page now names all six, and an
    // unfilled seat says which real fallback it got.
    assert.match(
      partial,
      /Build: pair · architect=seat-a planner=seat-a coder=seat-a tester=seat-a reviewer=seat-a vision=Qwen2\.5-VL-7B-Instruct/,
      'an unfilled seat names its real fallback, and every seat is named',
    )
    // No team: the env seats answer the build, and the route model answers
    // the chat.
    const envSeats = renderStatus({
      DSH_LLM_MODEL: 'route-model',
      OPENROUTER_API_KEY: 'fake-openrouter-key',
      FACTORY_CREW_PLANNER_MODEL: 'seat-a',
      FACTORY_CREW_CODER_MODEL: 'seat-b',
      FACTORY_CREW_VISION_MODEL: 'seat-a',
    } as NodeJS.ProcessEnv)
    assert.match(envSeats, /Chat: route-model/, 'without a team the route model answers the chat')
    assert.match(envSeats, /Build: architect=seat-a planner=seat-a coder=seat-b tester=seat-b reviewer=seat-b vision=seat-a/, 'and the env seats answer the build')
    // No team and no env seats: the built-in defaults are named, not a blank.
    const bare = renderStatus({
      DSH_LLM_MODEL: 'route-model',
      OPENROUTER_API_KEY: 'fake-openrouter-key',
    } as NodeJS.ProcessEnv)
    assert.match(bare, /Build: architect=DeepSeek-R1-Distill-Qwen-7B planner=DeepSeek-R1-Distill-Qwen-7B/, 'with nothing set the page names the real defaults')
  }

  // 1c. The chat row is TRUTHFUL: it resolves the seat the way the chat turn
  // resolves it. A hosted route will not take a bare seat id (no provider
  // slash), so the turn falls back to the route's model — and the page must
  // name THAT model, not the seat it will not use.
  {
    const mismatch = renderStatus(
      {
        FACTORY_LLM_PROVIDER: 'nvidia',
        NVIDIA_API_KEY: 'fake-nvidia-key',
        NVIDIA_LLM_MODEL: 'route-model',
      } as NodeJS.ProcessEnv,
      undefined,
      {},
      { name: 'bare', seats: [{ role: 'planner', model: 'bare-seat' }] },
    )
    assert.match(mismatch, /Chat: route-model \(seat bare-seat does not fit the nvidia route\)/, 'a seat the route cannot use is named as such')
    assert.ok(!/Chat: bare-seat/.test(mismatch), 'the row never claims a model the chat would not speak to')
    // A missing key BLOCKS the chat: the page says blocked, not a model.
    const blocked = renderStatus(
      { FACTORY_LLM_PROVIDER: 'nvidia' } as NodeJS.ProcessEnv,
      undefined,
      {},
      { name: 'junun', seats: [{ role: 'planner', model: 'nvidia/google/gemma-3-4b-it' }] },
    )
    assert.match(blocked, /Chat: \(blocked — NVIDIA route selected but NVIDIA_API_KEY is not set\)/, 'a route with no key says blocked')
    // A local route DOES take a bare seat id.
    const local = renderStatus(
      {
        FACTORY_LLM_PROVIDER: 'local',
        LOCAL_LLM_BASE_URL: 'http://127.0.0.1:8080/v1',
      } as NodeJS.ProcessEnv,
      undefined,
      {},
      { name: 'local-team', seats: [{ role: 'planner', model: 'my-local-model' }] },
    )
    assert.match(local, /Chat: my-local-model/, 'a local route speaks to the seat model')
  }

  // 2. Doctor: local route, injected probe up -> ready.
  const up = await runDoctor(
    { FACTORY_LLM_PROVIDER: 'local', LOCAL_LLM_BASE_URL: 'http://x/v1' } as NodeJS.ProcessEnv,
    async () => ({ ok: true }),
  )
  assert.ok(up.every(check => check.ok))
  assert.equal(renderDoctor(up).ok, true)

  // 3. Doctor: probe down -> FAIL names the endpoint, no secrets.
  const down = await runDoctor(
    {
      FACTORY_LLM_PROVIDER: 'local',
      FACTORY_MODELS: 'a:local/m@http://x/v1',
      FACTORY_ACTIVE_MODEL: 'ghost',
    } as NodeJS.ProcessEnv,
    async () => ({ ok: false, error: 'no route to x' }),
  )
  const rendered = renderDoctor(down)
  assert.equal(rendered.ok, false)
  assert.ok(rendered.text.includes('FAIL  local endpoint: no route to x'))
  assert.ok(rendered.text.includes('"ghost" matches nothing saved'))

  console.log('STATUS DOCTOR TEST: PASS')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

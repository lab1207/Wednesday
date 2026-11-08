/**
 * The operator's six-model roster must be STAFFABLE (2026-11-07).
 *
 * The operator named the seats their team runs and the model each one
 * wears:
 *
 *   UI/UX DESIGN    -> Qwen2.5-VL-3B       -> the `vision` seat
 *   ARCHITECTURE    -> Granite 3.1 2B      -> the `architect` seat
 *   CORE CODING     -> Qwen2.5-Coder-3B    -> the `coder` seat
 *   AUTOCOMPLETE    -> DeepSeek Coder 1.3B -> the `autocomplete` seat
 *   BUG HUNTING     -> Llama-3.2-3B        -> the `bug-hunter` seat
 *   SECURITY AUDIT  -> Granite-2B-Guardian -> the `security-audit` seat
 *
 * Three of those seats already existed. The other three are new, and they
 * are the ones this release adds.
 *
 * THE RULE THAT MATTERS HERE: a seat's roster default applies ONLY when the
 * seat has its OWN endpoint. A seat that shares a box with another seat
 * cannot run a different model on it, and a default that claimed otherwise
 * would make the status meter report models the session never routes.
 *
 * Pure asserts only -- no network, no models, no weights.
 */

import assert from 'node:assert/strict'

import {
  CREW_ROLES,
  CREW_SEAT_DEFAULT_MODELS,
  crewRoleBaseEnvName,
  crewRoleEnvName,
  normalizeCrewRole,
  resolveCrewModel,
  seatModelPin,
  TRIO_CODER_MODEL,
} from './crew-routing'

const LOCAL_BOX = 'http://127.0.0.1:1337/v1'

function main(): void {
  // 1. The three new seats exist, and every roster seat is a real seat.
  for (const role of CREW_ROLES) {
    assert.ok(
      normalizeCrewRole(role) !== null,
      `${role} must be a normalizable seat`,
    )
  }
  for (const role of [
    'autocomplete',
    'bug-hunter',
    'security-audit',
  ]) {
    assert.ok(
      CREW_ROLES.includes(role as never),
      `the ${role} seat must be registered`,
    )
    assert.equal(
      normalizeCrewRole(role),
      role,
      `the ${role} seat must normalize to itself`,
    )
  }

  // 2. The roster defaults are the operator's models.
  assert.equal(
    CREW_SEAT_DEFAULT_MODELS['bug-hunter'],
    'Llama-3.2-3B-Instruct',
  )
  assert.equal(
    CREW_SEAT_DEFAULT_MODELS['security-audit'],
    'granite-guardian-3.1-2b',
  )
  assert.equal(
    CREW_SEAT_DEFAULT_MODELS.autocomplete,
    'deepseek-coder-1.3b-base',
  )

  // 3. THE ENV NAMES ARE TYPEABLE. A hyphen is not valid in a PowerShell
  //    env reference, so the name carries underscores.
  assert.equal(
    crewRoleEnvName('bug-hunter'),
    'FACTORY_CREW_BUG_HUNTER_MODEL',
  )
  assert.equal(
    crewRoleEnvName('security-audit'),
    'FACTORY_CREW_SECURITY_AUDIT_MODEL',
  )
  assert.equal(
    crewRoleEnvName('autocomplete'),
    'FACTORY_CREW_AUTOCOMPLETE_MODEL',
  )
  assert.equal(
    crewRoleBaseEnvName('bug-hunter'),
    'FACTORY_CREW_BUG_HUNTER_BASE_URL',
  )
  assert.equal(
    crewRoleBaseEnvName('security-audit'),
    'FACTORY_CREW_SECURITY_AUDIT_BASE_URL',
  )

  // 4. An UNSTAFFED seat stays on its slot. It does not claim a model the
  //    session never routes.
  assert.equal(
    resolveCrewModel('bug-hunter', {}),
    TRIO_CODER_MODEL,
    'an unstaffed bug-hunter seat must stay on the coder slot',
  )
  assert.equal(
    resolveCrewModel('security-audit', {}),
    TRIO_CODER_MODEL,
    'an unstaffed security-audit seat must stay on the coder slot',
  )
  assert.equal(
    resolveCrewModel('autocomplete', {}),
    TRIO_CODER_MODEL,
    'an unstaffed autocomplete seat must stay on the coder slot',
  )

  // 5. A STAFFED seat wears the operator's model.
  assert.equal(
    resolveCrewModel(
      'bug-hunter',
      { FACTORY_CREW_BUG_HUNTER_BASE_URL: LOCAL_BOX },
    ),
    'Llama-3.2-3B-Instruct',
    'a staffed bug-hunter seat must wear the roster model',
  )
  assert.equal(
    resolveCrewModel(
      'security-audit',
      { FACTORY_CREW_SECURITY_AUDIT_BASE_URL: LOCAL_BOX },
    ),
    'granite-guardian-3.1-2b',
    'a staffed security-audit seat must wear the roster model',
  )
  assert.equal(
    resolveCrewModel(
      'autocomplete',
      { FACTORY_CREW_AUTOCOMPLETE_BASE_URL: LOCAL_BOX },
    ),
    'deepseek-coder-1.3b-base',
    'a staffed autocomplete seat must wear the roster model',
  )

  // 6. The seat's OWN model env var always wins.
  assert.equal(
    resolveCrewModel(
      'bug-hunter',
      {
        FACTORY_CREW_BUG_HUNTER_MODEL: 'acme/hunter-v2',
        FACTORY_CREW_BUG_HUNTER_BASE_URL: LOCAL_BOX,
      },
    ),
    'acme/hunter-v2',
    'the seat model env var must win over the roster default',
  )
  assert.equal(
    resolveCrewModel(
      'bug-hunter',
      { FACTORY_CREW_BUG_HUNTER_MODEL: 'acme/hunter-v2' },
    ),
    'acme/hunter-v2',
    'the seat model env var must win even without a seat endpoint',
  )

  // 7. THE PIN. A bare roster id belongs to the LOCAL route when the seat
  //    has its own box. A bare id with no local endpoint must not be sent
  //    to a hosted route that cannot resolve it.
  assert.equal(
    seatModelPin(
      'bug-hunter',
      { FACTORY_CREW_BUG_HUNTER_BASE_URL: LOCAL_BOX },
    ),
    'local/Llama-3.2-3B-Instruct',
    'a staffed local seat must be pinned to the local route',
  )
  assert.equal(
    seatModelPin('bug-hunter', {}),
    undefined,
    'an unstaffed seat has no roster pin to send',
  )
  assert.equal(
    seatModelPin(
      'bug-hunter',
      { FACTORY_CREW_BUG_HUNTER_MODEL: 'openrouter/meta/llama-3.2-3b' },
    ),
    'openrouter/meta/llama-3.2-3b',
    'an already-pinned id is authoritative',
  )

  // 8. A hosted route must not receive a bare local id.
  const hosted =
    seatModelPin(
      'security-audit',
      {
        FACTORY_LLM_PROVIDER: 'openrouter',
        FACTORY_CREW_CODER_MODEL: 'openrouter/qwen/qwen2.5-coder-3b',
      },
    )
  assert.ok(
    hosted === undefined ||
      hosted.startsWith('openrouter/'),
    `a hosted route must not receive a bare local id, got: ${String(hosted)}`,
  )

  console.log('crew-seats: PASS')
}

main()

/**
 * Offline test for chat addressing: which seat answers, and the `@role`
 * address. No network.
 *
 * The bug this pins (2026-11-05): the chat path took `crew.seats[0]` — an
 * ARRAY INDEX, not a role — so a crew whose first seat was the vision model
 * sent every question to the vision model. The seat is now chosen by ROLE,
 * with a preference order, and the operator can name a seat with `@role`.
 */
import assert from 'node:assert/strict'
import {
  CHAT_SEAT_ORDER,
  chatAddressNames,
  chatSeatModel,
  parseChatAddress,
  pickChatSeat,
} from './chat-addressing'

async function main(): Promise<void> {
  // 1. The preference order: the architect reasons, the coder types, the
  //    vision seat is last because it needs an image to be useful.
  assert.equal(CHAT_SEAT_ORDER[0], 'architect')
  assert.equal(CHAT_SEAT_ORDER[CHAT_SEAT_ORDER.length - 1], 'vision')

  // 2. A crew whose FIRST seat is the vision model must NOT send every
  //    question to the vision model. That was the bug.
  {
    const crew = {
      seats: [
        { role: 'vision', model: 'acme/vision-small' },
        { role: 'coder', model: 'acme/coder-small' },
      ],
    }
    const picked = pickChatSeat(crew)
    assert.ok(picked, 'a crew with seats has a conversational seat')
    assert.equal(picked!.role, 'coder', 'the vision seat is not the default speaker')
    assert.equal(picked!.model, 'acme/coder-small')
  }

  // 3. The architect wins when the crew fills it.
  {
    const crew = {
      seats: [
        { role: 'coder', model: 'acme/coder-small' },
        { role: 'architect', model: 'acme/architect-small' },
      ],
    }
    assert.equal(pickChatSeat(crew)?.role, 'architect')
  }

  // 4. A crew that fills no conversational seat falls back to the env
  //    profile, and says which seat that is.
  {
    const env = {
      FACTORY_CREW_PLANNER_MODEL: 'env/planner',
    } as NodeJS.ProcessEnv
    const picked = pickChatSeat({ seats: [{ role: 'worker-4', model: 'x' }] }, env)
    assert.equal(picked?.role, 'planner')
    assert.equal(picked?.model, 'env/planner')
  }

  // 5. A crew with no seats at all has no conversational seat.
  assert.equal(pickChatSeat(null), null)
  assert.equal(pickChatSeat({ seats: [] }), null)

  // 6. The address: `@reviewer ...` names a REAL seat and strips itself.
  {
    const addressed = parseChatAddress('@reviewer is this diff safe?')
    assert.ok(addressed, 'a real seat address is read')
    assert.equal(addressed!.role, 'reviewer')
    assert.equal(addressed!.text, 'is this diff safe?')
    assert.equal(addressed!.raw, '@reviewer')
  }

  // 7. Case-insensitive, and the seat name may be followed by punctuation.
  {
    const addressed = parseChatAddress('@Reviewer  look at this')
    assert.equal(addressed?.role, 'reviewer')
    assert.equal(addressed?.text, 'look at this')
  }

  // 8. An address that names NO real seat is NOT an address: the request is
  //    returned untouched. An email or a decorator must not be eaten.
  assert.equal(parseChatAddress('@someone do the thing'), null)
  assert.equal(parseChatAddress('mail me at bob@example.com'), null)
  assert.equal(parseChatAddress('no address here'), null)
  assert.equal(parseChatAddress(''), null)

  // 9. An address with nothing behind it is not a request either.
  assert.equal(parseChatAddress('@reviewer'), null)
  assert.equal(parseChatAddress('@reviewer   '), null)

  // 10. The named seat's model is the crew's own seat when it has one.
  {
    const crew = {
      seats: [
        { role: 'coder', model: 'acme/coder-small' },
        { role: 'reviewer', model: 'acme/reviewer-small' },
      ],
    }
    assert.equal(chatSeatModel(crew, 'reviewer'), 'acme/reviewer-small')
    // The slot fallback: no reviewer seat, so the coder answers.
    assert.equal(chatSeatModel(crew, 'tester'), 'acme/coder-small')
  }

  // 11. The addressable names are the six real seats.
  assert.deepEqual(chatAddressNames(), [
    '@architect',
    '@planner',
    '@coder',
    '@tester',
    '@reviewer',
    '@vision',
  ])

  console.log('chat-addressing: PASS')
}

main().catch((err) => { console.error(err); process.exit(1) })

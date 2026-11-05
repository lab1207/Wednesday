# V1.6 Benchmark Harness

Production-shaped benchmark for the integrated Factory path
(**Hermes submit → FactoryService → orchestrator → verification → review**)
against a fixed task, requirements, starting repository, and evaluation rules —
so the same run can be repeated across model/provider revisions (roadmap §9).

## Layout

| Path | Purpose |
|------|---------|
| `types.ts` | Benchmark evidence schema |
| `definitions.ts` | Fixture registry + task spec + evaluation probes |
| `runner.ts` | Copies the fixture, runs via Hermes/FactoryService, records evidence |
| `run-benchmark.ts` | CLI entry point |
| `evaluate.ts` | Comparison table across recorded runs |
| `test.ts` | Deterministic plumbing test (offline) |
| `fixtures/snippetbox/` | Starting repository (shared-notes SaaS, zero-dependency Node app) |

## Run a benchmark

Deterministic plumbing check (offline, no key):

```text
npx tsx factory/benchmark/test.ts
```

Record a run:

```text
# offline sanity — proves the harness; the deterministic coder cannot
# implement the fixture, so this run records a failed red result
npx tsx factory/benchmark/run-benchmark.ts --fixture snippetbox

# real evaluation — needs OPENROUTER_API_KEY in your environment
# (never in chat or the repo)
npx tsx factory/benchmark/run-benchmark.ts --fixture snippetbox --mode live
```

Compare runs:

```text
npx tsx factory/benchmark/evaluate.ts [--fixture snippetbox] [--out <dir>]
```

Output root: `~/.wednesday/benchmarks/<fixture>/<runId>/` (override with `--out`
or `WEDNESDAY_BENCHMARK_HOME`). Each run writes `evidence.json` + `report.md`.

## Evidence recorded per run

- **Run metadata** — fixture/variant, mode, task id, wall time, workspace path
- **Result** — status, summary, files changed, verification tests, orchestrator
  acceptance checks, provider/model
- **Acceptance** — deterministic HTTP evaluation probes (boot the app, probe
  each criterion) + required-file checks + verification pass/fail
- **Regressions** — verification suite re-run on the final workspace
- **Deployment** — boot smoke (`node server/app.js`, poll `/api/health`)
- **Orchestration events** — event counts, repair attempts + reasons, review
  verdict
- **Model usage** — prompt/completion tokens per provider/model, estimated cost
  (null until a model gets a price-table entry in `model-router/usage.ts`)
- **Human interventions** — recorded (0 by design; live runs are unattended)

## Benchmark rule

The starting repository is copied fresh for every run, so the input is
identical across revisions. The task, constraints, acceptance criteria and
evaluation probes are fixed in `definitions.ts`; only the model/provider
changes between runs.

## Known limits / gaps

- **Cost**: token counts are captured from the OpenRouter `usage` field; USD
  cost stays `n/a` until the production model's price is added to the
  `PRICE_PER_MILLION_TOKENS` table in `factory/model-router/usage.ts`. Keys
  never enter the repo, run output, or task records.
- **Review findings / security findings**: the orchestrator publishes only the
  review *verdict* into events, not individual findings. Finding text is a
  documented observability gap for V1.7 (would require persisting reviewer
  output to events).
- **Repair loop**: `FactoryExecutor` verifies internally, so in this pipeline a
  failed coder stage blocks the run before tester/reviewer — repair attempts
  are only meaningful for tester/reviewer failures. The benchmark records
  whatever the integrated path actually does.
- **Clean-machine packaging** (V1.6/V1.7 hardening): live runs execute the DSH
  worker host from the dev tree; standalone packaging must still prove that
  resolution.
/**
 * The provider the ACP worker actually uses (pure).
 *
 * ONE rule, shared by `host.ts` and `cordis.yml`: an explicit
 * `DSH_LLM_PROVIDER` wins. `LOCAL_LLM_BASE_URL` is only a fallback signal when
 * no provider was named.
 *
 * Why this exists (2026-11-05): the worker config used to read
 * `LOCAL_LLM_BASE_URL ? 'local' : (DSH_LLM_PROVIDER ?? 'openrouter')`. The
 * operator's profile keeps a local base URL for the tool proxy even after
 * switching to a hosted route, so EVERY coder run was forced onto the local
 * route while the selected route was OpenRouter/NVIDIA. The local profile then
 * demanded `LOCAL_LLM_API_KEY`, which the host only supplies for an explicit
 * local run — so the coder died with `no credential for provider route
 * "local"` and the card blamed a missing local key after four identical
 * repair attempts.
 */
export function workerProvider(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.DSH_LLM_PROVIDER ?? '').trim().toLowerCase()
  if (explicit) return explicit
  return (env.LOCAL_LLM_BASE_URL ?? '').trim() ? 'local' : 'openrouter'
}

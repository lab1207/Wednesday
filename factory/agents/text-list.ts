/**
 * Coerce a model-supplied list into real strings (2026-11-01, B149).
 *
 * REVIEWER OUTPUT IS UNTRUSTED SHAPE. A small model answers `requiredChanges`
 * with objects (`{"file":"index.html","change":"..."}`) as often as with
 * strings, and every downstream consumer calls string methods on the entries:
 * `.toLowerCase()` in the specialist gate, `.slice()` in the orchestrator's
 * ballot merge. That is the live crash `change.slice is not a function` — the
 * run died at the review stage with its work already written.
 *
 * Zero-dependency on purpose: imported by role-runners (where untrusted JSON
 * enters) AND by the orchestrator (where the arrays are consumed) without
 * creating an import cycle between them.
 */
export function toStringList(value: unknown): string[] {
  // A bare string is still one entry, not a reason to drop the finding.
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim()) out.push(item.trim())
      continue
    }
    if (item === null || item === undefined) continue
    if (typeof item === 'number' || typeof item === 'boolean') {
      out.push(String(item))
      continue
    }
    if (typeof item === 'object') {
      // `{file, change}` / `{file, issue}` / `{path, fix}` — keep what the
      // model said, joined, so the path is not lost from the repair prompt.
      const record = item as Record<string, unknown>
      const path = [record.file, record.path, record.location]
        .find(part => typeof part === 'string' && part.trim()) as string | undefined
      const detail = [
        record.change,
        record.fix,
        record.issue,
        record.requirement,
        record.description,
        record.message,
        record.detail,
      ].find(part => typeof part === 'string' && part.trim()) as string | undefined
      const text = [path?.trim(), detail?.trim()].filter(Boolean).join(': ')
      if (text) {
        out.push(text)
        continue
      }
      try {
        const json = JSON.stringify(item)
        if (json && json !== '{}') out.push(json)
      } catch {
        // Unserialisable entry: dropped rather than thrown.
      }
      continue
    }
    out.push(String(item))
  }
  return out
}

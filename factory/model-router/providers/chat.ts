/**
 * OpenAI-compatible chat content builder (2026-10-16, R-BM-28): text
 * prompts stay strings (byte-identical wire shape); image attachments
 * become content parts beside the text. Pure, offline-testable — the
 * network shape is proven here, providers only carry it.
 */

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** User message content: plain string when imageless, parts otherwise. */
export function userContent(prompt: string, images?: string[]): string | ChatPart[] {
  const clean = (images ?? []).map(url => url.trim()).filter(Boolean)
  if (clean.length === 0) return prompt
  return [
    { type: 'text', text: prompt },
    ...clean.map((url): ChatPart => ({ type: 'image_url', image_url: { url } })),
  ]
}

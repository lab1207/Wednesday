/**
 * One honest line for a body an upstream sent instead of a completion.
 *
 * An OpenAI-compatible endpoint that answers with a full HTML document is a
 * real failure mode, not a curiosity: Cloudflare's 5xx pages, a captive
 * portal, a proxy or gateway login screen. The request DID leave, and
 * something between us and the model answered for it. Every provider used to
 * interpolate `await response.text()` into the error verbatim, so a failed
 * free-model call carried a whole page of markup — which then printed into
 * the operator's stream and buried the one fact that mattered underneath it.
 *
 * The raw text is still recoverable: the error travels into the task record,
 * and `/result <id>` shows it. This function's job is only to make the error
 * message itself readable — status, what answered, and nothing else.
 */

/** Is this body a document (rather than a JSON/text error payload)? */
export function looksLikeHtml(text: string): boolean {
  return /<!doctype\s+html|<html[\s>]|<\/html>|<head[\s>]|<body[\s>]|<p[\s>]|<div[\s>]|<span[\s>]/i.test(text)
}

/**
 * A single line describing an upstream body, safe to embed in an error: an
 * HTML document collapses to what it says in its title, anything else to its
 * first `max` characters with whitespace flattened.
 */
export function describeBody(body: string, max = 200): string {
  const text = body.trim()
  if (!text) return '(empty body)'
  if (looksLikeHtml(text)) {
    const title = /<title[^>]*>([\s\S]{0,120}?)<\/title>/i
      .exec(text)?.[1]
      ?.replace(/\s+/g, ' ')
      .trim()
    return `an HTML page, not a model reply${title ? ` ("${title}")` : ''}`
  }
  const oneLine = text.replace(/\s+/g, ' ')
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

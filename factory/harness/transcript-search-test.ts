/**
 * Offline tests for the transcript search.
 *
 * Pure: the module matches text and says where. The screen draws it.
 */
import assert from 'node:assert/strict'

import { findMatches, normalizeQuery, searchLabel, stripAnsi } from './transcript-search'

async function main(): Promise<void> {
  // 1. The query is LITERAL: `a.b` finds `a.b` and never `axb`.
  {
    const rows = ['the fix: a.b applies', 'nothing to see']
    const hits = findMatches(rows, 'a.b')
    assert.equal(hits.length, 1, 'a literal dot finds the literal dot')
    assert.equal(hits[0]?.segments[0]?.row, 0)
    assert.equal(findMatches(rows, 'axb').length, 0, 'the dot is not a wildcard')
  }

  // 2. It is case-insensitive.
  {
    const hits = findMatches(['Factory Harness'], 'FACTORY')
    assert.equal(hits.length, 1, 'the search ignores case')
  }

  // 3. The escapes are stripped before matching — a styled row still matches.
  {
    const styled = '\x1b[36mviolet\x1b[0m page'
    assert.equal(stripAnsi(styled), 'violet page', 'the escapes are gone')
    const hits = findMatches([styled], 'violet')
    assert.equal(hits.length, 1, 'a styled row still matches')
    assert.equal(hits[0]?.segments[0]?.start, 0, 'the offset counts the TEXT, not the escape bytes')
  }

  // 4. A query that WRAPS across two rows is one hit with two segments.
  {
    const hits = findMatches(['the quick brown', 'fox jumps'], 'brown fox')
    assert.equal(hits.length, 1, 'the wrap is one hit')
    assert.equal(hits[0]?.segments.length, 2, 'the hit has a segment per row')
    assert.equal(hits[0]?.segments[0]?.row, 0)
    assert.equal(hits[0]?.segments[1]?.row, 1)
    assert.equal(hits[0]?.segments[0]?.start, 10, 'the first segment starts where the word is')
    assert.equal(hits[0]?.segments[1]?.end, 3, 'the second segment ends after the word')
  }

  // 5. Every hit is found, in reading order.
  {
    const hits = findMatches(['one two one', 'one'], 'one')
    assert.equal(hits.length, 3, 'every hit is found')
    assert.equal(hits[0]?.segments[0]?.row, 0)
    assert.equal(hits[1]?.segments[0]?.row, 0)
    assert.equal(hits[2]?.segments[0]?.row, 1)
  }

  // 6. An empty query finds nothing, and the label says so.
  {
    assert.equal(findMatches(['anything'], '').length, 0, 'an empty query finds nothing')
    assert.equal(findMatches(['anything'], '   ').length, 0, 'a blank query finds nothing')
    assert.equal(searchLabel(0, 0), 'no matches')
    assert.equal(searchLabel(0, 12), '1/12')
    assert.equal(searchLabel(11, 12), '12/12')
    // An out-of-range index is clamped, never printed as `13/12`.
    assert.equal(searchLabel(99, 12), '12/12')
  }

  // 7. The query is normalised: a stray double space still finds the phrase.
  {
    assert.equal(normalizeQuery('  brown   fox  '), 'brown fox')
    const hits = findMatches(['the brown fox'], 'brown  fox')
    assert.equal(hits.length, 1, 'the whitespace collapses')
  }

  // 8. Nothing found is nothing found — no false positives on a partial word.
  {
    assert.equal(findMatches(['completion'], 'comple').length, 1, 'a prefix is a hit')
    assert.equal(findMatches(['completion'], 'completed').length, 0, 'a longer word is not a hit')
  }

  console.log('TRANSCRIPT SEARCH TEST: PASS (literal, case-insensitive, ANSI-stripped, wrap-crossing, every hit, counter, normalisation)')
}

void main()

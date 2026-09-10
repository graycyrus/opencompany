// Matching and ordering, with no idea what it is matching.
//
// Pure and total: strings in, ranges and scores out. The two jobs here are the
// ones a search gets judged on and the ones easiest to get quietly wrong —
// where a term matched (so it can be highlighted without building HTML) and
// which hit deserves to be first.

import type { MatchRange } from "./types";

/**
 * Every place `term` occurs in `text`, case-insensitively.
 *
 * Offsets into the ORIGINAL string, so the caller slices the text the operator
 * will actually read rather than a lowercased copy of it. That is what keeps
 * highlighting honest: the component renders `text.slice(...)` inside a
 * `<mark>`, and never re-inserts the term as markup — a search box that builds
 * HTML out of user input is one paste away from being an injection.
 *
 * Empty for an empty term: "everything matched" and "nothing was asked" are
 * different answers, and highlighting the whole string is neither.
 */
export function matchRanges(text: string, term: string): MatchRange[] {
  if (!term || !text) return [];
  const haystack = fold(text);
  const needle = fold(term);
  const ranges: MatchRange[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    ranges.push([at, at + needle.length]);
    from = at + needle.length;
    // A pathological term (one character, long text) would otherwise build a
    // range per character. Nothing on screen shows more than a few.
    if (ranges.length >= MAX_RANGES) break;
  }
  return ranges;
}

/** Enough to highlight a line; past this the extra marks say nothing. */
const MAX_RANGES = 20;

/**
 * Case folded **without changing length**, so an offset into the result is an
 * offset into the original.
 *
 * `String.prototype.toLowerCase` is not length-preserving: `"İ".toLowerCase()`
 * is two code units, so every index after one drifts by one and a highlight
 * lands a character late — `İstanbul box` highlighting `ox`. Folding a unit at
 * a time and keeping any that does not fold to exactly one unit costs those
 * few characters their case-insensitivity, which is a far smaller wrong than
 * marking the wrong letters.
 */
function fold(value: string): string {
  let folded = "";
  for (const unit of value) {
    const lower = unit.toLowerCase();
    folded += lower.length === unit.length ? lower : unit;
  }
  return folded;
}

/** Whether `text` contains `term` at all, case-insensitively. */
export function matches(text: string, term: string): boolean {
  if (!term) return true;
  return text.toLowerCase().includes(term.toLowerCase());
}

/**
 * How well `text` answers `term`, higher being better.
 *
 * Three tiers, because they are three genuinely different qualities of hit and
 * an operator can feel the difference:
 *
 * - **Exact** — they typed the whole name. Nothing should outrank it.
 * - **Prefix** — they are typing the name. `gen` should put `general` above
 *   `autumn-general-notes`, which is what makes type-ahead feel like it is
 *   reading along rather than guessing.
 * - **Substring** — it is in there somewhere, and the earlier the better.
 *
 * Shorter text breaks ties within a tier: given two substring hits, the one
 * where the term is more of the whole is the more likely answer.
 *
 * Returns 0 for no match, which callers use as "drop it" — never as a weak hit.
 */
export function score(text: string, term: string): number {
  if (!term) return 1;
  const haystack = fold(text);
  const needle = fold(term);
  const at = haystack.indexOf(needle);
  if (at === -1) return 0;

  if (haystack === needle) return 1000;
  if (at === 0) return 800 - Math.min(haystack.length, 200);
  // Earlier is better, and each character of distance costs one point — so
  // position never outweighs the tier above it.
  return 600 - Math.min(at, 200) - Math.min(haystack.length, 100) / 100;
}

/**
 * The best score across several fields, so a hit on any of them counts.
 *
 * A channel matches on its name or its description; an agent on their name or
 * their role. Taking the max rather than the sum keeps one strong hit ahead of
 * two weak ones.
 */
export function bestScore(fields: readonly (string | null | undefined)[], term: string): number {
  let best = 0;
  for (const field of fields) {
    if (!field) continue;
    const value = score(field, term);
    if (value > best) best = value;
  }
  return best;
}

/**
 * A window of `text` around its first match, for a message or a file body.
 *
 * The match is the point, so the window is placed around it rather than taken
 * from the start — a 400-character message whose only mention of the term is at
 * the end, excerpted from character zero, shows the operator a snippet that
 * does not contain what they searched for.
 *
 * Returns the slice and the ranges *within that slice*, already rebased, so the
 * caller never has to do offset arithmetic to highlight it.
 */
export function excerptAround(
  text: string,
  term: string,
  width = 160,
): { excerpt: string; ranges: MatchRange[] } {
  const collapsed = text.replace(/\s+/g, " ").trim();
  // The term is collapsed too, or a query carrying a double space matches in
  // `score` (which sees the raw text) and then cannot be found here, leaving an
  // unrelated leading excerpt with nothing marked in it.
  term = term.replace(/\s+/g, " ").trim();
  if (!term) {
    return {
      excerpt: collapsed.length > width ? `${collapsed.slice(0, width)}…` : collapsed,
      ranges: [],
    };
  }

  const at = fold(collapsed).indexOf(fold(term));
  if (at === -1) {
    return {
      excerpt: collapsed.length > width ? `${collapsed.slice(0, width)}…` : collapsed,
      ranges: [],
    };
  }

  // A third of the window before the match, so there is context on both sides
  // and the match is not flush against the left edge.
  const lead = Math.floor(width / 3);
  const start = Math.max(0, at - lead);
  const end = Math.min(collapsed.length, start + width);
  const body = collapsed.slice(start, end);
  const excerpt = `${start > 0 ? "…" : ""}${body}${end < collapsed.length ? "…" : ""}`;
  // Ranges come back relative to `body`, and the only thing between `body` and
  // `excerpt` is the leading ellipsis — so that is the whole of the shift.
  const shift = start > 0 ? 1 : 0;
  const ranges = matchRanges(body, term).map(
    ([from, to]) => [from + shift, to + shift] as MatchRange,
  );
  return { excerpt, ranges };
}

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A USD amount is rendered by a renderer, never by hand (issue #2054).
 *
 * # Why this is a test and not a convention
 *
 * PR #2050 made `lib/money.ts` the one renderer for a USD dollar float,
 * precisely because a hand-rolled `` `$${v.toFixed(2)}` `` reports a real
 * sub-cent charge as `$0.00` — it says *free* about money that was actually
 * spent. That PR swept the console and missed
 * `views/observatory/AnalyticsLens.tsx`, whose cost axis kept formatting its
 * own dollars; the Observatory chart read `$0.00` while Finance, one click
 * away, read `<$0.01` for the same number.
 *
 * So the same call site has now been missed twice by a sweep done by reading.
 * The third time is what this file exists to prevent. A sweep is a snapshot of
 * one afternoon; a test is the sweep run again on every commit, and it does not
 * get tired or decide a chart axis is not really money.
 *
 * # What counts as hand-rolling
 *
 * Three shapes, each one a way the console has actually rendered or could
 * render a dollar figure without going through a renderer:
 *
 *   - a literal `$` glued to an interpolation — `` `$${amount.toFixed(2)}` ``,
 *     which is the exact line this issue is about;
 *   - a `"$"` concatenated onto a number, the same thing written with `+`;
 *   - a second `Intl` currency formatter, which is how two call sites come to
 *     disagree about precision while both looking correct in review.
 *
 * # The renderers themselves are exempt, and there are exactly three
 *
 * They are named here rather than pattern-matched so that adding a fourth is a
 * decision someone makes in this file, with the argument written down, instead
 * of a file that quietly happens to be called `money.ts`. `lib/money.ts`'s own
 * doc comment already explains why the other two are deliberately not merged
 * into it: token cost is legitimately sub-cent and carries four-digit line
 * precision, and the finance ledger holds integer minor units in an arbitrary
 * currency whose digit count is asked of `Intl` per currency.
 */
const RENDERERS = new Set([
  // The one renderer for a USD dollar float (#2050).
  "lib/money.ts",
  // LLM token cost: sub-cent by nature, four-digit line precision.
  "lib/cost.ts",
  // Integer minor units in an arbitrary currency.
  "views/finance/money.ts",
]);

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

/** Every `.ts`/`.tsx` under `src`, as paths relative to it. */
function sources(dir = SRC, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return sources(join(dir, entry.name), rel);
    return /\.tsx?$/.test(entry.name) ? [rel] : [];
  });
}

/**
 * `source` with its comments removed.
 *
 * A doc comment that *names* the anti-pattern must not count as the
 * anti-pattern — this file's own header would fail itself otherwise, and so
 * would `lib/money.ts`'s. Block comments are stripped whole; `//` only when it
 * opens the line, so a `//` inside a string literal cannot blind the scan to
 * real code after it.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

const HAND_ROLLED: { readonly what: string; readonly pattern: RegExp }[] = [
  {
    what: "a literal `$` glued to an interpolation",
    pattern: /\$\$\{/,
  },
  {
    what: "a `\"$\"` concatenated onto a value",
    pattern: /["']\$["']\s*\+|\+\s*["']\$["']/,
  },
  {
    what: "a second Intl currency formatter",
    pattern: /currency:\s*["'][A-Z]{3}["']/,
  },
];

describe("USD is rendered by a renderer", () => {
  it("finds the console's source to scan", () => {
    // Guards the scan itself: a walk that silently returned nothing would make
    // every case below pass while checking no file at all, which is the failure
    // mode of every grep-shaped test.
    const files = sources();
    expect(files.length).toBeGreaterThan(200);
    for (const renderer of RENDERERS) {
      expect(files, `${renderer} is allow-listed but does not exist`).toContain(renderer);
    }
  });

  it("has no hand-rolled dollar formatting outside the three renderers", () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      if (RENDERERS.has(file)) continue;
      const body = code(readFileSync(join(SRC, file), "utf8"));
      for (const { what, pattern } of HAND_ROLLED) {
        if (pattern.test(body)) offenders.push(`src/${file}: ${what}`);
      }
    }
    expect(
      offenders,
      "Render the amount with `usd` from `@/lib/money` instead. A hand-rolled " +
        "`$${v.toFixed(2)}` reports a real sub-cent charge as `$0.00`, which is " +
        "how the Observatory cost axis came to say free about money that was " +
        "spent. If a new renderer is genuinely warranted, add it to RENDERERS " +
        "with the reason.",
    ).toEqual([]);
  });

  it("still catches the line this issue is about", () => {
    // The guard is only worth having if it fails on the original. Asserted
    // against the pattern rather than against the fixed file, so this stays
    // true after the fix.
    const original = "tickFormatter={(v: number) => `$${v.toFixed(2)}`}";
    expect(HAND_ROLLED.some(({ pattern }) => pattern.test(original))).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ACCENT_CONTRAST_BAR, evaluateAccentRamp } from "@/lib/accent-contrast";
import { ACCENT_STEPS, generateCustomRamp, type AccentRamp } from "@/lib/accent-ramp";

/**
 * The contrast gate (issue #2493, test-plan U4). Every curated accent preset —
 * and the default ramp in `:root` — must clear the same five pairs
 * `docs/design-system/color.md`'s "Accent presets" table documents, at 4.5:1.
 * This is the gate, not a reviewer's eye: a preset that cannot pass belongs in
 * `open-questions.md`, not in `index.css`.
 *
 * The colour math and the five pairs live in one place now,
 * `@/lib/accent-contrast`'s `evaluateAccentRamp` — imported here rather than
 * reimplemented, per `docs/issues/accent-theme-presets/theme-system-decision.md`'s
 * requirement that the test and the live "Customize" picker share a single
 * implementation, so a hue the picker refuses is refused for the same reason
 * this test would have failed it.
 *
 * Deliberately NOT asserted: `--brand-500` on `--accent` or `--chrome`. The
 * default ramp already misses both (4.20:1, 4.22:1) — a pre-existing gap this
 * test does not widen. See `roadblocks.md` R12 and
 * `docs/design-system/color.md`'s "Accent presets" section.
 */

const indexCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../src/index.css"),
  "utf8",
);

/** `--brand-<step>: oklch(L C H); …` -> { L, C, H }, for the given block body. */
function ramp(body: string): AccentRamp {
  const out: Record<number, { L: number; C: number; H: number }> = {};
  for (const step of ACCENT_STEPS) {
    const m = new RegExp(`--brand-${step}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(body);
    if (!m) throw new Error(`--brand-${step} not found in block`);
    out[step] = { L: Number(m[1]), C: Number(m[2]), H: Number(m[3]) };
  }
  return out as AccentRamp;
}

function blockBody(marker: string): string {
  const open = indexCss.indexOf(marker);
  if (open < 0) throw new Error(`marker not found: ${marker}`);
  const braceOpen = indexCss.indexOf("{", open);
  let depth = 0;
  for (let i = braceOpen; i < indexCss.length; i += 1) {
    if (indexCss[i] === "{") depth += 1;
    else if (indexCss[i] === "}") {
      depth -= 1;
      if (depth === 0) return indexCss.slice(braceOpen, i);
    }
  }
  throw new Error(`unterminated block: ${marker}`);
}

const rampsToCheck: Array<{ name: string; body: string }> = [
  { name: "default (:root)", body: blockBody(":root {") },
  ...["violet", "indigo", "blue", "teal", "green", "amber", "rose", "graphite"].map((id) => ({
    name: id,
    body: blockBody(`[data-accent-preset="${id}"] {`),
  })),
];

describe.each(rampsToCheck)("accent preset contrast: $name", ({ body }) => {
  const evaluation = evaluateAccentRamp(ramp(body));

  it("keeps every ramp step in sRGB gamut", () => {
    expect(evaluation.inGamut).toBe(true);
  });

  it("clears 4.5:1 white text on 500", () => {
    expect(evaluation.ratios.whiteOn500).toBeGreaterThanOrEqual(ACCENT_CONTRAST_BAR);
  });

  it("clears 4.5:1 for 500 on the light canvas", () => {
    expect(evaluation.ratios.c500OnLightCanvas).toBeGreaterThanOrEqual(ACCENT_CONTRAST_BAR);
  });

  it("clears 4.5:1 for 400 on the dark canvas", () => {
    expect(evaluation.ratios.c400OnDarkCanvas).toBeGreaterThanOrEqual(ACCENT_CONTRAST_BAR);
  });

  it("clears 4.5:1 for 700 on 100 (the active nav row)", () => {
    expect(evaluation.ratios.c700On100).toBeGreaterThanOrEqual(ACCENT_CONTRAST_BAR);
  });

  it("clears 4.5:1 for 300 on the dark active rung", () => {
    expect(evaluation.ratios.c300OnDarkActiveRung).toBeGreaterThanOrEqual(ACCENT_CONTRAST_BAR);
  });
});

/**
 * The "Customize" hue ramp (`@/lib/accent-ramp`'s `generateCustomRamp`), fuzzed
 * across the hue circle rather than checked at the 9 fixed presets above —
 * `theme-system-decision.md`'s explicit ask, since a custom hue is exactly
 * the input this gate did not used to see.
 */
describe("custom hue ramp", () => {
  const CURATED_ANCHORS: Array<{ name: string; hue: number }> = [
    { name: "rose", hue: 15.0 },
    { name: "amber", hue: 55.0 },
    { name: "green", hue: 145.0 },
    { name: "teal", hue: 195.0 },
    { name: "blue", hue: 255.0 },
    { name: "indigo", hue: 268.0 },
    { name: "violet", hue: 285.51 },
  ];

  describe.each(CURATED_ANCHORS)("reproduces the curated $name ramp at its own hue", ({ name, hue }) => {
    const curated = ramp(blockBody(`[data-accent-preset="${name}"] {`));
    const generated = generateCustomRamp(hue);

    it("matches every step's L, C and H within rounding tolerance", () => {
      for (const step of ACCENT_STEPS) {
        expect(generated[step].L, `step ${step} L`).toBeCloseTo(curated[step].L, 3);
        expect(generated[step].C, `step ${step} C`).toBeCloseTo(curated[step].C, 3);
        expect(generated[step].H, `step ${step} H`).toBeCloseTo(curated[step].H, 1);
      }
    });

    it("still clears every gamut and contrast bar the curated preset does", () => {
      expect(evaluateAccentRamp(generated).ok).toBe(true);
    });
  });

  // `violet` is also `:root`'s own ramp, so its exact hue is the one every
  // fresh "Custom" tile opens to (`DEFAULT_CUSTOM_HUE`, `accent-presets.ts`) —
  // pinned here too, redundantly with the anchor check above, because a
  // regression here is exactly what would put a visible flash into the very
  // first time an operator opens the slider.
  it("previews as violet at hue 285.51, violet's own hue", () => {
    const violet = ramp(blockBody('[data-accent-preset="violet"] {'));
    const generated = generateCustomRamp(285.51);
    expect(generated[500].L).toBeCloseTo(violet[500].L, 3);
    expect(generated[500].C).toBeCloseTo(violet[500].C, 3);
  });

  it("refuses a hue from the yellow/yellow-green band (90°) — the true sRGB gamut boundary there dips well below what a straight interpolation between amber (55°) and green (145°) assumes", () => {
    const evaluation = evaluateAccentRamp(generateCustomRamp(90));
    expect(evaluation.ok).toBe(false);
  });

  it("accepts a hue close to a curated anchor (rose-adjacent, 10°)", () => {
    const evaluation = evaluateAccentRamp(generateCustomRamp(10));
    expect(evaluation.ok).toBe(true);
  });

  it("accepts hues right at the 0°/360° wrap, with no discontinuity", () => {
    const at0 = evaluateAccentRamp(generateCustomRamp(0));
    const at360 = evaluateAccentRamp(generateCustomRamp(360));
    const at359 = evaluateAccentRamp(generateCustomRamp(359.9));
    expect(at0.ok).toBe(true);
    expect(at360.ok).toBe(true);
    // 0 and 360 are the same hue; the ramp must be identical, not just both "ok".
    const ramp0 = generateCustomRamp(0);
    const ramp360 = generateCustomRamp(360);
    for (const step of ACCENT_STEPS) {
      expect(ramp360[step].L).toBeCloseTo(ramp0[step].L, 9);
      expect(ramp360[step].C).toBeCloseTo(ramp0[step].C, 9);
      expect(ramp360[step].H).toBeCloseTo(ramp0[step].H, 9);
    }
    expect(at359.ok).toBe(true);
  });

  it("sweeps the full hue circle without throwing, and is neither vacuously all-pass nor all-fail", () => {
    let passCount = 0;
    let failCount = 0;
    for (let hue = 0; hue < 360; hue += 1) {
      const evaluation = evaluateAccentRamp(generateCustomRamp(hue));
      if (evaluation.ok) passCount += 1;
      else failCount += 1;
    }
    expect(passCount + failCount).toBe(360);
    // A constrained customize control is expected to refuse a real portion of
    // the wheel (the decision doc's whole point — interpolation is not a
    // gamut solver) but must not refuse everything, and the violet/rose/blue
    // neighbourhood the brand already lives in must stay usable.
    expect(passCount).toBeGreaterThan(100);
    expect(failCount).toBeGreaterThan(50);
  });
});

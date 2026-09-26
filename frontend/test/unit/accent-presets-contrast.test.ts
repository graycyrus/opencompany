import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The contrast gate (issue #2493, test-plan U4). Every accent preset — and
 * the default ramp in `:root` — must clear the same five pairs
 * `docs/design-system/color.md`'s "Accent presets" table documents, at 4.5:1.
 * This is the gate, not a reviewer's eye: a preset that cannot pass belongs in
 * `open-questions.md`, not in `index.css`.
 *
 * Colour math: Björn Ottosson's published oklch → oklab → linear sRGB
 * matrices, and the WCAG 2.1 relative-luminance formula
 * `docs/design-system/color.md:11-17` already uses — reimplemented here
 * rather than imported, because production code (`accent-presets.ts`)
 * deliberately carries no colour math or colour literals at all
 * (`architecture.md` §5, §11).
 *
 * Deliberately NOT asserted: `--brand-500` on `--accent` or `--chrome`. The
 * default ramp already misses both (4.20:1, 4.22:1) — a pre-existing gap this
 * test does not widen. See `roadblocks.md` R12 and
 * `docs/design-system/color.md`'s "Accent presets" section.
 */

function oklchToLinearSrgb(L: number, C: number, Hdeg: number): [number, number, number] {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b2 = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [r, g, b2];
}

function linearToSrgb(c: number): number {
  const cl = Math.min(1, Math.max(0, c));
  return cl <= 0.0031308 ? 12.92 * cl : 1.055 * cl ** (1 / 2.4) - 0.055;
}

interface Resolved {
  hex: string;
  inGamut: boolean;
}

function oklchToHex(L: number, C: number, H: number): Resolved {
  const [r, g, b] = oklchToLinearSrgb(L, C, H);
  const inGamut = [r, g, b].every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  const hex =
    "#" +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(linearToSrgb(v) * 255))))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
  return { hex, inGamut };
}

function lin(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const [r, g, b] = (hex.match(/\w\w/g) as string[]).map((x) => lin(parseInt(x, 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const indexCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../src/index.css"),
  "utf8",
);

/** `--brand-<step>: oklch(L C H); …` -> { L, C, H }, for the given block body. */
function ramp(body: string): Record<number, { L: number; C: number; H: number }> {
  const out: Record<number, { L: number; C: number; H: number }> = {};
  for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
    const m = new RegExp(`--brand-${step}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(body);
    if (!m) throw new Error(`--brand-${step} not found in block`);
    out[step] = { L: Number(m[1]), C: Number(m[2]), H: Number(m[3]) };
  }
  return out;
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

const DARK_ACTIVE_RUNG_HEX = "#1e1e28"; // --surface-dark-active, index.css
const LIGHT_CANVAS_HEX = "#f7f7fc"; // --surface-light-bg
const DARK_CANVAS_HEX = "#08090b"; // --surface-dark-bg
const WHITE_HEX = "#ffffff";
const BAR = 4.5;

const rampsToCheck: Array<{ name: string; body: string }> = [
  { name: "default (:root)", body: blockBody(":root {") },
  ...["violet", "indigo", "blue", "teal", "green", "amber", "rose", "graphite"].map((id) => ({
    name: id,
    body: blockBody(`[data-accent-preset="${id}"] {`),
  })),
];

describe.each(rampsToCheck)("accent preset contrast: $name", ({ body }) => {
  const steps = ramp(body);
  const hex = (step: number) => {
    const { L, C, H } = steps[step];
    const resolved = oklchToHex(L, C, H);
    return resolved;
  };

  it("keeps every ramp step in sRGB gamut", () => {
    for (const step of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      expect(hex(step).inGamut, `step ${step} is out of sRGB gamut`).toBe(true);
    }
  });

  it("clears 4.5:1 white text on 500", () => {
    expect(contrastRatio(WHITE_HEX, hex(500).hex)).toBeGreaterThanOrEqual(BAR);
  });

  it("clears 4.5:1 for 500 on the light canvas", () => {
    expect(contrastRatio(hex(500).hex, LIGHT_CANVAS_HEX)).toBeGreaterThanOrEqual(BAR);
  });

  it("clears 4.5:1 for 400 on the dark canvas", () => {
    expect(contrastRatio(hex(400).hex, DARK_CANVAS_HEX)).toBeGreaterThanOrEqual(BAR);
  });

  it("clears 4.5:1 for 700 on 100 (the active nav row)", () => {
    expect(contrastRatio(hex(700).hex, hex(100).hex)).toBeGreaterThanOrEqual(BAR);
  });

  it("clears 4.5:1 for 300 on the dark active rung", () => {
    expect(contrastRatio(hex(300).hex, DARK_ACTIVE_RUNG_HEX)).toBeGreaterThanOrEqual(BAR);
  });
});

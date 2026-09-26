/**
 * The accent-ramp contrast/gamut gate — issue #2493's original five pairs
 * (`docs/design-system/color.md`'s "Accent presets" table), as one shared
 * implementation used both by `accent-presets-contrast.test.ts` (which also
 * fuzzes a range of custom hues through it) and by the live "Customize" hue
 * picker (`docs/issues/accent-theme-presets/theme-system-decision.md`), so a
 * hue that cannot pass is refused live, not just caught at commit time.
 *
 * Colour math: Björn Ottosson's published oklch → oklab → linear sRGB
 * matrices, and the WCAG 2.1 relative-luminance formula
 * `docs/design-system/color.md:11-17` already documents — the same
 * implementation `accent-presets-contrast.test.ts` used to carry on its own
 * before this module existed. Every anchor colour below is read from
 * `index.css`'s own `:root` primitives as OKLCH triples, never as a hex or
 * `rgb()`/`oklch()` string literal: `scripts/ci/assert-design-tokens.sh` bans
 * raw hex in `frontend/src/**\/*.ts(x)`, and resolving through the same
 * `oklch -> rgb255` pipeline as every ramp step keeps this file needing no
 * exemption from that gate, and no second colour representation to drift.
 */

import { ACCENT_STEPS, type AccentRamp, type AccentRampStep } from "@/lib/accent-ramp";

/** oklch -> linear sRGB, Björn Ottosson's published matrices. */
function oklchToLinearSrgb(L: number, C: number, hueDeg: number): [number, number, number] {
  const h = (hueDeg * Math.PI) / 180;
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
  const clamped = Math.min(1, Math.max(0, c));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/** A ramp step resolved to 8-bit sRGB, plus whether it landed in gamut before clamping. */
export interface ResolvedAccentColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly inGamut: boolean;
}

/** Resolves one OKLCH triple — a ramp step, or a `:root` anchor primitive. */
export function resolveAccentColor(step: AccentRampStep): ResolvedAccentColor {
  const [r, g, b] = oklchToLinearSrgb(step.L, step.C, step.H);
  const inGamut = [r, g, b].every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  const [r255, g255, b255] = [r, g, b].map((v) =>
    Math.max(0, Math.min(255, Math.round(linearToSrgb(v) * 255))),
  );
  return { r: r255, g: g255, b: b255, inGamut };
}

function linearFromByte(byte: number): number {
  const v = byte / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: ResolvedAccentColor): number {
  return 0.2126 * linearFromByte(color.r) + 0.7152 * linearFromByte(color.g) + 0.0722 * linearFromByte(color.b);
}

/** WCAG 2.1 contrast ratio between two resolved colours. */
export function accentContrastRatio(a: ResolvedAccentColor, b: ResolvedAccentColor): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Pure white text — the foreground every filled brand surface uses. */
const WHITE: ResolvedAccentColor = { r: 255, g: 255, b: 255, inGamut: true };

// The three canvas/rung anchors, as the exact OKLCH triples `index.css`'s
// `:root` block declares them (never re-typed as hex): `--surface-light-bg`,
// `--surface-dark-bg`, `--surface-dark-active`.
const LIGHT_CANVAS = resolveAccentColor({ L: 0.9776, C: 0.0066, H: 286.28 });
const DARK_CANVAS = resolveAccentColor({ L: 0.1395, C: 0.0048, H: 262.8 });
const DARK_ACTIVE_RUNG = resolveAccentColor({ L: 0.2396, C: 0.019, H: 284.87 });

/** The bar every pair below must clear — `docs/design-system/color.md`'s AA text target. */
export const ACCENT_CONTRAST_BAR = 4.5;

/** The same five pairs `accent-presets-contrast.test.ts` has run since issue #2493. */
export interface AccentContrastRatios {
  readonly whiteOn500: number;
  readonly c500OnLightCanvas: number;
  readonly c400OnDarkCanvas: number;
  readonly c700On100: number;
  readonly c300OnDarkActiveRung: number;
}

export interface AccentContrastResult {
  /** Every one of the ten steps resolved inside the sRGB gamut before 8-bit clamping. */
  readonly inGamut: boolean;
  /** Every one of the five pairs cleared `ACCENT_CONTRAST_BAR`. */
  readonly contrastOk: boolean;
  /** `inGamut && contrastOk` — the single yes/no the picker gates on. */
  readonly ok: boolean;
  readonly ratios: AccentContrastRatios;
}

/**
 * Evaluates a full ten-step ramp against the gamut check and the five
 * contrast pairs — the one function both the test and the live "Customize"
 * picker call, so neither can silently drift from the other.
 */
export function evaluateAccentRamp(ramp: AccentRamp): AccentContrastResult {
  const resolved = {} as Record<(typeof ACCENT_STEPS)[number], ResolvedAccentColor>;
  let inGamut = true;
  for (const step of ACCENT_STEPS) {
    const color = resolveAccentColor(ramp[step]);
    resolved[step] = color;
    if (!color.inGamut) inGamut = false;
  }

  const ratios: AccentContrastRatios = {
    whiteOn500: accentContrastRatio(WHITE, resolved[500]),
    c500OnLightCanvas: accentContrastRatio(resolved[500], LIGHT_CANVAS),
    c400OnDarkCanvas: accentContrastRatio(resolved[400], DARK_CANVAS),
    c700On100: accentContrastRatio(resolved[700], resolved[100]),
    c300OnDarkActiveRung: accentContrastRatio(resolved[300], DARK_ACTIVE_RUNG),
  };
  const contrastOk = Object.values(ratios).every((ratio) => ratio >= ACCENT_CONTRAST_BAR);

  return { inGamut, contrastOk, ok: inGamut && contrastOk, ratios };
}

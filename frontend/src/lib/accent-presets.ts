/**
 * The operator's accent preset — a curated hue for `--brand-*`, independent of
 * light/dark mode (issue #2493).
 *
 * # Why "preset" and never "accent" alone
 *
 * `--accent` already names something else in this codebase (the neutral
 * hover/rest tint under menu rows, `index.css:236-242`), and `--sidebar-accent`
 * and `.oc-kg`'s own `--accent` name two more. So everywhere in code this
 * feature is the **accent preset**: this module, the `data-accent-preset`
 * attribute, the `oc.appearance.accentPreset` storage key. The user-facing
 * label can still say "Accent" — `AppearanceView.tsx` does — because an
 * operator never sees the other three.
 *
 * # No colour lives here
 *
 * Every value is in `frontend/src/index.css`'s `ACCENT PRESETS` section, one
 * `[data-accent-preset="<id>"] { --brand-50: …; … }` block per preset. This
 * file carries only ids and labels, on purpose: `scripts/ci/assert-design-
 * tokens.sh` bans raw hex and Tailwind palette classes from `.ts`/`.tsx`, and
 * keeping colour out entirely means this file needs no exemption to pass it —
 * unlike `frontend/src/lib/connections.ts`, whose third-party brand hexes have
 * nowhere else to live. See `docs/issues/accent-theme-presets/architecture.md`
 * §5 and §11 for the reasoning in full, and §9 for why every preset here is
 * measured against the same contrast bars the default ramp meets
 * (`frontend/test/unit/accent-presets-contrast.test.ts`).
 */

import { useSyncExternalStore } from "react";

/** One curated accent preset. Colours live in `index.css`, never here. */
export interface AccentPreset {
  /**
   * Stable id: the `data-accent-preset` attribute value and the exact string
   * persisted to `localStorage`. Ids are never renamed — like the `TEAM_TONES`
   * slot names (`docs/design-system/color.md`, "Legacy slot names"), an id
   * already sitting in someone's browser has to keep resolving. Retiring a
   * preset means removing its entry and its CSS block; a stored id that no
   * longer matches any entry falls back to the default (`readStoredAccentPreset`).
   */
  readonly id: string;
  /** What the picker shows. */
  readonly label: string;
}

/**
 * The id that means "no override" — `:root`'s own ramp, whatever it declares.
 * Selecting it **removes** `data-accent-preset` rather than setting it to this
 * string; it has no CSS block of its own. See `architecture.md` §2.
 */
export const DEFAULT_ACCENT_PRESET = "default";

/**
 * The curated set, target 6–8 per `open-questions.md` Q5. "Violet" is a
 * deliberate twin of whatever `:root` currently declares (`architecture.md`
 * §2's Q1 follow-up: naming today's default now keeps it choosable later, if
 * a future brand decision ever moves the default away from violet). Six more
 * are spread around the hue circle, and "Graphite" is the deliberate
 * exception: chroma zero at every step, for the premium monochrome look
 * requested alongside this feature from the start — a hue choice would defeat
 * that, so it is the one preset with no hue at all. Every preset here is
 * individually verified against every pair in `docs/design-system/color.md`'s
 * contrast table — see the `ACCENT PRESETS` section of `index.css` for the
 * measured ratios in each preset's leading comment, and
 * `accent-presets-contrast.test.ts` for the test that keeps them honest.
 */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: DEFAULT_ACCENT_PRESET, label: "Default" },
  { id: "violet", label: "Violet" },
  { id: "indigo", label: "Indigo" },
  { id: "blue", label: "Blue" },
  { id: "teal", label: "Teal" },
  { id: "green", label: "Green" },
  { id: "amber", label: "Amber" },
  { id: "rose", label: "Rose" },
  { id: "graphite", label: "Graphite" },
];

/** `oc.<area>.<name>` — the convention `oc.connections.v1`, `oc.presence.override`
 *  and `oc.workspace.listWidth` already use. Deliberately not `next-themes`'
 *  own `"theme"` key: the two axes (mode, accent) are independent and must
 *  never collide. */
export const ACCENT_PRESET_STORAGE_KEY = "oc.appearance.accentPreset";

function isKnownPreset(id: string): boolean {
  return ACCENT_PRESETS.some((p) => p.id === id);
}

/** The stored preset id, or the default when nothing valid is stored.
 *  Never throws: a private window or blocked site data makes the
 *  `localStorage` getter itself throw (`crash-fallback.tsx` makes the same
 *  point), and an unknown id — a preset retired since it was chosen — must
 *  fall back rather than leave a dead attribute on `<html>`. */
export function readStoredAccentPreset(): string {
  try {
    const stored = window.localStorage.getItem(ACCENT_PRESET_STORAGE_KEY);
    return stored && isKnownPreset(stored) ? stored : DEFAULT_ACCENT_PRESET;
  } catch {
    return DEFAULT_ACCENT_PRESET;
  }
}

/**
 * Sets `data-accent-preset` on `<html>` — the same element `:root` and
 * `next-themes`' `.dark` both match (`architecture.md` §3). The default
 * removes the attribute rather than setting it to `"default"`, so a browser
 * with nothing stored and one that has explicitly chosen "Default" render
 * identically: `:root`'s own values, un-overridden.
 *
 * Never a semantic utility, and never on `#root` or `<body>`: a custom
 * property that references another (`--primary: var(--brand-500)`) resolves
 * on the element where the *reference* is declared, not where it is read, so
 * the attribute has to sit on the same element as the semantic layer itself
 * (`roadblocks.md` R4).
 */
export function applyAccentPreset(id: string): void {
  const root = document.documentElement;
  if (id === DEFAULT_ACCENT_PRESET || !isKnownPreset(id)) {
    delete root.dataset.accentPreset;
  } else {
    root.dataset.accentPreset = id;
  }
}

/** Reads storage and applies it — the one call `main.tsx` makes, synchronously
 *  and before `mount()`, so the chosen preset is already on `<html>` for
 *  React's first commit. No inline `<script>`: React makes a client-rendered
 *  one inert (`roadblocks.md` R1), so `next-themes`' own anti-flash trick does
 *  not work in this SPA and copying it here would silently do nothing. No
 *  static `public/` file either: those are served `immutable` for a year
 *  (`roadblocks.md` R3). This function lives in the hashed app bundle instead,
 *  which is what makes it reach a returning browser at all. */
export function applyStoredAccentPreset(): void {
  applyAccentPreset(readStoredAccentPreset());
}

let listeners: Array<() => void> = [];

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

/** The id `useAccentPreset` should currently report: the live `dataset`
 *  attribute when one is set, `"default"` otherwise. Reading the DOM rather
 *  than a module-level variable is what keeps this correct even though
 *  `applyStoredAccentPreset` runs before any React state exists to seed it. */
function getSnapshot(): string {
  return document.documentElement.dataset.accentPreset ?? DEFAULT_ACCENT_PRESET;
}

/** Same value on the server as the client would compute before hydration —
 *  irrelevant here (this app has no SSR pass), kept only because
 *  `useSyncExternalStore` requires a third argument. */
function getServerSnapshot(): string {
  return DEFAULT_ACCENT_PRESET;
}

/**
 * Persists `id`, applies it, and notifies every `useAccentPreset()` caller —
 * including ones in other tabs, via the `storage` event listener armed below.
 * A `localStorage` write failing (storage disabled, quota) still applies the
 * choice for this tab; it just will not survive a reload.
 */
export function setAccentPreset(id: string): void {
  try {
    if (id === DEFAULT_ACCENT_PRESET) {
      window.localStorage.removeItem(ACCENT_PRESET_STORAGE_KEY);
    } else {
      window.localStorage.setItem(ACCENT_PRESET_STORAGE_KEY, id);
    }
  } catch {
    // Storage refused; the choice still holds for this tab.
  }
  applyAccentPreset(id);
  emit();
}

if (typeof window !== "undefined") {
  // Cross-tab sync, the same shape `next-themes` uses for its own key: a
  // `storage` event only fires in tabs that did NOT make the write, and only
  // for the one key it names — a `"theme"` change must never re-apply an
  // accent preset, and vice versa.
  window.addEventListener("storage", (event) => {
    if (event.key !== ACCENT_PRESET_STORAGE_KEY) return;
    applyStoredAccentPreset();
    emit();
  });
}

/** The live accent preset id, reactive across this tab and every other one on
 *  the same origin. `useSyncExternalStore` rather than `useState`: the true
 *  state is the DOM attribute `applyStoredAccentPreset` already set before
 *  React existed, and mirroring it into a second, React-owned copy is exactly
 *  the kind of drift a module-level store (`src/connections/registry.ts` uses
 *  the same pattern) avoids. */
export function useAccentPreset(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

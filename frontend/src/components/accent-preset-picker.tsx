import { Check } from "lucide-react";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";

import { cn } from "@/lib/utils";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT_PRESET,
  setAccentPreset,
  useAccentPreset,
  type AccentPreset,
} from "@/lib/accent-presets";

/**
 * What the Default swatch paints itself with.
 *
 * `DEFAULT_ACCENT_PRESET` deliberately has no `[data-accent-preset="default"]`
 * block in `index.css` (`architecture.md` §2, `accent-presets-registry.test.ts`
 * pins that it never gains one) — selecting it means "remove the attribute",
 * not "apply a block named default". A swatch carrying
 * `data-accent-preset="default"` would therefore have nothing to resolve
 * against and silently inherit whatever preset happens to be active on
 * `<html>` — wrong for exactly the same reason `bg-primary` is wrong (below).
 *
 * `"violet"` is the fix: its block is authored to hold the *exact* values
 * `:root` itself declares (see its comment in `index.css`), so painting the
 * Default swatch with it is indistinguishable from painting it with the true
 * default — without needing a block that the registry test says must not
 * exist.
 */
const DEFAULT_SWATCH_PRESET_ID = "violet";

/**
 * The accent-preset picker — a `role="radiogroup"` of named swatches, one per
 * `AccentPreset`. See `docs/issues/accent-theme-presets/architecture.md` §10.
 *
 * # Why each swatch paints with `bg-brand-500`, never `bg-primary`
 *
 * `--primary: var(--brand-500)` resolves against whatever `data-accent-preset`
 * `<html>` currently carries — that is the whole point of the feature — so a
 * swatch styled with `bg-primary` would show the *page's* preset on every
 * swatch instead of its own (`roadblocks.md` R4). `bg-brand-500` emits
 * `var(--brand-500)` directly, which each swatch's own `data-accent-preset`
 * attribute (set on itself, not inherited from `<html>`) resolves correctly.
 *
 * # Why `RadioGroup`/`Radio` from `@base-ui/react` rather than hand-rolled
 *
 * Arrow-key roving focus, `aria-checked`, and `role="radiogroup"` /
 * `role="radio"` all come from the primitive rather than being re-implemented
 * here — the same library `Switch` (`components/ui/switch.tsx`) already uses.
 */
export function AccentPresetPicker() {
  const current = useAccentPreset();

  return (
    <RadioGroup
      aria-label="Accent preset"
      value={current}
      onValueChange={(value) => setAccentPreset(value as string)}
      className="grid grid-cols-4 gap-2 sm:grid-cols-8"
    >
      {ACCENT_PRESETS.map((preset) => (
        <PresetSwatch key={preset.id} preset={preset} />
      ))}
    </RadioGroup>
  );
}

function PresetSwatch({ preset }: { preset: AccentPreset }) {
  const swatchPresetId = preset.id === DEFAULT_ACCENT_PRESET ? DEFAULT_SWATCH_PRESET_ID : preset.id;
  return (
    <Radio.Root
      value={preset.id}
      data-accent-preset={swatchPresetId}
      className="group/swatch flex flex-col items-center gap-1.5 rounded-lg p-1.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span
        className={cn(
          "relative flex size-9 items-center justify-center rounded-full bg-brand-500 ring-1 ring-inset ring-black/10 transition-transform group-data-checked/swatch:scale-110 dark:bg-brand-400 dark:ring-white/10",
        )}
      >
        {/* `data-checked` comes from `Radio.Root`'s own state, not from a
            second read of `current` — one source of truth for "is this the
            selected preset". */}
        <Check
          className="size-4 text-white opacity-0 transition-opacity group-data-checked/swatch:opacity-100 dark:text-black"
          aria-hidden="true"
        />
      </span>
      {/* Colour must not be the only cue (WCAG 1.4.1) — the label is always
          visible text, never a tooltip-only affordance. */}
      <span className="text-2xs text-muted-foreground group-data-checked/swatch:text-foreground">
        {preset.label}
      </span>
    </Radio.Root>
  );
}

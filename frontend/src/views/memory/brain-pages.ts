// The Brain section's sub-page table, and the helpers that read it.
//
// A leaf module, exactly as `views/connection-pages.ts`, `views/settings-pages.ts`
// and `views/finance/finance-pages.ts` are, and for the same reason: the nav
// table has to name these pages, and a static import of `MemoryView` from there
// would pull the whole memory browser — its virtual list, its dialogs, its
// engine section — into a module the sidebar renders on every route.
//
// # Why Brain is three pages
//
// It was one, and the page was three unrelated jobs stacked in a column: the
// engine picker, then the drop zone, then the browser. An operator arriving to
// answer "does it already know this" — which is what this surface is for, and
// the reason it left the settings rail (issue #1416) — scrolled past a
// provider form and an upload target to reach it, every time.
//
// The three do not even change at the same rate. The engine is set once and
// then almost never; an upload happens when a document arrives; the browser is
// read constantly. One page meant the rarest control sat on top of the most
// frequent one.

import { Cog, FileUp, Brain as BrainIcon, type LucideIcon } from "lucide-react";

/**
 * The sub-pages under Brain. The id is the third hash segment —
 * `#/company/brain/upload`.
 *
 * Overview leads because it is what the section is *for*, and because a bare
 * `#/company/brain` has to land somewhere: the same rule Finance's Overview and
 * Connections' Apps follow, so a section is never an empty frame.
 */
export const BRAIN_PAGES = [
  {
    id: "overview",
    label: "Overview",
    icon: BrainIcon,
    hint: "Everything the company remembers",
  },
  {
    id: "upload",
    label: "Upload",
    icon: FileUp,
    hint: "Add documents for it to remember",
  },
  {
    id: "settings",
    label: "Settings",
    icon: Cog,
    hint: "Which engine holds the memory",
  },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon; hint: string }[];

export type BrainPage = (typeof BRAIN_PAGES)[number]["id"];

export const DEFAULT_BRAIN_PAGE: BrainPage = "overview";

/** Whether a hash segment names a real sub-page. */
export function isBrainPage(sub: string | null): sub is BrainPage {
  return BRAIN_PAGES.some((page) => page.id === sub);
}

/** The sub-page a hash segment resolves to, defaulting to Overview. */
export function resolveBrainPage(sub: string | null): BrainPage {
  return isBrainPage(sub) ? sub : DEFAULT_BRAIN_PAGE;
}

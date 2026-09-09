// The Connections section's sub-page table, and the helpers that read it.
//
// A leaf module, exactly as `settings-pages.ts` is, and for the same reason:
// anything *pointing at* a sub-page — prose, a route rewrite — has to name one
// without importing the section, which imports every view under it. The route
// rewrites in `lib/console-route-rewrites.ts` are the case that forces it here:
// they run on the router's own path, so a static import of the section from
// there would pull `OAuthView` and `McpServersView` in behind them.
//
// Modelled on `finance/FinanceSection.tsx`'s `FINANCE_PAGES`, which keeps its
// table inside the section because nothing outside needs to read it. This one
// is read from two other modules, so it lives on its own.

import { Blocks, BrainCircuit, LayoutGrid, Sparkles, type LucideIcon } from "lucide-react";

/**
 * The sub-pages that live under Connections. The id is the hash's second
 * segment.
 *
 * Four pages, not one. A single "Connections" page once carried third-party
 * accounts, MCP servers, inference, channels and repositories, and was
 * deliberately broken apart because each was something an operator scrolled
 * past on the way to another (see the comment above the `oauth` entry in
 * `settings-pages.ts`, and `OAuthView`'s own header). That decision was about
 * one-question-per-page, and it stands: every entry below is still one page
 * answering one question. What they gain is a parent, which is a different
 * thing from being merged back together.
 *
 * Inference and Skills join them here, and this file used to argue the
 * opposite: that a credential form belongs beside the one thing it unlocks, so
 * filing Inference under a section named for the act of connecting would
 * separate it from what it is for. What that argument missed is that Settings
 * is not "beside the model" either — it is a rail of configuration an operator
 * visits once, and the model a company thinks with is the single most-read,
 * most-changed thing on it. The test the section already applies to Apps and
 * MCP Servers ("read repeatedly, changes as the company's work changes, asked
 * as *can my teammates do X yet?*") is answered yes by both of these:
 *
 *   - **Inference** is what every teammate thinks with. A company with no model
 *     configured cannot answer a single message, and the chat pane's own
 *     "cannot reach a model" banner links straight here.
 *   - **Skills** are the playbooks teammates read. Installing one is the same
 *     act as connecting an app — granting the company a capability it did not
 *     have a minute ago — and it is checked far more often than it is set.
 *
 * Hosting and Search stay in Settings. They are genuinely once-a-company
 * credential forms, and the argument above is a test rather than a licence to
 * move everything with a key field in it.
 */
export const CONNECTION_PAGES = [
  {
    id: "apps",
    label: "Apps",
    icon: LayoutGrid,
    hint: "The apps your teammates act through",
  },
  {
    id: "mcp",
    label: "MCP Servers",
    icon: Blocks,
    hint: "Tool servers and their tools",
  },
  {
    id: "inference",
    label: "Inference",
    icon: BrainCircuit,
    hint: "The model teammates think with",
  },
  {
    id: "skills",
    label: "Skills",
    icon: Sparkles,
    hint: "Playbooks your teammates read",
  },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon; hint: string }[];

export type ConnectionPage = (typeof CONNECTION_PAGES)[number]["id"];

export const DEFAULT_CONNECTION_PAGE: ConnectionPage = "apps";

/** Whether a hash segment names a real sub-page. */
export function isConnectionPage(sub: string | null): sub is ConnectionPage {
  return CONNECTION_PAGES.some((page) => page.id === sub);
}

/** The sub-page a hash segment resolves to, defaulting to Apps. */
export function resolveConnectionPage(sub: string | null): ConnectionPage {
  return isConnectionPage(sub) ? sub : DEFAULT_CONNECTION_PAGE;
}

/**
 * The console hash a link to one Connections sub-page needs.
 *
 * Typed for the same reason `settingsHref` is: a link written against this
 * cannot outlive the page it points at. `#/settings/connections` — hard-coded
 * in four places, pointing at a page that stopped existing when Connections was
 * split — is what happens without it.
 */
export function connectionsHref(page: ConnectionPage): string {
  return `#/connections/${page}`;
}

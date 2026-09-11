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

import {
  Blocks,
  BrainCircuit,
  Globe,
  KeyRound,
  KeySquare,
  LayoutGrid,
  Search,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

/**
 * The sub-pages that live under Connections. The id is the hash's second
 * segment.
 *
 * Six pages, not one. A single "Connections" page once carried third-party
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
 *   - **Hosting** and **Search** are the two remaining halves of the original
 *     five-subject Connections page, and they come back for the plainest
 *     reason of the lot: each names an outside service the company acts
 *     through — a deploy target, a search provider — which is what this
 *     section is for. Settings kept them on the argument that a credential
 *     form belongs beside what it unlocks, and the thing each unlocks turns
 *     out to be the connection itself.
 *
 * What is left on the Settings rail is what Settings is actually for: who can
 * sign in, how the company behaves, what it did, and what it spends. Nothing
 * with an outside service at the other end of it.
 */
export const CONNECTION_PAGES = [
  {
    id: "apps",
    label: "Apps",
    icon: LayoutGrid,
    hint: "The apps your agents act through",
  },
  {
    // **Account**, not "API Key". Under a group already headed "API Keys" the
    // old label said the group's own name back at it and left the one thing
    // that distinguishes this row — that it is the platform account the rest
    // of the group's keys are billed to — unsaid. The id is untouched:
    // `#/connections/api-key` is an address, and a word on a rail is not a
    // reason to break one (`CONNECTIONS_NAMED_BY`, and `connectionsHref`).
    //
    // Its position in THIS table is no longer its position on the rail — see
    // `CONNECTION_RAIL_GROUPS` below, which orders what an operator sees. What
    // this table's order still decides is nothing at all beyond `apps` being
    // first, and `DEFAULT_CONNECTION_PAGE` says that outright.
    id: "api-key",
    label: "Account",
    icon: KeyRound,
    hint: "The account this company spends through",
  },
  {
    id: "mcp",
    label: "MCP Servers",
    icon: Blocks,
    hint: "Tool servers and their tools",
  },
  {
    // **LLM**, not "Inference". "Inference" names the act the model performs;
    // the thing an operator is here to choose is the model, and every other
    // console they have used — OpenHuman's own Connections rail included —
    // calls that row LLM. The id stays `inference`: `#/connections/inference`
    // is linked from the chat pane's "cannot reach a model" banner and from
    // workflow run rows, and a relabel is not a reason to break either.
    id: "inference",
    label: "LLM",
    icon: BrainCircuit,
    hint: "The model agents think with",
  },
  {
    id: "skills",
    label: "Skills",
    icon: Sparkles,
    hint: "Playbooks your agents read",
  },
  {
    id: "hosting",
    label: "Hosting",
    icon: Globe,
    hint: "Where this company's sites go live",
  },
  {
    id: "search",
    label: "Search",
    icon: Search,
    hint: "Where agents look things up",
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

/**
 * One row on the Connections rail: a page, and optionally which of that page's
 * tabs the row addresses.
 *
 * A row is not the same thing as a page, and this type is where the two come
 * apart. Seven pages, eight rows — because Apps answers two questions through
 * the tabs it already has (`APP_TABS` in `OAuthView`), and the rail is allowed
 * to name both of them.
 */
export interface ConnectionRailRow {
  /** The page this row opens. Always a real id — no row invents an address. */
  page: ConnectionPage;
  /**
   * The `?tab=` value this row addresses, for a page whose rail rows are split
   * by tab. `null` means the page's default tab, and **clears** the key rather
   * than writing it — `#/connections/apps` and `#/connections/apps?tab=providers`
   * are the same place, and only one of them should be the address you copy out
   * of the bar (see `useHashTab`). `undefined` means the page has one row and
   * the rail says nothing about its tabs.
   */
  tab?: string | null;
  /** Overrides the page's own label, for a row that is not the whole page. */
  label?: string;
  /** Overrides the page's own icon, for the same reason. */
  icon?: LucideIcon;
  /** Overrides the page's own hint, for the same reason. */
  hint?: string;
}

/**
 * The rail, grouped — the presentational half of this file, and only that.
 *
 * ## Why a second table rather than a `group` field
 *
 * `SETTINGS_PAGES` tags each page with a `group` id and lists the groups beside
 * it, and that is the vocabulary this matches wherever it can. What it cannot
 * borrow is the *ordering*: a tag orders rows by the page table's own order
 * within each group, and this rail needs LLM above Account inside "API Keys"
 * while `CONNECTION_PAGES` needs `apps` first and nothing else pinned. More to
 * the point, a tag gives a page exactly one row, and Apps needs two.
 *
 * So the page table stays the routing table — ids, and what each page is —
 * and this is what an operator sees. Nothing here can mint an address:
 * `page` is a `ConnectionPage`, so a row cannot outlive its page for the same
 * reason `connectionsHref` cannot. `connections-navigation.test.ts` holds the
 * other direction — that every page has a row, so grouping cannot quietly
 * strand one.
 *
 * ## The grouping
 *
 * **Integrations** are things the company connects *to*. **API Keys** are the
 * credentials that authorise the work. That distinction was already true of
 * these seven pages and an operator had to reconstruct it on every visit,
 * because seven flat rows say nothing about it. It is the same split
 * OpenHuman's own Connections page makes, and Composio appears on both sides
 * there for the same reason it does here: the app grid and the key behind it
 * are two questions about one subject.
 *
 * **Apps is the first row of the first group, and that is load-bearing.** A
 * bare `#/connections` opens the first row of this list (`rowActive` in
 * `sidebar-navigation.tsx`, and `DEFAULT_CONNECTION_PAGE` agreeing with it),
 * so reordering the head of it changes where every existing bookmark to the
 * section lands.
 *
 * **Others** is one row, and is honest about it: Hosting is neither a thing
 * you connect through nor a key that authorises one, and filing it under
 * either would have made a group label lie to make a rail look tidier.
 */
export const CONNECTION_RAIL_GROUPS = [
  {
    id: "integrations",
    label: "Integrations",
    rows: [
      // `tab: null` rather than nothing: this row shares its page with Composio
      // below, so pressing it has to *clear* a `?tab=credentials` left standing
      // by that row. A route-only navigation preserves the query when the path
      // is unchanged (`useHashView`'s `navigate`), which would land Apps on the
      // Credentials tab.
      { page: "apps", tab: null },
      { page: "mcp" },
      { page: "skills" },
    ],
  },
  {
    id: "keys",
    label: "API Keys",
    rows: [
      { page: "inference" },
      // The second row on the Apps page, pointing at the tab that already
      // exists. `ComposioSection` is NOT split out of `OAuthView` and must not
      // be: `ProvidersSection` reads the Composio credential's
      // `credentialSource`, `granted`, `openMode` and catalog warning to decide
      // what every provider tile renders, so the credential is the engine the
      // provider list runs on. What changes here is navigation and nothing
      // else — the row addresses `#/connections/apps?tab=credentials`, which is
      // the address the page's own Credentials tab has always written.
      {
        page: "apps",
        tab: "credentials",
        label: "Composio",
        icon: KeySquare,
        hint: "The key the app catalog runs on",
      },
      { page: "search" },
      { page: "api-key" },
    ],
  },
  {
    id: "others",
    label: "Others",
    rows: [{ page: "hosting" }],
  },
] as const satisfies readonly {
  id: string;
  label: string;
  rows: readonly ConnectionRailRow[];
}[];

/** One rail row with its label, icon and hint filled in from its page. */
export interface ResolvedConnectionRailRow {
  page: ConnectionPage;
  tab?: string | null;
  label: string;
  icon: LucideIcon;
  hint: string;
}

/** A rail row resolved against its page: label, icon and hint, whoever owns them. */
export function connectionRailRow(row: ConnectionRailRow): ResolvedConnectionRailRow {
  const page = CONNECTION_PAGES.find((p) => p.id === row.page)!;
  return {
    page: row.page,
    tab: row.tab,
    label: row.label ?? page.label,
    icon: row.icon ?? page.icon,
    hint: row.hint ?? page.hint,
  };
}

/**
 * The rail as one ordered list of rows, captions flattened away.
 *
 * What an operator's Tab key walks, and what a check of "every page still has a
 * row" has to count. The groups are what they are *drawn* in; a group is a
 * heading rather than a scope, and nothing that reasons about which row an
 * address lights should have to know they exist (see `rowActive` in
 * `sidebar-navigation.tsx`, which learned that the expensive way).
 */
export const CONNECTION_RAIL_ROWS: readonly ResolvedConnectionRailRow[] =
  CONNECTION_RAIL_GROUPS.flatMap((group) => group.rows.map(connectionRailRow));

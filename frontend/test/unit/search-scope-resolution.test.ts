import { describe, expect, it } from "vitest";

import type { Desk } from "@/lib/desks";
import type { TeamMember } from "@/lib/team";
import { parseSearchQuery } from "@/search/query";
import { channelResults } from "@/search/sources";
import { resolveScope } from "@/search/useSearch";

/**
 * Two desks whose display names slugify to one channel name.
 *
 * `create_desk` (`src/server/operator.rs`) refuses a duplicate desk **id** and
 * says nothing about the display name, and `deskFromDto` derives the slug from
 * the name — so this is a shape a real company can hold, not a contrived one.
 */
const twins = [
  { id: "sales_us", channel: "sales-us", name: "Sales US", blurb: "The first one." },
  { id: "sales_us_east", channel: "sales-us", name: "Sales-US", blurb: "The second one." },
] as Desk[];

const members = [] as TeamMember[];

describe("picking one of two desks that share a channel name", () => {
  it("writes an id back for a slug that names two desks", () => {
    const rows = channelResults(twins, parseSearchQuery("#sales"));
    expect(rows.map((r) => r.scopeName)).toEqual(["sales_us", "sales_us_east"]);
  });

  it("still writes the readable slug when it names exactly one", () => {
    const alone = [twins[0]];
    const [row] = channelResults(alone, parseSearchQuery("#sales"));
    expect(row.scopeName).toBe("sales-us");
  });

  it("resolves the id the second row wrote to the second desk", () => {
    // The bug: both rows wrote `#sales-us`, the ranker took the first match,
    // and picking the second row searched the first desk's history in silence.
    const second = resolveScope(parseSearchQuery("#sales_us_east box"), twins, members);
    expect(second?.threadId).toBe("sales_us_east");
    expect(second?.context.label).toBe("#sales-us");
  });

  it("still resolves a typed alias when no id matches it exactly", () => {
    // Nobody types an id by hand; the alias path is the one an operator uses,
    // and the id lookup must not displace it.
    const typed = resolveScope(parseSearchQuery("#sales-us box"), twins, members);
    expect(typed?.threadId).toBe("sales_us");
  });

  it("matches an id case-insensitively, since the parser lowercases what was typed", () => {
    const mixed = [{ id: "AutumnLaunch", channel: "autumn-launch", name: "Autumn launch", blurb: "" }] as Desk[];
    expect(resolveScope(parseSearchQuery("#AutumnLaunch box"), mixed, members)?.threadId).toBe(
      "AutumnLaunch",
    );
  });
});

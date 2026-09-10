import { describe, expect, it } from "vitest";

import { MAIN_THREAD_ID } from "@/lib/chat";
import type { Desk } from "@/lib/desks";
import type { TeamMember } from "@/lib/team";
import { parseSearchQuery } from "@/search/query";
import { channelResults } from "@/search/sources";
import { resolveScope } from "@/search/useSearch";
import { buildChannels, withGeneralDesk } from "@/views/room/channels";

function member(over: Partial<TeamMember> & { id: string; name: string }): TeamMember {
  return {
    role: "",
    description: "",
    tone: "blue",
    avatar: over.id,
    inboxEnabled: false,
    effectiveTools: [],
    desks: [],
    ...over,
  } as TeamMember;
}

const roster = [
  member({ id: "priya", name: "Priya", isOrchestrator: true }),
  member({ id: "nadia", name: "Nadia" }),
];

const desks = [
  { id: "autumn_launch", channel: "autumn-launch", name: "Autumn launch", blurb: "Shipping." },
] as Desk[];

/**
 * `#general` is reachable from search (#2245 review).
 *
 * `list_desks` (`src/server/operator.rs`) omits the company-wide line — it is
 * not a desk — and also omits the desk `[company].general_desk` names, since
 * that desk *is* General. Anything built straight off `/desks` therefore could
 * not offer the one conversation every company has, and `#general autumn` had
 * nothing to resolve.
 */
describe("the company-wide line among the desks", () => {
  it("adds General to a desk list that does not carry it", () => {
    const listed = withGeneralDesk(desks, roster);
    expect(listed.map((d) => d.channel)).toEqual(["general", "autumn-launch"]);
    expect(listed[0].id).toBe(MAIN_THREAD_ID);
  });

  it("steps aside for a blueprint desk that claims a General spelling", () => {
    // The host grandfathers such a desk onto the company's line, so a second
    // row would be the same conversation listed twice.
    const claimed = [{ id: "general", channel: "general", name: "General", blurb: "" }] as Desk[];
    expect(withGeneralDesk(claimed, roster).map((d) => d.id)).toEqual(["general"]);
    const byName = [{ id: "ops", channel: "general", name: "General", blurb: "" }] as Desk[];
    expect(withGeneralDesk(byName, roster).map((d) => d.id)).toEqual(["ops"]);
  });

  it("describes the channel exactly as the rail does", () => {
    // One helper behind both, so the two surfaces cannot drift.
    const [rail] = buildChannels(roster, desks)[0].channels;
    const [searched] = withGeneralDesk(desks, roster);
    expect(searched.id).toBe(rail.id);
    expect(searched.channel).toBe(rail.name);
    expect(searched.name).toBe(rail.voice);
    expect(searched.blurb).toBe(rail.purpose);
    expect(searched.members).toEqual(rail.memberIds);
  });

  it("offers #general as a result, linking where the rail links", () => {
    const [row] = channelResults(withGeneralDesk(desks, roster), parseSearchQuery("gener"));
    expect(row.title).toBe("#general");
    expect(row.href).toBe(`#/chat/${MAIN_THREAD_ID}`);
    expect(row.action).toBe("Go to #general");
  });

  it("resolves `#general <term>` to the main thread the host answers on", () => {
    const scoped = resolveScope(
      parseSearchQuery("#general autumn"),
      withGeneralDesk(desks, roster),
      roster,
    );
    expect(scoped?.threadId).toBe(MAIN_THREAD_ID);
    expect(scoped?.context.channelId).toBe(MAIN_THREAD_ID);
    expect(scoped?.context.label).toBe("#general");
  });
});

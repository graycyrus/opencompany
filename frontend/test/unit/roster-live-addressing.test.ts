import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { TeamMemberDto } from "@/api/types";
import { rosterIdentity } from "@/lib/team";

/**
 * Bug B-030: a teammate you hire does real work the console never shows you.
 *
 * Hire "Priya", DM her, she replies. `GET …/chat/history?desk=priya` returns
 * the reply — 2 rows, one of them hers, plus the workspace note she wrote — and
 * the DM shows only your own message, for as long as the tab stays open.
 *
 * The cause is not a hardcoded desk list. `ChatView`'s rail is derived from the
 * live roster it keeps for itself, which is why Priya is offered in the New
 * message picker and counted in "Show teammates" the moment the host confirms
 * the write. What was fixed once and then closed over is the **shell's** copy:
 * `AppShell`'s `[client, company]` effect read `/team` once, and from that one
 * snapshot built the `chat/history` poll targets *and* the thread-to-channel
 * map a live SSE frame is routed through. A teammate hired after that read was
 * therefore in neither: their desk was never polled, and `channelForThread`
 * dropped their live frames for want of a channel. The console showed the
 * operator's own optimistic line and nothing else — while the company billed
 * them for the work.
 *
 * Two things have to hold for that to stay fixed, and they are tested
 * separately below because they fail separately:
 *
 * 1. The shell can tell a changed roster from an unchanged one cheaply, or the
 *    five-second history poll would re-render the whole shell forever.
 * 2. The poll actually re-reads the roster and re-derives from it, rather than
 *    calling the closure built at mount.
 */

describe("rosterIdentity", () => {
  const member = (id: string, name?: string): TeamMemberDto =>
    ({ id, name, role: "Role" }) as TeamMemberDto;

  it("is stable across two reads of an unchanged roster", () => {
    // The property the five-second poll depends on: a fresh parse of the same
    // roster is a different array of different objects every tick, so identity
    // comparison would re-derive — and re-render — on every tick forever.
    const first = [member("writer", "Writer"), member("priya", "Priya")];
    const second = [member("writer", "Writer"), member("priya", "Priya")];

    expect(rosterIdentity(second)).toBe(rosterIdentity(first));
  });

  it("changes when a teammate is hired", () => {
    const before = [member("writer", "Writer")];
    const after = [member("writer", "Writer"), member("priya", "Priya")];

    expect(rosterIdentity(after)).not.toBe(rosterIdentity(before));
  });

  it("changes when a teammate leaves", () => {
    const before = [member("writer", "Writer"), member("priya", "Priya")];
    const after = [member("writer", "Writer")];

    expect(rosterIdentity(after)).not.toBe(rosterIdentity(before));
  });

  it("changes when one teammate is swapped for another", () => {
    // The case a row count cannot see. Hiring one teammate and dropping another
    // between two ticks leaves the length identical while the addressing has
    // completely moved — the new hire's desk would never be polled.
    const before = [member("writer", "Writer"), member("priya", "Priya")];
    const after = [member("writer", "Writer"), member("nadia", "Nadia")];

    expect(after).toHaveLength(before.length);
    expect(rosterIdentity(after)).not.toBe(rosterIdentity(before));
  });

  it("changes when a teammate is renamed", () => {
    // Addressing is unaffected by a rename; the name map a live receipt
    // resolves an agent id through is not. The shell derives both from this
    // read, so a rename has to count as a change or "Priya says…" keeps
    // rendering the old name until the tab is reloaded.
    const before = [member("priya", "Priya")];
    const after = [member("priya", "Priya Raman")];

    expect(rosterIdentity(after)).not.toBe(rosterIdentity(before));
  });

  it("changes when the roster is reordered", () => {
    // Roster order is the order DM threads are built in, so a reorder really
    // does change what renders.
    const before = [member("writer", "Writer"), member("priya", "Priya")];
    const after = [member("priya", "Priya"), member("writer", "Writer")];

    expect(rosterIdentity(after)).not.toBe(rosterIdentity(before));
  });

  it("keeps two rosters apart when a field boundary falls inside a value", () => {
    // A `,`-joined fingerprint would call these the same roster: one teammate
    // whose name contains the separator, against two teammates. The separators
    // are ASCII unit/record separator precisely because neither can occur in a
    // host-issued id or a name typed into the add-teammate dialog.
    const one = [member("a", "x,y")];
    const two = [member("a", "x"), member("y", undefined)];

    expect(rosterIdentity(one)).not.toBe(rosterIdentity(two));
  });

  it("fingerprints an empty roster without throwing", () => {
    expect(rosterIdentity([])).toBe("");
  });
});

/**
 * `AppShell` is too large, and pulls in too much (SSE, the authenticated
 * client, routing) to mount in a unit test — `chat-realtime-poll.test.ts` and
 * `chat-receipt-scope-reset.test.ts` both settle the same way, reading the
 * source and asserting on the literal wiring. What this locks down is that the
 * roster re-read is on the *polling* path: `rosterIdentity` being correct buys
 * nothing if the timer still calls the closure built at mount.
 */
const here = dirname(fileURLToPath(import.meta.url));
const appShell = readFileSync(resolve(here, "../../src/components/app-shell.tsx"), "utf8");

describe("the shell's chat addressing is re-derived from the live roster", () => {
  it("hands the recurring poll the callback that re-reads the roster", () => {
    // The one line the whole bug turns on. Before the fix this passed
    // `rehydrateAll`, whose target list was fixed at mount.
    expect(appShell).toMatch(
      /disposeRehydratePolling = startVisiblePolling\(refreshAll, 5000\);/,
    );
  });

  it("re-reads /team on the tick and re-derives when the roster moved", () => {
    const start = appShell.indexOf("const refreshAll = () => {");
    expect(start, "the polling callback").toBeGreaterThan(-1);
    const body = appShell.slice(start, appShell.indexOf("startVisiblePolling", start));

    expect(body).toContain("client\n              .listTeam(company)");
    expect(body).toMatch(/const key = rosterIdentity\(members\);/);
    expect(body).toMatch(/if \(key === rosterKey\) return;/);
    expect(body).toMatch(/applyRoster\(members\);/);
  });

  it("still rehydrates every tick, roster change or not", () => {
    // The history poll is the older job and must not become conditional on the
    // roster having moved — a persisted message on an existing desk still has
    // to be recovered when a live frame was missed.
    const start = appShell.indexOf("const refreshAll = () => {");
    const body = appShell.slice(start, appShell.indexOf("startVisiblePolling", start));
    const guarded = body.indexOf("if (!rosterReadInFlight)");
    const rehydrate = body.indexOf("rehydrateAll();");

    expect(guarded).toBeGreaterThan(-1);
    expect(rehydrate).toBeGreaterThan(-1);
    // Outside the in-flight guard's block, i.e. after it closes.
    expect(body.slice(rehydrate)).not.toContain("rosterReadInFlight = true");
  });

  it("derives the poll targets through the same function the re-read calls", () => {
    // Both the mount-time pass and every later roster change go through one
    // derivation, so the two cannot drift into disagreeing about where a
    // teammate's transcript is fetched from.
    expect(appShell).toMatch(/const applyRoster = \(members: TeamMemberDto\[\]\) => \{/);
    expect(appShell).toMatch(/applyRoster\(team\);\n\s*rosterKey = rosterIdentity\(team\);/);
    expect(appShell).toMatch(
      /const rehydrateAll = \(\) => rehydrateTargets\(targets\.threadIds, targets\.channels\);/,
    );
  });

  it("skips a roster read while one is already in flight", () => {
    // Same rule `hydrateThread` applies per thread: a slow `/team` must not let
    // ticks stack into a queue of duplicate reads.
    expect(appShell).toMatch(/let rosterReadInFlight = false;/);
    expect(appShell).toMatch(/rosterReadInFlight = false;\n\s*\}\);/);
  });
});

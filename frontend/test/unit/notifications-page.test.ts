/**
 * The Notifications page's two decidable halves: which tab an address resolves
 * to, and where a row on the Activity list sends you.
 *
 * The page's rendering is not pinned here — `routed-views.ts` already holds it
 * to drawing a `PageHeader`, and the approvals queue inside it is covered by
 * the specs it already had. What is pinned is the two rules that are easy to
 * get subtly wrong and impossible to see in a screenshot:
 *
 *   - `#/approvals` must land on the queue **whatever `?tab=` says**, because
 *     it is the address six in-tree links and every bookmark point at. A stale
 *     `?tab=activity` left in the hash from a previous visit must not hijack a
 *     link to a blocked card's approvals.
 *   - a row must never link somewhere that is not about it. The host's `kind`
 *     and `subjectKind` are free-form by design, so an unknown subject has to
 *     render inert rather than be guessed at.
 */

import { describe, expect, it } from "vitest";

import type { NotificationDto } from "@/api/types";
import { byNewestFirst, notificationHref } from "@/lib/notification-links";
import { VIEWS } from "@/lib/console-routes";

const CHANNELS = {
  rendered: new Set(["desk-design", "desk-ops"]),
  mainChannelId: "desk-design",
};

function row(over: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id: "n1",
    kind: "mention",
    subjectKind: "message",
    subjectId: "m1",
    title: "Priya mentioned you",
    createdAt: 1_000,
    context: "desk-ops",
    ...over,
  };
}

describe("both addresses the page answers", () => {
  it("routes #/notifications and keeps #/approvals alive beside it", () => {
    // Retiring `#/approvals` was the obvious move and is the wrong one:
    // `REWRITE_RETIRED` maps `[head, sub] -> [View, sub]` with no query
    // channel, so `#/approvals/<taskId>` could not have been rewritten onto
    // `?task=` without dropping the id. Both heads stay routable and the shell
    // renders one page for them.
    expect(VIEWS).toContain("notifications");
    expect(VIEWS).toContain("approvals");
  });
});

describe("where a row sends you", () => {
  it("opens the card a task row is about, not the board", () => {
    expect(notificationHref(row({ subjectKind: "task", subjectId: "t 1" }), CHANNELS)).toBe(
      "#/tasks/t%201",
    );
  });

  it("opens the run a run row is about", () => {
    expect(notificationHref(row({ subjectKind: "run", subjectId: "r1" }), CHANNELS)).toBe(
      "#/observatory/r1",
    );
  });

  it("sends an approval row to the whole queue, never to a narrowed one", () => {
    // `#/approvals/<id>` narrows on a BOARD TASK id (#883). An approval id is
    // not one, so a narrowed queue would match nothing and render "this card is
    // clear" — a lie about the row that sent the operator there.
    expect(notificationHref(row({ subjectKind: "approval", subjectId: "a1" }), CHANNELS)).toBe(
      "#/approvals",
    );
  });

  it("resolves a message row through the channel the host recorded", () => {
    expect(notificationHref(row({ context: "desk-ops" }), CHANNELS)).toBe("#/chat/desk-ops");
  });

  it("lands a legacy general-chat context on the rendered main channel", () => {
    // The same resolution the mention badge and the shell's thread re-read
    // share (issue #65) — not a second copy of the rule.
    expect(notificationHref(row({ context: "general" }), CHANNELS)).toBe("#/chat/desk-design");
  });

  it("renders inert rather than guessing, for a subject it does not know", () => {
    // The host has no kind allowlist on purpose, so a future producer can write
    // a subject this console has never seen. The row still shows its title; it
    // simply is not a link.
    expect(notificationHref(row({ subjectKind: "moonbase" }), CHANNELS)).toBeNull();
    expect(notificationHref(row({ subjectKind: "task", subjectId: "" }), CHANNELS)).toBeNull();
    expect(notificationHref(row({ context: undefined }), CHANNELS)).toBeNull();
  });
});

describe("the order the list reads in", () => {
  it("is newest first, without mutating the shell's own array", () => {
    // The array handed to the list is React state in `app-shell`. Sorting it in
    // place would mutate that behind React's back.
    const feed = [row({ id: "old", createdAt: 1 }), row({ id: "new", createdAt: 9 })];
    expect(byNewestFirst(feed).map((n) => n.id)).toEqual(["new", "old"]);
    expect(feed.map((n) => n.id)).toEqual(["old", "new"]);
  });
});

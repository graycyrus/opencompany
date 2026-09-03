import { describe, expect, it } from "vitest";

import { PendingSyncPosts } from "@/lib/live-reply";

/**
 * A system-attributed live `agent_reply` frame (`SYSTEM_AUTHOR`, B-101's
 * mention-ambiguity notice) must never be held by `PendingSyncPosts.capture`,
 * even while its thread's own chat POST is in flight (Codex review, PR
 * #2052).
 *
 * Suppression exists because the operator's own synchronous reply arrives
 * twice — once in the awaited POST response, once over SSE — and `ended`
 * discards whatever `capture` held on the assumption it duplicates that
 * response. A system frame is never part of that response body:
 * `post_mention_ambiguity_note`'s own doc comment says it is "journaled, not
 * returned in the POST response", specifically so it can reach an API poster
 * who renders no chip at all. `ended`'s assumption does not hold for it, so
 * holding it let a legitimate operator turn resolve out from under it and
 * silently swallow the notice — for every synchronous (non-detached) send —
 * until whatever later happened to reload the channel's history.
 */
describe("PendingSyncPosts never holds a system-attributed frame", () => {
  it("renders a system frame immediately even while the thread's POST is in flight", () => {
    const pending = new PendingSyncPosts();
    pending.started("main");

    // `false` means "not held — render it now", unlike an ordinary frame on
    // the same thread (see live-reply capture's own suite).
    expect(pending.capture({ chatId: "main", agentId: "system" })).toBe(false);
  });

  it("cannot be lost to a later ended() the way an ordinary held frame is", () => {
    const pending = new PendingSyncPosts();
    pending.started("main");
    const note = { chatId: "main", agentId: "system" };

    // Never entered the held queue, so there is nothing for `ended` to
    // discard — the bug this test pins is exactly that assumption failing
    // for a frame `ended` had no business discarding.
    expect(pending.capture(note)).toBe(false);
    pending.ended("main");
    pending.started("main");
    expect(pending.detached("main")).toEqual([]);
  });

  it("still holds an ordinary company frame on the same thread", () => {
    const pending = new PendingSyncPosts();
    pending.started("main");
    const reply = { chatId: "main", agentId: "engineer" };

    expect(pending.capture(reply)).toBe(true);
    expect(pending.detached("main")).toEqual([reply]);
  });

  it("treats a frame with no agentId as an ordinary (held) frame", () => {
    // `AgentReplyEvent.agentId` is required on the wire type, but the
    // interface leaves it optional for callers that predate the field —
    // absent must not be misread as the runtime's own voice.
    const pending = new PendingSyncPosts();
    pending.started("main");

    expect(pending.capture({ chatId: "main" })).toBe(true);
  });
});

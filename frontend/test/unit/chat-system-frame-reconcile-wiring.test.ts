// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Cross-module wiring for the settled-response reconciliation
 * (`PendingSyncPosts.ended`'s own suite proves the reconciliation logic
 * itself; Codex review, PR #2052).
 *
 * The bug this exists to catch cannot be seen from either module alone: it
 * is `ChatView` computing `responseTexts` but never handing them to
 * `onSendEnd`, or `app-shell` receiving them but never forwarding them to
 * `ended()`, or `ended()`'s released frames never reaching `renderAgentReply`.
 * Any one of those silently regresses back to the double-render bug (a
 * `system_notice` fallback shown as both a live system pill and a settled
 * `"company"` bubble) or the original swallowed-note bug (B-101's
 * mention-ambiguity note lost to a blanket discard), with nothing but a
 * live screenshot mid-send to catch it.
 *
 * `AppShell` is too large to mount in a unit test (SSE, the authenticated
 * client, routing — see `chat-receipt-scope-reset.test.ts`'s own doc for the
 * precedent this file follows: read the source, assert the wiring is real
 * rather than merely present somewhere in the file).
 */

const here = dirname(fileURLToPath(import.meta.url));
const chatView = readFileSync(resolve(here, "../../src/views/ChatView.tsx"), "utf8");
const appShell = readFileSync(resolve(here, "../../src/components/app-shell.tsx"), "utf8");

describe("ChatView computes and forwards the settled response's own texts", () => {
  it("captures every response line's text before the finally block can see it", () => {
    expect(chatView).toMatch(/responseTexts = reply\.responses\.map\(\(r\) => r\.text\);/);
  });

  it("passes responseTexts to onSendEnd on the resolved outcome", () => {
    expect(chatView).toMatch(
      /if \(outcome === "resolved"\) onSendEnd\?\.\(stateKey, gen, responseTexts\);/,
    );
  });
});

describe("app-shell forwards responseTexts to ended() and renders what it releases", () => {
  function onSendEndBody(): string {
    const start = appShell.indexOf("const onSendEnd = useCallback(");
    expect(start, "onSendEnd's declaration").toBeGreaterThan(-1);
    const end = appShell.indexOf("[clearReceipt, renderAgentReply],", start);
    expect(end, "onSendEnd's dependency array").toBeGreaterThan(start);
    return appShell.slice(start, end);
  }

  it("threads responseTexts into ended(), rather than calling it bare", () => {
    const body = onSendEndBody();
    expect(body).toMatch(/pendingPostThreadsRef\.current\.ended\(threadId, responseTexts\)/);
    // The old bare call this replaced discarded every held frame
    // unconditionally — its absence here is the fix, not merely the new
    // call's presence.
    expect(body).not.toMatch(/pendingPostThreadsRef\.current\.ended\(threadId\);/);
  });

  it("renders every frame ended() releases, rather than dropping them on the floor", () => {
    const body = onSendEndBody();
    expect(body).toMatch(/const released = pendingPostThreadsRef\.current\.ended\(/);
    expect(body).toMatch(/released\.forEach\(\(frame\) => renderAgentReply\(frame\)\);/);
  });
});

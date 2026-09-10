import { describe, expect, it } from "vitest";

import type { OpenCompanyClient } from "@/api/client";
import type { ChatHistoryMessageDto } from "@/api/types";
import { HISTORY_PAGE, HISTORY_PAGES, readConversation } from "@/search/useSearch";

/**
 * A conversation long enough that the walk never stops early: every page comes
 * back full, so only the page cap or the generation check can end it.
 */
function fullPage(page: number): ChatHistoryMessageDto[] {
  return Array.from({ length: HISTORY_PAGE }, (_, index) => ({
    id: `p${page}-m${index}`,
    channel: "autumn_launch",
    author: "priya",
    text: "the autumn box ships friday",
    atMillis: index + 1,
    mine: false,
  }));
}

/** A client that answers history and counts how often it was asked. */
function counting() {
  const asked: (string | undefined)[] = [];
  const client = {
    getChatHistory: async (
      _threadId: string,
      _company: string | null,
      options?: { before?: string; limit?: number },
    ) => {
      asked.push(options?.before);
      return fullPage(asked.length);
    },
  } as unknown as OpenCompanyClient;
  return { asked, client };
}

/**
 * What an abandoned scoped search costs the host (#2245 review).
 *
 * The generation check used to run only once every page had resolved, so it
 * dropped the answer but never the requests: a query that moved on after the
 * first page still walked the remaining four.
 */
describe("reading a conversation for a query that may move on", () => {
  it("walks the whole cap while the query is still the current one", async () => {
    const { asked, client } = counting();
    const rows = await readConversation(client, null, "autumn_launch", () => true);
    expect(asked).toHaveLength(HISTORY_PAGES);
    expect(rows).toHaveLength(HISTORY_PAGE * HISTORY_PAGES);
  });

  it("asks for no further page once the query it was fetching for is stale", async () => {
    const { asked, client } = counting();
    // Current for the first page and nothing after it — the operator typed one
    // more character, or shut the modal, while page one was in flight.
    const rows = await readConversation(
      client,
      null,
      "autumn_launch",
      () => asked.length < 1,
    );
    expect(asked, "the walk should stop rather than spend four more round trips").toHaveLength(1);
    // What was already read comes back as it stands; the caller discards it on
    // the same generation check.
    expect(rows).toHaveLength(HISTORY_PAGE);
  });

  it("defaults to walking, so a caller with no generation to check is unchanged", async () => {
    const { asked, client } = counting();
    await readConversation(client, null, "autumn_launch");
    expect(asked).toHaveLength(HISTORY_PAGES);
  });
});

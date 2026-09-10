// The asynchronous half: what has to be fetched before the pure half can rank it.
//
// Everything about *what counts as a hit* lives in `sources.ts` and `rank.ts`,
// which are pure. What lives here is the part that cannot be: reading the
// roster and the desks once the modal opens, asking the host to search the
// workspace, and reading one conversation when the query names one.
//
// ## Two rules this file exists to keep
//
// **A late answer never wins.** Every fetch is tagged with the generation that
// asked for it and drops itself if the query has moved on. Typing is a stream
// of queries and the network reorders them freely, so without this an operator
// who types `box` sees results for `bo` land on top of them a moment later.
//
// **Nothing is fetched for a query that cannot use it.** Workspace search is a
// host round trip, so it waits for a term and never runs for a scoped query,
// where the question is about a conversation rather than about files.

import { useEffect, useMemo, useRef, useState } from "react";

import type { OpenCompanyClient } from "@/api/client";
import type { ChatHistoryMessageDto } from "@/api/types";
import { searchWorkspace, type SearchHit } from "@/api/workspace";
import type { Desk } from "@/lib/desks";
import { fromDto, type TeamMember } from "@/lib/team";
import { deskFromDto, dmChannelId, dmThreadId } from "@/views/room/channels";
import { isScopedMessageSearch, type SearchQuery } from "./query";
import { score } from "./rank";
import {
  agentResults,
  channelResults,
  fileResults,
  messageResults,
  type MessageContext,
} from "./sources";
import { RESULT_LABEL, RESULT_ORDER, type ResultGroup, type SearchResult } from "./types";

/**
 * How long to wait after a keystroke before asking the host anything.
 *
 * Local matching is synchronous and unaffected — channels and agents update on
 * every keystroke, which is what makes the modal feel immediate. This bounds
 * only the round trips.
 */
const DEBOUNCE_MS = 160;

/** How much of a conversation to read when searching inside it. */
const HISTORY_LIMIT = 500;

/** What the modal needs to draw itself. */
export interface SearchState {
  groups: ResultGroup[];
  /** Whether a host round trip is outstanding. Local results are already shown. */
  loading: boolean;
  /** The roster, for the resting state's shortcuts. */
  members: TeamMember[];
  /** The channels, likewise. */
  desks: Desk[];
}

/**
 * Everything the search modal shows, for one query.
 *
 * `enabled` is the modal's open state: nothing is fetched while it is shut, and
 * what was loaded is kept, so reopening is instant rather than a second load of
 * the same roster.
 */
export function useSearch(
  client: OpenCompanyClient,
  company: string | null,
  query: SearchQuery,
  enabled: boolean,
): SearchState {
  const [desks, setDesks] = useState<Desk[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [files, setFiles] = useState<SearchHit[]>([]);
  const [messages, setMessages] = useState<{ context: MessageContext; rows: ChatHistoryMessageDto[] } | null>(null);
  const [loading, setLoading] = useState(false);

  // The scope the collections were loaded for. A company switch while the modal
  // is shut must not leave the previous company's channels in it.
  const loadedFor = useRef<{ client: unknown; company: string | null } | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const scope = loadedFor.current;
    if (scope && scope.client === client && scope.company === company) return;

    let cancelled = false;
    void Promise.allSettled([client.listDesks(company), client.listTeam(company)]).then(
      ([deskResult, teamResult]) => {
        if (cancelled) return;
        loadedFor.current = { client, company };
        // Settled rather than awaited together: a host with no `.../desks` route
        // still has a roster, and one failure should not empty both lists.
        if (deskResult.status === "fulfilled") setDesks(deskResult.value.map(deskFromDto));
        if (teamResult.status === "fulfilled") setMembers(teamResult.value.map(fromDto));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, company, enabled]);

  /** The teammate or desk a scope names, or null while it names nobody. */
  const scoped = useMemo(() => resolveScope(query, desks, members), [query, desks, members]);

  useEffect(() => {
    if (!enabled) return;
    const mine = ++generation.current;
    const current = () => generation.current === mine;

    // Nothing to ask about: clear what the last query fetched rather than
    // leaving it under a query it does not answer.
    if (query.isEmpty) {
      setFiles([]);
      setMessages(null);
      setLoading(false);
      return;
    }

    const timer = setTimeout(() => {
      if (!current()) return;

      if (isScopedMessageSearch(query) && scoped) {
        setLoading(true);
        void client
          .getChatHistory(scoped.threadId, company, { limit: HISTORY_LIMIT })
          .then((rows) => {
            if (!current()) return;
            setMessages({ context: scoped.context, rows });
            setFiles([]);
          })
          .catch(() => {
            if (!current()) return;
            setMessages(null);
          })
          .finally(() => {
            if (current()) setLoading(false);
          });
        return;
      }

      setMessages(null);
      // `/` is a file query in its own right; `@` and `#` half-typed are
      // pickers, and a picker is not a question for the host.
      const fileTerm = query.scope?.kind === "file" ? query.scope.name : query.scope ? "" : query.term;
      if (!fileTerm) {
        setFiles([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      void searchWorkspace(client, company, fileTerm, { limit: 12 })
        .then((results) => {
          if (!current()) return;
          setFiles(results.hits);
        })
        .catch(() => {
          // A host without the workspace route answers 404. That is a missing
          // source, not a failed search — the other groups still stand.
          if (current()) setFiles([]);
        })
        .finally(() => {
          if (current()) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [client, company, enabled, query, scoped]);

  const groups = useMemo(() => {
    const byKind: Record<string, SearchResult[]> = {
      channel: channelResults(desks, query),
      agent: agentResults(members, query),
      message: messages ? messageResults(messages.rows, query, messages.context) : [],
      file: fileResults(files, query),
    };
    return RESULT_ORDER.map((kind) => ({
      kind,
      label: RESULT_LABEL[kind],
      results: byKind[kind] ?? [],
    })).filter((group) => group.results.length > 0);
  }, [desks, members, messages, files, query]);

  return { groups, loading, members, desks };
}

/** A resolved scope: which conversation to read, and what to call it. */
interface ResolvedScope {
  /** The **host thread** to read history from. */
  threadId: string;
  context: MessageContext;
}

/**
 * The one conversation a scope names, or null when it names none yet.
 *
 * The thread and the link are deliberately different strings for a person:
 * `dmThreadId` is what the host answers history on, `dmChannelId` is what this
 * console routes — and they diverge for a teammate whose id spells General
 * (`views/room/channels.ts`). Reading the wrong one gives an empty history for
 * a DM that plainly has messages.
 */
function resolveScope(
  query: SearchQuery,
  desks: readonly Desk[],
  members: readonly TeamMember[],
): ResolvedScope | null {
  const scope = query.scope;
  if (!scope || !scope.name) return null;

  if (scope.kind === "person") {
    const member = best(members, (m) => Math.max(score(m.name, scope.name), score(m.id, scope.name)));
    if (!member) return null;
    const nameById = new Map(members.map((m) => [m.id, m.name]));
    return {
      threadId: dmThreadId(member),
      context: {
        channelId: dmChannelId(member),
        label: member.name,
        nameFor: (author) => nameById.get(author) ?? (author === "operator" ? "You" : author),
      },
    };
  }

  const desk = best(desks, (d) => Math.max(score(d.channel, scope.name), score(d.name, scope.name)));
  if (!desk) return null;
  const nameById = new Map(members.map((m) => [m.id, m.name]));
  return {
    threadId: desk.id,
    context: {
      channelId: desk.id,
      label: `#${desk.channel}`,
      nameFor: (author) => nameById.get(author) ?? (author === "operator" ? "You" : author),
    },
  };
}

/** The highest-scoring item, or null when nothing scored at all. */
function best<T>(items: readonly T[], scoreOf: (item: T) => number): T | null {
  let winner: T | null = null;
  let top = 0;
  for (const item of items) {
    const value = scoreOf(item);
    if (value > top) {
      top = value;
      winner = item;
    }
  }
  return winner;
}

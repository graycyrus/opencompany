import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Users } from "lucide-react";

import { BlindRoundBand } from "@/components/hive/BlindRoundBand";
import { StandingsRail } from "@/components/hive/StandingsRail";
import { VerdictCard } from "@/components/hive/VerdictCard";
import { cn } from "@/lib/utils";
import type { TimelineItem } from "@/views/chat/model";

/**
 * One room, in the transcript.
 *
 * A desk of two or more does not answer with a reply — it opens an **episode**
 * and runs a bounded sequence of single turns until it converges, deadlocks,
 * spends its budget, or finds it has nothing to say. Rendered as a flat list
 * those turns are indistinguishable from three agents talking, which is what the
 * console did before this block existed and is precisely the thing an operator
 * cannot afford to misread: three agents agreeing in parallel is not
 * deliberation.
 *
 * So the block draws the three facts a flat list cannot carry:
 *
 * - **which turns were blind**, because independence is the property a room
 *   actually buys over a single responder;
 * - **what the turns added up to**, so "is this decided yet" does not require
 *   holding six citations in your head;
 * - **how it ended**, in the desk's own words.
 *
 * The closing report is rendered *only* as the verdict card. It is excluded from
 * the row list rather than shown twice — as a grey system line and again as the
 * verdict — which is what it looked like before the exclusion.
 */
export function EpisodeBlock({
  item,
  renderRow,
  onSelectTopic,
  deskId,
}: {
  item: Extract<TimelineItem, { kind: "episode" }>;
  renderRow: (row: TimelineItem) => ReactNode;
  onSelectTopic?: (topic: string) => void;
  /**
   * The desk this room sat on, so the block can offer its grammar.
   *
   * This is where an operator learns the table is wrong — a seat demoted for a
   * move it does not hold, or a room that spent its budget with three seats
   * unable to support anything — so it is where the way to fix it belongs.
   */
  deskId?: string;
}) {
  const { episode } = item;
  const [open, setOpen] = useState(true);

  // The rows that carried the blind opening round, by message id — the block
  // splits on identity rather than on position, because an approval card or a
  // failed-turn note can sit between two turns without being one.
  const blindIds = new Set(
    episode.turns.slice(0, episode.blindCount).map((turn) => turn.messageId),
  );

  const rows = item.items.filter(
    (row) => !(row.kind === "message" && row.entry.message.id === episode.reportId),
  );
  const blindRows = rows.filter(
    (row) => row.kind === "message" && blindIds.has(row.entry.message.id),
  );
  const restRows = rows.filter((row) => !blindRows.includes(row));

  const speakers = new Set(episode.turns.map((turn) => turn.agentId));

  return (
    <section
      className="my-2 rounded-lg border border-border bg-muted/20 p-3"
      aria-label="Desk deliberation"
    >
      <header className="flex items-center gap-2 pb-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown aria-hidden className="size-3.5" />
          ) : (
            <ChevronRight aria-hidden className="size-3.5" />
          )}
          <Users aria-hidden className="size-3.5" />
          The desk deliberated
        </button>
        <span className="text-[11px] text-muted-foreground">
          {episode.turns.length} {episode.turns.length === 1 ? "turn" : "turns"} ·{" "}
          {speakers.size} {speakers.size === 1 ? "seat" : "seats"}
        </span>
        {deskId ? (
          <a
            href={`#/company/${encodeURIComponent(deskId)}?hive`}
            className="ml-auto text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground"
          >
            Move grammar
          </a>
        ) : null}
      </header>

      {open && (
        <div className="space-y-1">
          {blindRows.length > 0 && (
            <BlindRoundBand derived={episode.derived}>
              <div className="space-y-1">{blindRows.map(renderRow)}</div>
            </BlindRoundBand>
          )}
          {restRows.map(renderRow)}
        </div>
      )}

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <StandingsRail episode={episode} onSelectTopic={onSelectTopic} />
        {/*
          Always rendered, even mid-episode: a room still talking says so, and an
          operator watching one work needs the turn count and the standings more
          than they need the block to stay quiet until it is over.
        */}
        <VerdictCard
          episode={episode}
          onSelectTopic={onSelectTopic}
          className={cn(episode.topics.length === 0 && "lg:col-span-2")}
        />
      </div>
    </section>
  );
}

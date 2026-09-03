import { useEffect, useState } from "react";
import { AlertCircle, ArrowRight, Clock, Loader2, UserCheck } from "lucide-react";

import type { OpenCompanyClient } from "@/api/client";
import {
  listWorkflowRuns,
  listWorkflows,
  type WorkflowRunOutcome,
  type WorkflowSummary,
} from "@/api/workflows";
import { Button } from "@/components/ui/button";
import {
  gateApprovalTargets,
  gateWorkflowProgress,
  type GateWorkflowProgress,
} from "@/onboarding/workflow-progress";

/**
 * Step 3 of the first-run gate, built for the card it is drawn in (bugs
 * B-003 / B-004 / B-006).
 *
 * **Not `WorkflowsView`.** The gate used to embed that route-level view whole,
 * lazily, inside a checklist card. `WorkflowsView` is a page: a graph canvas, a
 * run-history rail and a floating Copilot panel, all of which size themselves
 * against a full-height route container. Given a ~280px card instead, the graph
 * clipped, the Copilot panel overlapped it, and the Copilot's own prompt text
 * was cut mid-sentence — while ~300px of the actual page sat empty underneath
 * (B-003). A component cannot be reused into a box that cannot give it what it
 * assumes; the honest fix is a different component, not a taller box.
 *
 * It also made every in-app link inside that view inert (B-006): the gate
 * renders instead of the router outlet, so "decide in Approvals" changed the
 * hash and re-rendered the same checklist. Everything this step offers goes out
 * through `onLeave` instead.
 *
 * What it shows is the one thing the step is actually about — whether a run has
 * happened and what it came to. A run parked on an approval is named and linked
 * rather than passed over in silence, which is B-004: the step stays honestly
 * unticked (the host is right that a parked run has proven nothing) but the
 * founder is told why and what would finish it.
 */
export function WorkflowStep({
  client,
  company,
  onOpenWorkflows,
  onOpenApprovals,
}: {
  client: OpenCompanyClient;
  company: string | null;
  /** Leaves the gate for the real Workflows page. */
  onOpenWorkflows: () => void;
  /** Leaves the gate for the real Approvals page. */
  onOpenApprovals: () => void;
}) {
  const [progress, setProgress] = useState<GateWorkflowProgress | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    // Independent reads, not `Promise.allSettled` on a shared await (CodeRabbit
    // review, PR #2046): the run history is the load-bearing half, and a slow
    // (not merely failed) workflow-name lookup must not hold the founder on
    // "Checking your runs…" once `listWorkflowRuns` has already answered.
    // Awaiting both together paid that cost even on the ordinary path, where
    // neither request fails — only one is slower than the other. Each promise
    // now publishes to state the moment it settles, so the run's own answer
    // never waits on a request that only replaces a fallback label.
    void listWorkflowRuns(client, company, { limit: 5 }).then(
      (page) => {
        if (!live) return;
        setProgress(gateWorkflowProgress(page.runs));
        setFailed(false);
      },
      () => {
        if (!live) return;
        setFailed(true);
      },
    );
    // A host that cannot list workflows (or predates the route, which answers
    // 404) should cost this step its labels, not its answer — so a rejection
    // here is silently left as the fallback `name()` already renders.
    void listWorkflows(client, company).then((workflows) => {
      if (!live) return;
      setNames(new Map(workflows.map((w: WorkflowSummary) => [w.id, w.name] as const)));
    }, () => {});
    return () => {
      live = false;
    };
  }, [client, company]);

  const label = (run: WorkflowRunOutcome | undefined) =>
    (run && names.get(run.workflowId)) ?? run?.workflowId ?? "your workflow";

  return (
    <div className="space-y-4" data-testid="gate-workflow-step">
      {progress === null && !failed && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          Checking your runs…
        </p>
      )}

      {failed && (
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t read this company&apos;s run history just now. Open Workflows to run
          one and watch it there.
        </p>
      )}

      {progress && <ProgressLine progress={progress} name={label(progress.run)} />}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onOpenWorkflows} data-testid="gate-workflow-open">
          Open Workflows
          <ArrowRight className="size-4" />
        </Button>
        {progress?.kind === "waiting-on-you" && gateApprovalTargets(progress.run).length > 0 && (
          <Button
            variant="outline"
            onClick={onOpenApprovals}
            data-testid="gate-workflow-open-approvals"
          >
            <UserCheck className="size-4" />
            Decide it in Approvals
          </Button>
        )}
      </div>
    </div>
  );
}

function ProgressLine({
  progress,
  name,
}: {
  progress: GateWorkflowProgress;
  name: string;
}) {
  const shell = (icon: React.ReactNode, body: React.ReactNode, testId: string) => (
    <p
      className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
      data-testid={testId}
    >
      {icon}
      <span>{body}</span>
    </p>
  );

  switch (progress.kind) {
    case "none":
      return (
        <p className="text-sm text-muted-foreground" data-testid="gate-workflow-none">
          No run yet. Open Workflows, pick one, and press Run — this step ticks when a run
          finishes.
        </p>
      );
    case "running":
      return shell(
        <Loader2 aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin" />,
        <>
          <span className="font-medium text-foreground">{name}</span> is still running. This
          step ticks when it finishes.
        </>,
        "gate-workflow-running",
      );
    case "waiting-on-you":
      // B-004: the sentence that was missing. It says the run happened, why it
      // did not count, and what closes it — rather than leaving the founder to
      // conclude the button did nothing.
      //
      // `blocked` gets its own sentence: `WorkflowRunOutcome.blockedNodes`
      // (frontend/src/api/workflows.ts) is explicit that an agent node is not
      // re-enterable, so deciding the card does NOT continue this run — the
      // operator still has to run the workflow again. Promising "the run
      // carries on" for that case would be a claim the host never makes;
      // `awaiting-approval` is the one where deciding really does resume it.
      return progress.verdict === "blocked"
        ? shell(
            <UserCheck aria-hidden className="mt-0.5 size-4 shrink-0" />,
            <>
              <span className="font-medium text-foreground">{name}</span> ran and stopped to
              ask you something — it&apos;s waiting on an approval, so it hasn&apos;t
              finished yet and this step hasn&apos;t ticked. Decide the approval, then run
              it again to finish.
            </>,
            "gate-workflow-blocked",
          )
        : shell(
            <UserCheck aria-hidden className="mt-0.5 size-4 shrink-0" />,
            <>
              <span className="font-medium text-foreground">{name}</span> ran and stopped to
              ask you something — it&apos;s waiting on an approval, so it hasn&apos;t
              finished yet and this step hasn&apos;t ticked. Decide the approval and the run
              carries on.
            </>,
            "gate-workflow-waiting",
          );
    case "needs-rerun":
      return shell(
        <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />,
        <>
          <span className="font-medium text-foreground">{name}</span> stopped on an approval
          that is no longer in the queue, so it can&apos;t be continued. Run it again.
        </>,
        "gate-workflow-needs-rerun",
      );
    case "did-not-finish":
      return shell(
        <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />,
        <>
          The last run of <span className="font-medium text-foreground">{name}</span> ended{" "}
          <span className="font-medium text-foreground">{progress.verdict}</span> rather than
          finishing cleanly, so this step hasn&apos;t ticked. Open Workflows to see what
          happened.
        </>,
        "gate-workflow-did-not-finish",
      );
    case "succeeded":
      return shell(
        <Clock aria-hidden className="mt-0.5 size-4 shrink-0" />,
        <>
          <span className="font-medium text-foreground">{name}</span> finished. This step
          ticks as soon as the console re-reads your setup.
        </>,
        "gate-workflow-succeeded",
      );
  }
}

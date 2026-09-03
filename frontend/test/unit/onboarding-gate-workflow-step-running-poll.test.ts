// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenCompanyClient } from "@/api/client";
import { WorkflowStep } from "@/onboarding/WorkflowStep";

/**
 * Codex review, PR #2046: `WorkflowStep`'s mount effect reads run history
 * exactly once per `(client, company)`. If the newest run is `running` when
 * that read lands and later settles (to `blocked`, `failed`, success —
 * anything), nothing re-fetches: `client`/`company` do not change just
 * because a run finished, and the activation poll cannot unmount this step
 * for a run that has not (yet) succeeded. Before the fix the card would say
 * "is still running" forever, until the founder collapsed and reopened the
 * step or reloaded the page — hiding an approval or failure that needed
 * their attention.
 */

const runningRun = {
  seq: 1,
  atMillis: 1_700_000_000_000,
  workflowId: "research-request",
  scheduled: false,
  deliveries: [],
  pendingApprovals: [],
  running: true,
  verdict: "running" as const,
};

const succeededRun = { ...runningRun, verdict: "ok" as const, running: false };

let container: HTMLDivElement;
let root: Root;

function fakeClient(getRuns: () => Promise<{ runs: unknown[]; hasMore: boolean }>): OpenCompanyClient {
  return {
    scopeFor: () => "/api/v1/company",
    get: async (path: string) => {
      if (path.includes("/workflows/runs")) return getRuns();
      if (path.includes("/workflows")) return [];
      throw new Error(`unexpected path: ${path}`);
    },
  } as unknown as OpenCompanyClient;
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("WorkflowStep re-polls a run that was running when it mounted", () => {
  it("picks up the run settling without an unmount/reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const client = fakeClient(async () => {
      calls += 1;
      // First read (the mount effect): the run is still going. Every read
      // after that (the poll): it has finished.
      return { runs: [calls === 1 ? runningRun : succeededRun], hasMore: false };
    });

    await act(async () => {
      root.render(
        createElement(WorkflowStep, {
          client,
          company: null,
          onOpenWorkflows: () => {},
          onOpenApprovals: () => {},
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      container.querySelector('[data-testid="gate-workflow-running"]'),
      "the initial read must render the running state",
    ).toBeTruthy();
    expect(calls).toBe(1);

    // Advance past one poll tick without unmounting or changing props.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(calls, "the running state must have triggered a re-poll").toBeGreaterThan(1);
    expect(
      container.querySelector('[data-testid="gate-workflow-succeeded"]'),
      "the card must pick up the run settling without an unmount or reload",
    ).toBeTruthy();
    expect(container.querySelector('[data-testid="gate-workflow-running"]')).toBeNull();
  });

  it("keeps the newer terminal result when an older poll's response arrives later", async () => {
    // CodeRabbit review, PR #2046: a tick fires the next `listWorkflowRuns`
    // read without waiting for the previous one, so two requests can be in
    // flight at once. If the OLDER one's response lands AFTER a NEWER one
    // already moved the card to a terminal state, it must not overwrite that
    // with its own stale "running" reading.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const deferred: Record<number, (v: { runs: unknown[]; hasMore: boolean }) => void> = {};
    const client = fakeClient(() => {
      calls += 1;
      const thisCall = calls;
      if (thisCall === 1) return Promise.resolve({ runs: [runningRun], hasMore: false });
      return new Promise((resolve) => {
        deferred[thisCall] = resolve;
      });
    });

    await act(async () => {
      root.render(
        createElement(WorkflowStep, {
          client,
          company: null,
          onOpenWorkflows: () => {},
          onOpenApprovals: () => {},
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toBe(1);

    // Two poll ticks, each issuing a new request that is left pending.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls).toBe(3);

    // Resolve them OUT OF ORDER, back to back before anything yields control
    // to React's effect scheduler: the newer request (#3) lands first with a
    // terminal result, then the older one (#2) lands with a stale "still
    // running" — both while the same poll-effect instance that issued them
    // is still current, so a bare "did the effect unmount" flag would not
    // catch this; only comparing against the latest ISSUED request does.
    await act(async () => {
      deferred[3]({ runs: [succeededRun], hasMore: false });
      deferred[2]({ runs: [runningRun], hasMore: false });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="gate-workflow-succeeded"]'),
      "the newer terminal response must win",
    ).toBeTruthy();
    expect(
      container.querySelector('[data-testid="gate-workflow-running"]'),
      "the older, later-arriving response must not revert the card to running",
    ).toBeNull();
  });

  it("does not keep polling once the run has settled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const client = fakeClient(async () => {
      calls += 1;
      return { runs: [succeededRun], hasMore: false };
    });

    await act(async () => {
      root.render(
        createElement(WorkflowStep, {
          client,
          company: null,
          onOpenWorkflows: () => {},
          onOpenApprovals: () => {},
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(calls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    // No `running` progress was ever observed, so the poll effect never
    // armed — a settled run on the very first read must cost nothing extra.
    expect(calls, "an already-settled run must not be polled").toBe(1);
  });
});

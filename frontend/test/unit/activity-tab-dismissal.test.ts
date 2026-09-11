// @vitest-environment jsdom

/**
 * What happens to a row between the click on Dismiss and the poll that settles
 * it — the window where the list is showing something it has been told, but not
 * yet proved, is gone.
 *
 * `ActivityTab` hides the row locally the instant it is clicked, because the
 * alternative is a list that ignores you for a poll interval. That optimism is
 * only honest if it is released: the host's `list()` serialises unread rows
 * only, so a write that fails leaves the row unread server-side while the
 * component goes on filtering it out — hidden here, unread there, visible to
 * nobody until the component happens to unmount (Codex, CodeRabbit).
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NotificationDto } from "@/api/types";
import { ActivityTab } from "@/views/notifications/ActivityTab";

const NOW = new Date("2026-09-11T10:00:00Z").getTime();

const CHANNELS = {
  rendered: new Set(["desk-ops"]),
  mainChannelId: "desk-ops",
};

function row(over: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id: "n1",
    kind: "dispatch_failed",
    subjectKind: "task",
    subjectId: "t-1",
    title: "A card's dispatch failed and returned to To-do",
    createdAt: NOW - 1_000,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(notifications: readonly NotificationDto[], onDismiss: (id: string) => Promise<void>) {
  act(() => {
    root.render(
      createElement(ActivityTab, {
        notifications,
        now: NOW,
        channels: CHANNELS,
        onDismiss,
        onDismissAll: () => undefined,
      }),
    );
  });
}

const listed = () => [...container.querySelectorAll("[data-testid=activity-row]")].length;

const clickDismiss = () =>
  act(() => {
    (container.querySelector("[data-testid=activity-row] button") as HTMLButtonElement).click();
  });

describe("dismissing one row", () => {
  it("takes it off the list at the click, not at the next poll", async () => {
    let settle: () => void = () => undefined;
    render([row()], () => new Promise<void>((r) => (settle = r)));

    expect(listed()).toBe(1);
    clickDismiss();
    expect(listed()).toBe(0);

    // The write has not even finished yet — that is the point of the hide.
    await act(async () => {
      settle();
    });
  });

  it("puts it back when the write fails and the shell restores it unread", async () => {
    // The shell's refresh hands the same unread row back down. Without the
    // release, `dismissing` still holds its id and the row stays filtered out
    // of a list whose whole claim is "this is what is still waiting for you".
    const rows = [row()];
    await act(async () => {
      root.render(
        createElement(ActivityTab, {
          notifications: rows,
          now: NOW,
          channels: CHANNELS,
          onDismiss: () => Promise.reject(new Error("offline")),
          onDismissAll: () => undefined,
        }),
      );
    });

    expect(listed()).toBe(1);
    await act(async () => {
      (container.querySelector("[data-testid=activity-row] button") as HTMLButtonElement).click();
    });

    expect(listed()).toBe(1);
    expect(container.querySelector("[data-testid=activity-row]")?.getAttribute("data-kind")).toBe(
      "dispatch_failed",
    );
  });

  it("keeps it off the list when the write succeeds", async () => {
    // Faithful to the shell: `markNotificationsRead` stamps `readAt` on the
    // feed *before* it issues the request, and the poll after it drops the row
    // for good. So releasing the local hide is a no-op on this path — and it
    // must stay one, or a release would resurrect a row that really was
    // dismissed.
    const shell = (readAt?: number) =>
      createElement(ActivityTab, {
        notifications: [row(readAt === undefined ? {} : { readAt })],
        now: NOW,
        channels: CHANNELS,
        onDismiss: () => {
          act(() => root.render(shell(NOW)));
          return Promise.resolve();
        },
        onDismissAll: () => undefined,
      });

    await act(async () => {
      root.render(shell());
    });
    expect(listed()).toBe(1);

    await act(async () => {
      (container.querySelector("[data-testid=activity-row] button") as HTMLButtonElement).click();
    });
    expect(listed()).toBe(0);
  });

  it("releases the hide even for a caller that returns nothing at all", async () => {
    // The prop is `void | Promise<void>`: a caller with nothing to await is
    // allowed, and must not be the one case that leaves a row hidden forever.
    // This fixture never stamps `readAt`, so the row coming back is the proof
    // the release ran — a real shell would have stamped it by now.
    await act(async () => {
      root.render(
        createElement(ActivityTab, {
          notifications: [row()],
          now: NOW,
          channels: CHANNELS,
          onDismiss: () => undefined,
          onDismissAll: () => undefined,
        }),
      );
    });

    await act(async () => {
      (container.querySelector("[data-testid=activity-row] button") as HTMLButtonElement).click();
    });
    expect(listed()).toBe(1);
  });
});

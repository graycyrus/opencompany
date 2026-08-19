import { expect, test, type Page } from "@playwright/test";

/**
 * Issue #1178: the console is an object inset inside the window, not a
 * wallpaper that runs to its edges.
 *
 * **Geometry is the assertion.** The frame is three numbers and a breakpoint —
 * an inset on three sides, a radius, and a border, all of which collapse to
 * zero below `lg` — and every one of them is a thing a stylesheet edit can
 * silently take away while the console still renders perfectly well. Reading
 * the class names back would pass against a build where the media query never
 * matched.
 *
 * Two failure modes this pins that are not obvious from a screenshot:
 *
 *   1. **The frame growing the document.** The ground is `100svh` with the
 *      inset as padding, so `border-box` keeps the pair exactly one viewport
 *      tall. Move that padding to the wrong box and the page becomes
 *      `100svh + inset` — a document scrollbar down the side of an app that
 *      is not supposed to scroll, and 12px of the console below the fold.
 *   2. **A view that still thinks it owns the viewport.** `Overview` sized
 *      itself `h-svh`, which now overflows its slot by exactly the inset and
 *      gets clipped by the shell's `overflow-hidden` — no scrollbar, just a
 *      graph with its bottom edge missing. Any view that reaches for a
 *      viewport unit again fails here.
 *
 * The narrow case is the other half of the design and not a formality: below
 * `lg` the frame is gone entirely, not flattened. A radius kept at zero inset
 * rounds the corners against the window edge and lets the ground show through
 * as two stray tinted notches; a border kept there draws a hairline down the
 * outside of the screen.
 */

/** Dismisses the first-run tour before it can cover the app. */
async function skipTour(page: Page) {
  await page.addInitScript(() => {
    const real = Storage.prototype.getItem;
    Storage.prototype.getItem = function getItem(key: string) {
      return key.startsWith("oc-tour:") ? '{"skipped":true}' : real.call(this, key);
    };
  });
}

type Frame = {
  ground: { x: number; y: number; width: number; height: number };
  frame: { x: number; y: number; width: number; height: number };
  radius: number;
  borderTop: number;
  borderBottom: number;
  documentOverflowY: number;
  documentOverflowX: number;
};

/** Measures the frame as the browser resolved it, not as the classes read. */
async function measure(page: Page): Promise<Frame> {
  return page.evaluate(() => {
    const ground = document.querySelector("[data-slot=sidebar-ground]")!;
    const frame = document.querySelector("[data-slot=sidebar-wrapper]")!;
    const style = getComputedStyle(frame);
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const root = document.documentElement;
    return {
      ground: box(ground),
      frame: box(frame),
      radius: parseFloat(style.borderTopLeftRadius),
      borderTop: parseFloat(style.borderTopWidth),
      borderBottom: parseFloat(style.borderBottomWidth),
      documentOverflowY: root.scrollHeight - root.clientHeight,
      documentOverflowX: root.scrollWidth - root.clientWidth,
    };
  });
}

test("at a desktop width the console is inset on three sides and flush to the bottom", async ({
  page,
}) => {
  await skipTour(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/overview");
  await expect(page.locator("[data-slot=sidebar-wrapper]")).toBeVisible();

  const m = await measure(page);

  // The ground is the window. Nothing shows behind it and nothing scrolls.
  expect(m.ground.width, "the ground fills the window").toBe(1440);
  expect(m.ground.height, "the ground is exactly one viewport tall").toBe(900);
  expect(m.documentOverflowY, "the frame must not grow the document").toBe(0);
  expect(m.documentOverflowX, "the frame must not grow the document").toBe(0);

  // Three sides inset by the same amount, and the fourth flush — the whole
  // point of the shape. Vertical space is the scarcest thing in this app, so
  // only ONE inset comes out of the height.
  const inset = m.frame.x;
  expect(inset, "the console is inset from the window").toBeGreaterThan(0);
  expect(m.frame.y, "the top inset matches the side inset").toBe(inset);
  expect(
    m.ground.width - (m.frame.x + m.frame.width),
    "the right inset matches the left",
  ).toBe(inset);
  expect(
    m.frame.y + m.frame.height,
    "the console runs to the bottom of the window",
  ).toBe(m.ground.height);

  // A card, not a rectangle: rounded at the two corners that are inset, and
  // closed with an edge on the three sides that are.
  expect(m.radius, "the inset corners are rounded").toBeGreaterThan(0);
  expect(m.borderTop, "the inset sides carry an edge").toBeGreaterThan(0);
  expect(m.borderBottom, "the flush side does not").toBe(0);
});

test("below lg the frame collapses to edge-to-edge rather than shrinking", async ({
  page,
}) => {
  await skipTour(page);
  // 1023: one pixel under the `lg` breakpoint the frame appears at. A width
  // where the console still shows its full desktop sidebar, so the frame's
  // absence here is a decision rather than a side effect of the mobile sheet.
  await page.setViewportSize({ width: 1023, height: 800 });
  await page.goto("/#/overview");
  await expect(page.locator("[data-slot=sidebar-wrapper]")).toBeVisible();

  const m = await measure(page);

  expect(m.frame.x, "no left inset").toBe(0);
  expect(m.frame.y, "no top inset").toBe(0);
  expect(m.frame.width, "the console spans the window").toBe(m.ground.width);
  expect(m.frame.height, "and its full height").toBe(m.ground.height);
  // Not merely a thinner frame: a radius here would round the corners against
  // the window edge, and a border would ride the outside of the screen.
  expect(m.radius, "no radius at the window edge").toBe(0);
  expect(m.borderTop, "no edge at the window edge").toBe(0);
});

test("the frame appears exactly at lg, and every view fits inside it", async ({ page }) => {
  await skipTour(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto("/#/overview");
  await expect(page.locator("[data-slot=sidebar-wrapper]")).toBeVisible();
  expect((await measure(page)).frame.x, "the frame is on at lg").toBeGreaterThan(0);

  // Issue #1178's regression: `Overview` sized itself to the viewport, so it
  // overflowed its slot by the frame's inset and the shell clipped the bottom
  // of the graph with no scrollbar to say so. Checked on the Overview because
  // it is the one view that had a viewport unit, and it is still the widest
  // and tallest thing the console draws.
  await page.setViewportSize({ width: 1440, height: 900 });
  const m = await measure(page);
  const graph = (await page.locator("[data-tour=overview-graph]").boundingBox())!;
  expect(
    graph.y + graph.height,
    "the Overview must end at the frame's bottom, not past it",
  ).toBeLessThanOrEqual(m.frame.y + m.frame.height + 1);
  expect(
    graph.x + graph.width,
    "and inside its right edge",
  ).toBeLessThanOrEqual(m.frame.x + m.frame.width + 1);
});

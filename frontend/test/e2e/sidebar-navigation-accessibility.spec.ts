import { expect, test } from "@playwright/test";

// The first-run tour is modal and correctly receives focus while it is open;
// skip it here so this spec can exercise the shell's ordinary tab order.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const real = Storage.prototype.getItem;
    Storage.prototype.getItem = function getItem(key: string) {
      return key.startsWith("oc-tour:") ? '{"skipped":true}' : real.call(this, key);
    };
  });
});

test("the skip link reaches main content and the sidebar is the primary navigation", async ({
  page,
}) => {
  await page.goto("/#/company");

  const skip = page.getByRole("link", { name: "Skip to content", exact: true });
  const main = page.getByRole("main");

  // The console boots through a "Connecting…" phase that has no shell and so
  // no skip link; a Tab pressed against that phase moves focus nowhere. The
  // skip link exists only once the shell (and its sidebar) has mounted, so
  // waiting for it is the app-ready signal — and the sidebar's chrome renders
  // in the same commit, so nothing focusable appears between them.
  await skip.waitFor();

  // This is the first tab stop, ahead of the sidebar's host switcher and its
  // destination rows, even though the fixed sidebar renders before main.
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();

  // Hash routing owns `window.location.hash`; the skip link must focus main
  // without turning its conventional fragment into a route change.
  await page.keyboard.press("Enter");
  await expect(main).toBeFocused();
  await expect(main).toHaveAttribute("id", "main-content");
  await expect(page).toHaveURL(/#\/company$/);

  const navigation = page.getByRole("navigation", { name: "Main navigation", exact: true });
  await expect(navigation).toBeVisible();
  // Four sections, and the four are the whole list. Asserted by count as well
  // as by name: a fifth row creeping back in is the thing this restructure
  // exists to stop, and four `toBeVisible` calls would not notice it.
  for (const name of ["Room", "Company", "Connections", "Automations"]) {
    await expect(navigation.getByRole("button", { name, exact: true })).toBeVisible();
  }
  // Scoped to the FIRST group — the fixed four. The group after it holds the
  // active section's contents, which is a different question and a different
  // count. Asserted by count as well as by name: a fifth row creeping back in
  // is the thing this restructure exists to stop, and four `toBeVisible` calls
  // would not notice it.
  await expect(
    page.locator("[data-slot=sidebar-content] [data-sidebar=group]").first()
      .locator("[data-sidebar=menu-button]"),
  ).toHaveCount(4);
  // Overview is not among them: it is chrome in the window's title row now,
  // not a destination in a list of destinations. Observatory never had a row
  // here — it is filed under Settings (`settings-pages.ts`). Approvals followed
  // Overview out of this column: it is the Approvals tab of the Notifications
  // page now, reached from the title row's bell asserted at the end of this
  // test rather than from a row here.
  for (const name of ["Overview", "Observatory", "Approvals"]) {
    await expect(navigation.getByRole("button", { name, exact: true })).toHaveCount(0);
  }

  // Settings and Discord are glyphs in the window's title row now
  // (`title-bar-utilities.tsx`), not a labelled footer group in the sidebar —
  // the sidebar footer this used to check is gone entirely ("No footer." per
  // `app-shell.tsx`). Feedback went further: it left the title row too and is
  // a plain row on the Settings rail (`#/settings/feedback`), so it is
  // asserted absent from both chrome positions rather than present in either.
  await expect(page.getByTestId("title-bar-settings")).toBeVisible();
  await expect(page.getByTestId("title-bar-discord")).toBeVisible();
  await expect(page.getByRole("button", { name: "Feedback", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Feedback", exact: true })).toHaveCount(0);

  // Not interleaved with the destinations: `sidebar-content` is the list of
  // places inside this company, and none of the console's own chrome belongs
  // in it.
  const destinations = page.locator("[data-slot=sidebar-content]");
  await expect(destinations.getByRole("button", { name: "Room", exact: true })).toBeVisible();
  await expect(destinations.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-slot=sidebar-footer]")).toHaveCount(0);

  // The bell that replaced the Approvals row. An icon-only control is a
  // destination only if it has an accessible name, which is this spec's whole
  // subject — so the guarantee moves with the feature instead of being dropped
  // when the row was. The name is "Notifications" at rest and
  // "Notifications — N approvals need you" once something is waiting
  // (`notifications-button.tsx`), so it is matched on the destination's name
  // leading it rather than on a count this fixture does not fix.
  const bell = page.getByTestId("title-bar-notifications");
  await expect(bell).toBeVisible();
  await expect(bell).toHaveAccessibleName(/^Notifications/);
  await bell.click();
  await expect(page).toHaveURL(/#\/notifications$/);
  await expect(page.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible();
});

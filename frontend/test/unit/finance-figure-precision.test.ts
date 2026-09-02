import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { formatUsd } from "@/lib/cost";
import { money } from "@/lib/language";

/**
 * Issue B-016: Finance said "Spend · US$0 this month" on the same screen that
 * listed that month's spend.
 *
 * The transactions beside it, all dated 2 Sept: `brand_designer −US$0.08`,
 * `brand_designer −US$0.06`, `researcher −US$0.02`. The Wallet balance tile:
 * −US$0.16. The Spend tile: US$0, and Net: −US$0 in red.
 *
 * Nothing was wrong with the numbers. The Spend/Revenue/Net tiles formatted to
 * whole dollars while the rows and the balance beside them formatted to cents,
 * so every real amount under fifty cents read as nothing — and a founder was
 * told they had spent nothing while they were being billed.
 *
 * The cause is not any one tile. The formatter took its precision as an
 * argument, so "how many decimals does money have here?" was a question each
 * call site answered for itself, and three of them answered zero. `formatUsd`
 * takes no such argument, which is what makes this unrepeatable rather than
 * fixed three times.
 */

describe("a USD figure the operator reads as money", () => {
  it("renders the founder's spend as the amount it is, not as zero", () => {
    // The exact numbers off the screenshot.
    expect(formatUsd(0.16)).toBe("$0.16");
    expect(formatUsd(-0.16)).toBe("-$0.16");
    expect(formatUsd(0.08)).toBe("$0.08");
    expect(formatUsd(0.02)).toBe("$0.02");
  });

  it("uses the same precision for a tile as for the rows beneath it", () => {
    // The whole bug in one assertion: the Spend tile and a transaction row are
    // now the same call, so they cannot disagree.
    const spend = 0.16;
    expect(formatUsd(spend)).toBe(formatUsd(0.08 + 0.06 + 0.02));
  });

  it("keeps trailing cents on a round amount, so the column stays aligned", () => {
    expect(formatUsd(5)).toBe("$5.00");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });

  it("says nothing only when there is nothing", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("never renders a real charge as $0.00", () => {
    // The same lie one order of magnitude down. An inference turn genuinely
    // costs fractions of a cent, and the Observatory reports costs like $0.019.
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(-0.004)).toBe("−<$0.01");
    expect(formatUsd(0.0001)).toBe("<$0.01");
  });

  it("does not put a minus sign in front of nothing", () => {
    // `revenue - spend` on a company with neither is `-0`, and `Intl` renders
    // that `-$0.00` — on the tile whose job is saying whether you are up or
    // down.
    expect(formatUsd(-0)).toBe("$0.00");
    expect(formatUsd(0 - 0)).toBe("$0.00");
  });

  it("refuses to invent a figure it was not given", () => {
    expect(formatUsd(Number.NaN)).toBe("—");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("the console has one USD formatter, not several", () => {
  it("routes an approval's amount through the same one", () => {
    // `money()` was the second independent formatter and carried the same
    // failure in miniature: an approval for less than a cent rendered `$0.00`,
    // asking an operator to authorise a payment the card called free.
    expect(money(0.004)).toBe(formatUsd(0.004));
    expect(money(0.004)).not.toBe("$0.00");
    expect(money(12.5)).toBe("$12.50");
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => readFileSync(resolve(here, "../../src", rel), "utf8");

  it("leaves no view formatting currency for itself", () => {
    // Finance is where this was found; the assertion is that the view no longer
    // owns a formatter at all, not that this particular one was corrected.
    const view = read("views/FinancesView.tsx");
    expect(view).toContain('from "@/lib/cost"');
    expect(view).not.toContain('style: "currency"');
    // The argument that made "how precise is money?" a per-call-site decision.
    expect(view).not.toMatch(/maximumFractionDigits/);
  });

  it("gives no caller a way to ask for fewer decimals", () => {
    // `formatUsd(x, 0)` must not typecheck or quietly work — a second argument
    // is how the whole-dollar tiles came about. Called with one and ignoring
    // anything else is the property; the type signature is the enforcement.
    const cost = read("lib/cost.ts");
    expect(cost).toMatch(/export function formatUsd\(amount: number\): string/);
  });
});

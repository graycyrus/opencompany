import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 1400 } });
await p.goto("http://localhost:5199/#/styleguide", { waitUntil: "networkidle" });
await p.waitForTimeout(800);
const panel = p.locator("section", { has: p.locator("h2", { hasText: "Move grammar" }) }).first();
await panel.scrollIntoViewIfNeeded();
// Take support away from the three seats that hold it besides the programmer.
for (const seat of ["Theorist", "Verifier", "Brute forcer"]) {
  await panel.getByLabel(`${seat} may supports`).uncheck();
}
await p.waitForTimeout(200);
const line = await panel.locator("p[role=alert]").first().textContent();
console.log("ALERT:", line);
const installDisabled = await panel.getByRole("button", { name: "Install" }).isDisabled();
console.log("install disabled:", installDisabled);
await panel.screenshot({ path: process.argv[2] });
await b.close();

import { chromium } from "@playwright/test";
const out = process.argv[2];
const theme = process.argv[3] ?? "light";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1100, height: 2600 } });
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await p.goto("http://localhost:5199/#/styleguide", { waitUntil: "networkidle" });
if (theme === "dark") {
  await p.evaluate(() => document.documentElement.classList.add("dark"));
}
await p.waitForTimeout(600);
const h = await p.locator("h2", { hasText: "Deliberation" }).first();
await h.scrollIntoViewIfNeeded();
await p.waitForTimeout(300);
const section = p.locator("section").filter({ has: p.locator("h2", { hasText: "Deliberation" }) });
await section.screenshot({ path: out });
console.log("errors:", errors.length ? errors.slice(0,5) : "none");
await b.close();

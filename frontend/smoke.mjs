import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await p.goto("http://localhost:5199/#/styleguide", { waitUntil: "networkidle" });
await p.waitForTimeout(1200);
// The shell itself: no host is configured, so this exercises AppShell's mount
// path and the store's enterScope, which is what the refactor touched.
await p.goto("http://localhost:5199/#/chat", { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
console.log("page errors:", errs.length ? errs.slice(0, 6) : "none");
await p.screenshot({ path: process.argv[2] });
await b.close();

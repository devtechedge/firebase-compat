// Drives the demo app and dashboard in headless Chrome against a local server and saves screenshots.
import { chromium } from "playwright-core";
const site = process.argv[2] ?? "http://localhost:3000";
const out = process.argv[3] ?? "../../docs/screenshots";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const a = await ctx.newPage();
const b = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await a.goto(`${site}/`); await a.waitForTimeout(800); await a.screenshot({ path: `${out}/home.png`, fullPage: true });
const email = `demo${Date.now()}@example.com`;
await a.goto(`${site}/demo`);
await a.fill('input[placeholder="email"]', email); await a.fill('input[placeholder="password (6+ chars)"]', "secret123");
await a.click("text=Create account");
await a.fill('input[placeholder="display name"]', "Alice"); await a.click("text=Set name");
await b.goto(`${site}/demo`); await b.click("text=Continue anonymously");
for (const t of ["Hi from the unmodified Firebase SDK", "This is Firestore over WebChannel"]) { await a.fill('input[placeholder="Message"]', t); await a.press('input[placeholder="Message"]', "Enter"); await a.waitForTimeout(300); }
await b.waitForSelector("text=This is Firestore over WebChannel", { timeout: 10000 });
await b.fill('input[placeholder="Message"]', "Realtime sync works across windows"); await b.press('input[placeholder="Message"]', "Enter");
await a.waitForSelector("text=Realtime sync works across windows", { timeout: 10000 });
await a.waitForTimeout(500);
await a.screenshot({ path: `${out}/demo.png` });
console.log("realtime sync verified between two browser contexts");
await a.goto(`${site}/dashboard`); await a.waitForSelector("text=connected to"); await a.waitForTimeout(500); await a.screenshot({ path: `${out}/dashboard.png` });
await a.click("button:has-text('users')"); await a.waitForTimeout(700); await a.screenshot({ path: `${out}/dashboard-users.png` });
await a.click("button:has-text('firestore')"); await a.waitForTimeout(500); await a.click(".list button:has-text('rooms')"); await a.waitForTimeout(600); await a.screenshot({ path: `${out}/dashboard-firestore.png` });
await a.click("button:has-text('rules')"); await a.waitForTimeout(600); await a.screenshot({ path: `${out}/dashboard-rules.png` });
await browser.close();

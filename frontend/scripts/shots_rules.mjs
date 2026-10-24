// Visual QA for the Rules Studio (/rules): default, edited parameter + impact dock, builder preview, rejected rule — dark + light.
//   SHOTS_URL=http://127.0.0.1:8766 node scripts/shots_rules.mjs      (a running `make demo`; previews store nothing)
//   → /shots/rules/<n>-<state>__<theme>.png
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.join(root, "shots", "rules");
mkdirSync(out, { recursive: true });
const base = process.env.SHOTS_URL ?? "http://127.0.0.1:8000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const browser = await chromium.launch();
let n = 0;
try {
  for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("optislot-theme", t); localStorage.setItem("optislot-motion", "calm"); sessionStorage.setItem("optislot-dive-seen", "1"); } catch { /* ignore */ } }, theme);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => problems.push(`${theme}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !/422|Failed to load resource/.test(m.text()) && problems.push(`${theme}: ${m.text()}`));
    const shot = async (name, el) => { await sleep(350); await (el ?? page).screenshot({ path: path.join(out, `${name}__${theme}.png`) }); n++; };

    await page.goto(`${base}/rules?project=demo`, { waitUntil: "networkidle" });
    await page.getByTestId("rule-r-wired-spare").waitFor();
    await shot("01-default");

    // 2. edit a parameter → debounced preview in the dock
    const pct = page.getByLabel("r-wired-spare Target");
    await pct.fill("20");
    await page.getByTestId("rule-impact").waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="rule-impact"]')?.getAttribute("aria-busy") === "false", null, { timeout: 60_000 });
    await shot("02-edit-preview");
    await page.getByTestId("rules-discard").click();

    // 3. builder: a valid rule, previewed (tall viewport so the whole form + impact is in frame)
    await page.setViewportSize({ width: 1440, height: 1900 });
    await page.getByRole("radio", { name: /Forbid/i }).click();
    const b = page.getByTestId("rule-builder");
    await b.getByRole("button", { name: "AIR", exact: true }).first().click();
    await b.getByRole("button", { name: "DIR", exact: true }).nth(1).click();
    await page.getByTestId("rule-builder").locator('[data-testid="rule-impact"]').waitFor({ timeout: 60_000 });
    await shot("03-builder-preview", page.locator("aside"));

    // 4. builder: a rule the backend rejects (negative maximum) → reason inline
    await page.getByRole("radio", { name: /Limit signals/i }).click();
    await page.getByLabel("Max").fill("-2");
    await page.getByTestId("rule-rejected").waitFor({ timeout: 60_000 }).catch(() => problems.push(`${theme}: no inline rejection`));
    await shot("04-rejected", page.locator("aside"));
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`${n} screenshots → ${out}`);
if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }

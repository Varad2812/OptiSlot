// Visual-QA capture: every route × {1440×900, 1920×1080} × {dark, light} → /shots/*.png  (CLAUDE.md §10)
//   npm run shots                      builds the frontend, serves it with the real API, captures, stops the server
//   SHOTS_URL=http://127.0.0.1:8000 …  reuse an already-running `make demo` / `make dev` instead
//   SHOTS_ROUTES=/floor,/tqs …         capture a subset
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(root, "shots");

// Keep in sync with SCREENS in src/routes/index.tsx (+ the design kit).
const ROUTES = ["/", "/import", "/rules", "/floor", "/grid", "/tqs", "/revisions", "/export", "/kit"];
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
const THEMES = ["dark", "light"];

const routes = process.env.SHOTS_ROUTES ? process.env.SHOTS_ROUTES.split(",") : ROUTES;
const slug = (r) => (r === "/" ? "mission-control" : r.slice(1).replace(/\//g, "-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy(base) {
  try {
    return (await fetch(`${base}/api/health`)).ok;
  } catch {
    return false;
  }
}

async function startServer() {
  const port = 8765;
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, OPTISLOT_DB: path.join(mkdtempSync(path.join(tmpdir(), "optislot-shots-")), "shots.db") };
  const proc = spawn("uv", ["run", "uvicorn", "app.main:app", "--port", String(port), "--log-level", "warning"], {
    cwd: path.join(root, "backend"), env, stdio: ["ignore", "inherit", "inherit"],
  });
  for (let i = 0; i < 120; i++) {
    if (await healthy(base)) return { base, stop: () => proc.kill() };
    await sleep(500);
  }
  proc.kill();
  throw new Error("backend did not become healthy in 60 s");
}

let server = null;
let base = process.env.SHOTS_URL;
if (base ? !(await healthy(base)) : true) {
  if (base) throw new Error(`SHOTS_URL ${base} is not answering /api/health`);
  server = await startServer();
  base = server.base;
}

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
let count = 0;
const problems = [];
try {
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
      await ctx.addInitScript((t) => {
        try { localStorage.setItem("optislot-theme", t); } catch { /* ignore */ }
      }, theme);
      for (const route of routes) {
        const page = await ctx.newPage();
        page.on("pageerror", (e) => problems.push(`${route} ${theme}: ${e.message}`));
        page.on("console", (m) => m.type() === "error" && problems.push(`${route} ${theme}: ${m.text()}`));
        page.on("requestfailed", (r) => problems.push(`${route} ${theme}: request failed ${r.url()}`));
        await page.goto(base + route, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        await sleep(400); // let enter animations settle
        const file = path.join(outDir, `${slug(route)}__${vp.width}x${vp.height}__${theme}.png`);
        await page.screenshot({ path: file });
        count++;
        await page.close();
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server?.stop();
}
console.log(`${count} screenshots → ${outDir}`);
if (problems.length) {
  console.error(`\n${problems.length} browser problem(s):\n  ` + [...new Set(problems)].join("\n  "));
  process.exitCode = 1;
}

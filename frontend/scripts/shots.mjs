// Visual-QA capture (CLAUDE.md §10.6)
//   routes:  every route × {1440×900, 1920×1080} × {dark, light}          → /shots/<route>__<vp>__<theme>.png
//   motion:  Upload Dive + cabinet glide frozen at 0/25/50/75/100 %        → /shots/motion/<seq>__p<NNN>__<theme>.png
//            Rev B diff (inject silently, then scrub) at 0/50/100 %          → /shots/motion/revb__p<NNN>__<theme>.png
//   stress:  the 10k project in the Explorer (stills + glide FPS)          → /shots/stress/*.png
//   npm run shots                      builds the frontend, serves it with the real API (temp DB, seeds stress10k), captures
//   SHOTS_URL=http://127.0.0.1:8000 …  reuse an already-running `make demo` / `make dev` instead
//   SHOTS_ROUTES=/explorer,/tqs …      capture a subset of routes
//   SHOTS_MOTION_ONLY=1                skip the route pass · SHOTS_NO_STRESS=1 skip the 10k pass
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(root, "shots");

// Keep in sync with SCREENS in src/shell/routes.ts.
const ROUTES = ["/", "/explorer", "/lab", "/proof", "/revisions", "/import", "/rules", "/tqs", "/grid", "/export"];
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
const THEMES = ["dark", "light"];
const FRAMES = [0, 0.25, 0.5, 0.75, 1];

const routes = process.env.SHOTS_ROUTES ? process.env.SHOTS_ROUTES.split(",") : ROUTES;
const motionOnly = !!process.env.SHOTS_MOTION_ONLY;
const noStress = !!process.env.SHOTS_NO_STRESS;
const slug = (r) => (r === "/" ? "mission-control" : r.slice(1).replace(/\//g, "-"));
const pct = (p) => String(Math.round(p * 100)).padStart(3, "0");
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
  if (!noStress) {
    const r = spawnSync("uv", ["run", "--project", "backend", "python", "scripts/seed_stress.py"], { cwd: root, env, stdio: "inherit" });
    if (r.status !== 0) throw new Error("seed_stress.py failed");
  }
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

mkdirSync(path.join(outDir, "motion"), { recursive: true });
mkdirSync(path.join(outDir, "stress"), { recursive: true });
const browser = await chromium.launch();
let count = 0;
const problems = [];
const perf = [];

async function context(theme, vp, motion = "cinematic") {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  await ctx.addInitScript(([t, m]) => {
    try {
      localStorage.setItem("optislot-theme", t);
      localStorage.setItem("optislot-motion", m);
      sessionStorage.setItem("optislot-dive-seen", "1"); // no autoplay during stills
    } catch { /* ignore */ }
  }, [theme, motion]);
  return ctx;
}

function watch(page, label) {
  page.on("pageerror", (e) => problems.push(`${label}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`${label}: ${m.text()}`));
  page.on("requestfailed", (r) => problems.push(`${label}: request failed ${r.url()}`));
}

async function settle(page, ms = 450) {
  await page.evaluate(() => document.fonts.ready);
  await sleep(ms);
}

async function openExplorer(ctx, label, project = "demo") {
  const page = await ctx.newPage();
  watch(page, label);
  await page.goto(`${base}/explorer?demo=1&project=${project}`, { waitUntil: "networkidle", timeout: 180_000 });
  await page.waitForFunction(() => window.__optislot?.ready === true, null, { timeout: 180_000 });
  await settle(page);
  return page;
}

const raf2 = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

try {
  // ───── 1. routes ─────
  if (!motionOnly) {
    for (const theme of THEMES) {
      for (const vp of VIEWPORTS) {
        const ctx = await context(theme, vp);
        for (const route of routes) {
          const page = await ctx.newPage();
          watch(page, `${route} ${theme}`);
          await page.goto(`${base}${route}?project=demo`, { waitUntil: "networkidle" });
          await settle(page, route === "/explorer" ? 900 : 450);
          await page.screenshot({ path: path.join(outDir, `${slug(route)}__${vp.width}x${vp.height}__${theme}.png`) });
          count++;
          await page.close();
        }
        await ctx.close();
      }
    }
  }

  // ───── 2. motion frames (1440×900, both themes) ─────
  for (const theme of THEMES) {
    const ctx = await context(theme, VIEWPORTS[0]);
    const page = await openExplorer(ctx, `motion ${theme}`);
    for (const p of FRAMES) {
      await page.evaluate((v) => window.__optislot.dive.seek(v), p);
      await raf2(page);
      await sleep(80);
      await page.screenshot({ path: path.join(outDir, "motion", `dive__p${pct(p)}__${theme}.png`) });
      count++;
    }
    await sleep(500); // let the header plate settle after the dive ends
    for (const p of FRAMES) {
      await page.evaluate((v) => window.__optislot.glide.seek(0, 1, v), p);
      await raf2(page);
      await sleep(80);
      await page.screenshot({ path: path.join(outDir, "motion", `glide__p${pct(p)}__${theme}.png`) });
      count++;
    }
    // detail zoom + Inspector, for the review
    await page.evaluate(() => window.__optislot.glide.seek(1, 0, 1));
    await sleep(300);
    await page.keyboard.press("Escape");
    await sleep(600);
    await page.screenshot({ path: path.join(outDir, "motion", `plant__${theme}.png`) });
    count++;
    // interactions: CIOC detail zoom → Inspector, mid-flip, palette
    await page.evaluate(() => window.__optislot.glide.seek(0, 0, 1));
    await sleep(200);
    await page.locator('[data-cioc="1"]').first().click();
    await sleep(900);
    await page.screenshot({ path: path.join(outDir, "motion", `detail__${theme}.png`) });
    await page.locator('rect[data-slot][fill^="#"]').nth(4).click();
    await sleep(700);
    await page.screenshot({ path: path.join(outDir, "motion", `inspector__${theme}.png`) });
    await page.keyboard.press("Escape"); // closes the Inspector
    await page.keyboard.press("Escape"); // detail → cabinet
    await sleep(800);
    await page.keyboard.press("f");
    await sleep(170);
    await page.screenshot({ path: path.join(outDir, "motion", `flip__mid__${theme}.png`) });
    await sleep(700);
    await page.screenshot({ path: path.join(outDir, "motion", `flip__rear__${theme}.png`) });
    await page.keyboard.press("f");
    await sleep(700);
    await page.keyboard.press("Meta+k");
    await sleep(250);
    await page.keyboard.type("320-CE");
    await sleep(350);
    await page.screenshot({ path: path.join(outDir, "motion", `palette__${theme}.png`) });
    await page.keyboard.press("Escape");
    count += 6;
    if (theme === "dark") {
      const fps = [];
      for (let k = 0; k < 2; k++) {
        await page.evaluate(() => window.__optislot.glide.play(0));
        await sleep(900);
        const m = page.evaluate(() => window.__optislot.fps.measure(800));
        await page.evaluate((to) => window.__optislot.glide.play(to), 1);
        fps.push(await m);
      }
      perf.push({ project: "demo", glide: fps });
    }
    await page.close();
    await ctx.close();
  }

  // ───── 2b. Calm mode: the dive collapses into fades ─────
  {
    const ctx = await context("dark", VIEWPORTS[0], "calm");
    const page = await openExplorer(ctx, "calm");
    for (const p of [0.5, 1]) {
      await page.evaluate((v) => window.__optislot.dive.seek(v), p);
      await raf2(page);
      await page.screenshot({ path: path.join(outDir, "motion", `dive-calm__p${pct(p)}__dark.png`) });
      count++;
    }
    await page.close();
    await ctx.close();
  }

  // ───── 2c. Rev B diff: inject silently, then freeze the diff at 0/50/100 % (the gauntlet is deterministic) ─────
  const projectApi = `${base}/api/projects/demo`;
  const toRevA = () => fetch(`${projectApi}/revisions/switch?rev=A`, { method: "POST" }).catch(() => undefined);
  await toRevA();
  for (const theme of THEMES) {
    const ctx = await context(theme, VIEWPORTS[0]);
    const page = await ctx.newPage();
    watch(page, `revb ${theme}`);
    await page.goto(`${base}/revisions?demo=1&project=demo`, { waitUntil: "networkidle", timeout: 180_000 });
    await page.waitForFunction(() => !!window.__optislot?.revb, null, { timeout: 60_000 });
    await settle(page);
    await page.screenshot({ path: path.join(outDir, "motion", `revb__intro__${theme}.png`) });
    await page.evaluate(() => window.__optislot.revb.inject());
    await sleep(1400); // the camera glides to the busiest cabinet
    for (const p of [0, 0.5, 1]) {
      await page.evaluate((v) => window.__optislot.revb.seek(v), p);
      await raf2(page);
      await sleep(120);
      await page.screenshot({ path: path.join(outDir, "motion", `revb__p${pct(p)}__${theme}.png`) });
      count++;
    }
    count++;
    await page.close();
    await ctx.close();
    await toRevA(); // leave the project on Rev A for whatever runs next (or for the reused server)
  }

  // ───── 3. stress project (10k) ─────
  if (!noStress) {
    const ctx = await context("dark", VIEWPORTS[0]);
    const page = await openExplorer(ctx, "stress10k", "stress10k");
    await page.screenshot({ path: path.join(outDir, "stress", "explorer__dark.png") });
    count++;
    const fps = [];
    for (const to of [1, 2, 3]) {
      const m = page.evaluate(() => window.__optislot.fps.measure(800));
      await page.evaluate((t) => window.__optislot.glide.play(t), to);
      fps.push(await m);
      await sleep(300);
    }
    await page.keyboard.press("Escape");
    await sleep(700);
    await page.screenshot({ path: path.join(outDir, "stress", "plant__dark.png") });
    count++;
    const t0 = Date.now();
    await page.goto(`${base}/grid?project=stress10k`, { waitUntil: "networkidle" });
    await settle(page);
    const nav = Date.now() - t0;
    perf.push({ project: "stress10k", glide: fps, gridNavMs: nav });
    await page.close();
    await ctx.close();
  }
} finally {
  await browser.close();
  server?.stop();
}
console.log(`${count} screenshots → ${outDir}`);
for (const p of perf) {
  console.log(`FPS ${p.project}: ` + p.glide.map((g) => `avg ${g.avg} fps · p95 ${g.p95} ms · worst ${g.worst} ms`).join("  |  ") + (p.gridNavMs ? `  · grid nav ${p.gridNavMs} ms` : ""));
  if (p.glide.some((g) => g.avg < 50)) console.warn(`  ⚠ ${p.project}: glide below 50 fps`);
}
if (problems.length) {
  console.error(`\n${problems.length} browser problem(s):\n  ` + [...new Set(problems)].join("\n  "));
  process.exitCode = 1;
}

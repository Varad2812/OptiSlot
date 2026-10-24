// Visual QA for the launch page and the Location Rain Dive (CLAUDE.md §10.10), on the real GPU (headed Chromium).
//   SHOTS_URL=http://127.0.0.1:8766 node scripts/shots_launch.mjs     (a running `make demo`; seed stress10k for the 10k FPS pass)
//   SHOTS_PARTS=hero,fresh,rain,fps   (default: all) · SHOTS_HEADLESS=1 = SwiftShader instead of the GPU
//   → /shots/launch/hero__<w>__<theme>.png, hero-fresh__1440__dark.png, rain__<w>__<theme>__p<NNN>.png
// The rain is started for real (World3D's dive) and frozen with window.__optislot.world3d.seek(p).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.join(root, "shots", "launch");
mkdirSync(out, { recursive: true });
const base = process.env.SHOTS_URL ?? "http://127.0.0.1:8000";
const parts = new Set((process.env.SHOTS_PARTS ?? "hero,fresh,rain,fps").split(","));
const VPS = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
const THEMES = ["dark", "light"];
const FRAMES = [0, 0.25, 0.5, 0.75, 1];
const pct = (p) => String(Math.round(p * 100)).padStart(3, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const fps = [];
let n = 0;
const headless = !!process.env.SHOTS_HEADLESS;
const browser = await chromium.launch(
  headless
    ? { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }
    : { headless: false, args: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"] },
);

async function open(route, { theme = "dark", vp = VPS[0], project = "demo" } = {}) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("optislot-theme", t);
      localStorage.setItem("optislot-motion", "cinematic");
      localStorage.setItem("optislot-view", "3d");
      sessionStorage.setItem("optislot-dive-seen", "1");
      sessionStorage.setItem("optislot-scan-seen", "1");
    } catch { /* ignore */ }
  }, theme);
  const page = await ctx.newPage();
  const label = `${route} ${vp.width} ${theme}`;
  page.on("pageerror", (e) => problems.push(`${label}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(`${label}: ${m.text()}`));
  page.on("requestfailed", (r) => problems.push(`${label}: request failed ${r.url()}`));
  await page.goto(`${base}${route}${route.includes("?") ? "&" : "?"}demo=1&project=${project}`, { waitUntil: "networkidle", timeout: 180_000 });
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page };
}

const raf2 = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function shot(page, name) {
  await raf2(page);
  await sleep(60);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  n++;
}
const ready3d = (page, hook) => page.waitForFunction((h) => window.__optislot?.[h]?.stats?.()?.firstFrameMs != null || window.__optislot?.[h]?.ready?.() === true, hook, { timeout: 120_000 });

try {
  if (parts.has("hero")) {
    for (const theme of THEMES)
      for (const vp of VPS) {
        const { ctx, page } = await open("/", { theme, vp });
        await page.getByTestId("hero").waitFor();
        await ready3d(page, "miniroom").catch(() => problems.push(`hero ${vp.width} ${theme}: the background room never drew a frame`));
        await sleep(2600); // count-ups, meters and check ticks settle
        await shot(page, `hero__${vp.width}__${theme}`);
        if (theme === "dark" && vp.width === 1440) fps.push({ name: "hero (orbit)", ...(await page.evaluate(() => window.__optislot.fps.measure(2000))) });
        await ctx.close();
      }
  }

  if (parts.has("fresh")) {
    const { ctx, page } = await open("/", { project: "no-such-project" });
    await page.getByTestId("hero").waitFor();
    await sleep(3000);
    await shot(page, "hero-fresh__1440__dark");
    if (!(await page.getByTestId("hero-steps").count())) problems.push("fresh: no project → the step cards are missing");
    await ctx.close();
  }

  if (parts.has("rain")) {
    for (const theme of THEMES)
      for (const vp of VPS) {
        const { ctx, page } = await open("/room", { theme, vp });
        await ready3d(page, "world3d");
        await sleep(800);
        page.evaluate(() => window.__optislot.world3d.playDive()).catch(() => {}); // resolves when the dive ends (or the page closes)
        await page.waitForFunction(() => window.__optislot.world3d.moment() === "dive", null, { timeout: 30_000 }).catch(() => problems.push(`rain ${vp.width} ${theme}: never started`));
        for (const p of FRAMES) {
          await page.evaluate((v) => window.__optislot.world3d.seek(v), p);
          await sleep(p === 1 ? 900 : 120);
          await shot(page, `rain__${vp.width}__${theme}__p${pct(p)}`);
        }
        await ctx.close();
      }
  }

  if (parts.has("fps")) {
    for (const project of ["demo", "stress10k"]) {
      const { ctx, page } = await open("/room", { project });
      await ready3d(page, "world3d").catch(() => problems.push(`fps ${project}: no 3D`));
      await sleep(1500);
      page.evaluate(() => window.__optislot.world3d.playDive()).catch(() => {}); // resolves when the dive ends (or the page closes)
      await page.waitForFunction(() => window.__optislot.world3d.moment() === "dive", null, { timeout: 30_000 }).catch(() => problems.push(`fps ${project}: dive never started`));
      await sleep(400);
      fps.push({ name: `rain ${project}`, ...(await page.evaluate(() => window.__optislot.fps.measure(5000))), rain: await page.evaluate(() => window.__optislot.world3d.rain?.()) });
      if (project === "stress10k") await shot(page, "rain-10k__1440__dark__live");
      // the cap: particles on screen at any moment of the rain (sampled every 2 % of the dive)
      let peak = 0;
      for (let p = 0; p < 0.99; p += 0.02) peak = Math.max(peak, await page.evaluate((v) => (window.__optislot.world3d.seek(v), window.__optislot.world3d.rain()?.particles ?? 0), p));
      fps.at(-1).peak = peak;
      if (peak > 600) problems.push(`rain ${project}: ${peak} particles on screen (cap 600)`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`${n} frames → ${out}`);
for (const f of fps) console.log(`FPS ${f.name}: avg ${f.avg} · p95 ${f.p95} ms · worst ${f.worst} ms (${f.frames} frames)${f.rain ? ` · ${f.rain.flights} flights for ${f.rain.total} signals · peak ${f.peak} particles on screen` : ""}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n  ` + [...new Set(problems)].join("\n  "));
  process.exitCode = 1;
}

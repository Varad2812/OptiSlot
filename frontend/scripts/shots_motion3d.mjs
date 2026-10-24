// Visual QA for the 3D motion moments (CLAUDE.md §10.6 / §10.7): frames at 0/25/50/75/100 % of each moment, on the real GPU.
//   SHOTS_URL=http://127.0.0.1:8766 node scripts/shots_motion3d.mjs      (a running `make demo` on a scratch DB: this pass
//                                                                          applies sandbox moves and injects Rev B)
//   SHOTS_MOMENTS=scan,tamper,move,refuse,revdiff,dive   (default: all)  · SHOTS_HEADLESS=1 = SwiftShader instead of the GPU
//   → /shots/motion3d/<moment>__p<NNN>.png  (+ dive-handoff__<n>.jpg: the Import → Room transition, every ~70 ms)
// Every moment is started for real (button / API / bus), then frozen with window.__optislot.world3d.seek(p).
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.join(root, "shots", "motion3d");
mkdirSync(out, { recursive: true });
const base = process.env.SHOTS_URL ?? "http://127.0.0.1:8000";
const want = new Set((process.env.SHOTS_MOMENTS ?? "scan,tamper,move,refuse,revdiff,dive").split(","));
const FRAMES = [0, 0.25, 0.5, 0.75, 1];
const pct = (p) => String(Math.round(p * 100)).padStart(3, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const headless = !!process.env.SHOTS_HEADLESS;
const browser = await chromium.launch(
  headless
    ? { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }
    : { headless: false, args: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"] },
);
const api = (p, body, method = "POST") =>
  fetch(`${base}/api/projects/demo${p}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
let n = 0;
const fps = [];

async function open(route, { motion = "cinematic", wait3d = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((m) => {
    try {
      localStorage.setItem("optislot-theme", "dark");
      localStorage.setItem("optislot-motion", m);
      localStorage.setItem("optislot-view", "3d");
      sessionStorage.setItem("optislot-dive-seen", "1");
      sessionStorage.setItem("optislot-scan-seen", "1");
    } catch { /* ignore */ }
  }, motion);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${route}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(`${route}: ${m.text()}`));
  await page.goto(`${base}${route}${route.includes("?") ? "&" : "?"}demo=1&project=demo`, { waitUntil: "networkidle", timeout: 120_000 });
  if (wait3d) await page.waitForFunction(() => window.__optislot?.world3d?.ready?.() === true, null, { timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready);
  await sleep(1200);
  return { ctx, page };
}

const raf2 = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function shot(page, name) {
  await raf2(page);
  await sleep(60);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  n++;
}

/** Wait until the engine runs `name`, freeze it and capture the five frames; measure FPS on the live part first. */
async function frames(page, name, { live = 0 } = {}) {
  await page.waitForFunction((m) => window.__optislot.world3d.moment() === m, name, { timeout: 60_000 }).catch(() => problems.push(`${name}: never started`));
  if (live) fps.push({ name, ...(await page.evaluate((ms) => window.__optislot.fps.measure(ms), live)) });
  for (const p of FRAMES) {
    await page.evaluate((v) => window.__optislot.world3d.seek(v), p);
    await shot(page, `${name}__p${pct(p)}`);
  }
}

try {
  // ───── 1. verify scan (Proof → Re-verify) + tamper (Proof → Tamper test) ─────
  if (want.has("scan") || want.has("tamper")) {
    const { ctx, page } = await open("/proof");
    if (want.has("scan")) {
      fps.push({ name: "scan", ...(await page.evaluate(async () => {
        const m = window.__optislot.fps.measure(2000);
        void window.__optislot.verify.play();
        return m;
      })) });
      await sleep(1500);
      for (const p of FRAMES) {
        await page.evaluate((v) => window.__optislot.verify.seek(v), p);
        await shot(page, `scan__p${pct(p)}`);
      }
    }
    if (want.has("tamper")) {
      await page.getByTestId("tamper-test").click();
      // the tampered copy is verified, scanned (red where it failed), then the tamper moment flies to the slot
      await page.waitForFunction(() => window.__optislot.world3d.moment() === "scan", null, { timeout: 60_000 }).catch(() => problems.push("tamper: no scan"));
      await page.waitForFunction(() => window.__optislot.world3d.moment() !== "scan", null, { timeout: 30_000 });
      await frames(page, "tamper", { live: 600 });
      await sleep(400);
      await page.screenshot({ path: path.join(out, "tamper__panel.png") });
      n++;
      const verdict = await page.getByTestId("verdict-chip").innerText();
      if (!/FAIL/.test(verdict)) problems.push(`tamper: verdict is ${verdict}`);
    }
    await ctx.close();
  }

  // ───── 2. refused + applied move: the Workbench in one window, the 3D Room in another (motion bus, camera follows) ─────
  if (want.has("move") || want.has("refuse")) {
    await api("/placement/reset");
    const { ctx, page: room } = await open("/room");
    const wb = await ctx.newPage();
    wb.on("pageerror", (e) => problems.push(`/lab: ${e.message}`));
    await wb.goto(`${base}/lab?demo=1&project=demo&tag=${encodeURIComponent("320-XYV  -42170")}`, { waitUntil: "networkidle" });
    await sleep(900);
    // a target the rules refuse (the same pick as the Workbench shots pass)
    await wb.locator('[data-testid="pick-cabinet"]').selectOption({ index: 1 });
    await wb.locator('[data-testid="pick-ch"]').nth(2).click();
    await wb.locator('[data-testid="check-panel"][data-verdict="refused"]').waitFor({ timeout: 30_000 }).catch(() => problems.push("refuse: the Workbench check was not refused"));
    await room.bringToFront();
    const seen = (m) => room.waitForFunction((x) => window.__optislot.world3d.moment() === x, m, { timeout: 30_000, polling: 50 });
    if (want.has("refuse")) {
      await seen("refuse").then(() => frames(room, "refuse"), () => problems.push("refuse: the Room did not shake the target"));
    }
    if (want.has("move")) {
      await wb.bringToFront();
      await wb.locator('[data-testid="alt-chip"]').first().click();
      await wb.locator('[data-testid="check-panel"][data-verdict="allowed"]').waitFor({ timeout: 30_000 }).catch(() => problems.push("move: alternative not allowed"));
      await wb.locator('[data-testid="apply-move"]').click();
      await room.bringToFront();
      await seen("move").then(() => frames(room, "move", { live: 0 }), () => problems.push("move: the Room did not fly the move in"));
      await sleep(600);
      await room.screenshot({ path: path.join(out, "move__after.png") });
      n++;
    }
    await api("/placement/reset");
    await ctx.close();
  }

  // ───── 3. Rev B diff: Revision Center → Inject Rev B, then the Room's Rev switch (A → B) ─────
  if (want.has("revdiff")) {
    {
      const { ctx, page } = await open("/revisions", { wait3d: false }); // before Rev B exists the page has no stage yet
      await page.getByTestId("inject-revb").click();
      await page.waitForFunction(() => window.__optislot.world3d?.moment() === "revdiff", null, { timeout: 90_000 }).catch(() => problems.push("revdiff: Inject Rev B did not play the 3D diff"));
      fps.push({ name: "revdiff", ...(await page.evaluate(() => window.__optislot.fps.measure(1500))) });
      for (const p of FRAMES) {
        await page.evaluate((v) => window.__optislot.revb.seek(v), p);
        await shot(page, `revdiff__p${pct(p)}`);
      }
      await ctx.close();
    }
    {
      const { ctx, page } = await open("/room");
      // back to A (the diff plays reversed), then forward to B — frames of the forward one
      await page.getByTestId("rev-A").click();
      await page.waitForFunction(() => window.__optislot.world3d.moment() === "revdiff", null, { timeout: 30_000 }).catch(() => problems.push("revswitch: B → A did not play"));
      await page.waitForFunction(() => window.__optislot.world3d.moment() === null, null, { timeout: 30_000 });
      await shot(page, "revswitch__back-end");
      await page.getByTestId("rev-B").click();
      await page.waitForFunction(() => window.__optislot.world3d.moment() === "revdiff", null, { timeout: 30_000 }).catch(() => problems.push("revswitch: A → B did not play"));
      for (const p of FRAMES) {
        await page.evaluate((v) => window.__optislot.room.diffSeek(v), p);
        await shot(page, `revswitch__p${pct(p)}`);
      }
      await ctx.close();
    }
  }

  // ───── 4. Upload Dive: Import → Allocate → curtain → 3D Room dive (burst of the hand-off, then the dive frozen) ─────
  if (want.has("dive")) {
    for (const f of readdirSync(out)) if (f.startsWith("dive-handoff__")) rmSync(path.join(out, f));
    const { ctx, page } = await open("/import", { wait3d: false });
    await page.getByTestId("preview-table").waitFor({ timeout: 30_000 });
    let burst = true, k = 0;
    const sizes = [];
    const loop = (async () => {
      while (burst && k < 80) {
        const f = path.join(out, `dive-handoff__${String(k++).padStart(2, "0")}.jpg`);
        await page.screenshot({ path: f, type: "jpeg", quality: 45 }).catch(() => {});
        try { sizes.push(statSync(f).size); } catch { /* navigation in flight */ }
      }
    })();
    await page.getByTestId("allocate-btn").click();
    await page.waitForFunction(() => window.__optislot?.world3d?.moment?.() === "dive", null, { timeout: 120_000, polling: 30 }).catch(() => problems.push("dive: no 3D dive after Allocate"));
    await sleep(1600);
    burst = false;
    await loop;
    console.log(`dive hand-off: ${k} burst frames, jpeg KB ${sizes.map((x) => Math.round(x / 1024)).join(" ")}`);
    fps.push({ name: "dive", ...(await page.evaluate(() => window.__optislot.fps.measure(1500))) });
    await frames(page, "dive");
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`${n} frames → ${out}`);
for (const f of fps) console.log(`FPS ${f.name}: avg ${f.avg} · p95 ${f.p95} ms · worst ${f.worst} ms (${f.frames} frames)`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n  ` + [...new Set(problems)].join("\n  "));
  process.exitCode = 1;
}

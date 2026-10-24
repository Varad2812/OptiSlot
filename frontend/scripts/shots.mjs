// Visual-QA capture (CLAUDE.md §10.6)
//   routes:  every route × {1440×900, 1920×1080} × {dark, light}          → /shots/<route>__<vp>__<theme>.png
//   motion:  Upload Dive + cabinet glide frozen at 0/25/50/75/100 %        → /shots/motion/<seq>__p<NNN>__<theme>.png
//            Rev B diff (inject silently, then scrub) at 0/50/100 %          → /shots/motion/revb__p<NNN>__<theme>.png
//            Verify scan at 0/50/100 % + the tampered-export demo            → /shots/motion/verify__p<NNN>__<theme>.png, tamper__{mid,end}__<theme>.png
//            Mission Control strip click → zoom → Explorer arrival           → /shots/motion/mission-dive__{mid,end}__<theme>.png
//   stress:  the 10k project in the Explorer (stills + glide FPS)          → /shots/stress/*.png
//   3d:      the 3D Marshalling Room (sample + 10k): L0/L1/L2/L3 + mid-Dive, time to first frame, FPS → /shots/3d/*.png
//            headless = SwiftShader (software GL, indicative only) · SHOTS_GPU=1 adds a headed run on the real GPU (opens a window)
//   npm run shots                      builds the frontend, serves it with the real API (temp DB, seeds stress10k), captures
//   SHOTS_URL=http://127.0.0.1:8000 …  reuse an already-running `make demo` / `make dev` instead
//   SHOTS_ROUTES=/explorer,/tqs …      capture a subset of routes
//   SHOTS_WB_ONLY=1                    only the Signal Workbench pass (/lab) → /shots/wb/*.png
//   SHOTS_MOTION_ONLY=1                skip the route pass · SHOTS_NO_STRESS=1 skip the 10k pass · SHOTS_3D_ONLY=1 only the 3D pass
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(root, "shots");

// Keep in sync with SCREENS in src/shell/routes.ts.
const ROUTES = ["/", "/import", "/allocate", "/room", "/lab", "/rules", "/proof", "/revisions", "/export", "/mission", "/tqs", "/grid", "/explorer"];
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
const THEMES = ["dark", "light"];
const FRAMES = [0, 0.25, 0.5, 0.75, 1];

const routes = process.env.SHOTS_ROUTES ? process.env.SHOTS_ROUTES.split(",") : ROUTES;
const motionOnly = !!process.env.SHOTS_MOTION_ONLY;
const noStress = !!process.env.SHOTS_NO_STRESS;
const only3d = !!process.env.SHOTS_3D_ONLY;
const onlyWb = !!process.env.SHOTS_WB_ONLY;
const gpu = !!process.env.SHOTS_GPU;
const swift = process.env.SHOTS_SWIFT !== "0"; // SHOTS_SWIFT=0 with SHOTS_GPU=1: only the real-GPU 3D run
const route3d = process.env.SHOTS_3D_ROUTE || "/room";
const slug = (r) => (r === "/" ? "home" : r === "/mission" ? "mission-control" : r.slice(1).replace(/\//g, "-"));
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
mkdirSync(path.join(outDir, "3d"), { recursive: true });
const browser = await chromium.launch();
let count = 0;
const problems = [];
const perf = [];
const perf3d = [];

async function context(theme, vp, motion = "cinematic", view = "2d", b = browser) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 1 });
  await ctx.addInitScript(([t, m, v]) => {
    try {
      localStorage.setItem("optislot-theme", t);
      localStorage.setItem("optislot-motion", m);
      localStorage.setItem("optislot-view", v); // the 2D passes pin the 2.5D World; the 3D pass sets "3d"
      sessionStorage.setItem("optislot-dive-seen", "1"); // no autoplay during stills
      sessionStorage.setItem("optislot-scan-seen", "1");
    } catch { /* ignore */ }
  }, [theme, motion, view]);
  return ctx;
}

function watch(page, label) {
  page.on("pageerror", (e) => problems.push(`${label}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`${label}: ${m.text()}`));
  page.on("requestfailed", (r) => problems.push(`${label}: request failed ${r.url()}`));
  // offline venue (CLAUDE.md §0.9): nothing may leave the machine — no CDN font, script, texture or API
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol === "data:" || u.protocol === "blob:") return;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) external.add(`${label}: ${r.url()}`);
    // the generated offline fixtures are lazy chunks: with the API up, no screen should ever fetch them
    if (/\/assets\/allocation(_revb)?-[^/]+\.js$/.test(u.pathname)) fixtureLoads.add(`${label}: ${u.pathname}`);
  });
}
const external = new Set();
const fixtureLoads = new Set();

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
  if (!only3d) {
   if (!onlyWb) {
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

    // ───── 2d. Proof Center: verify-scan frames, then the tampered-export demo (the "red pulse on the exact slot" check) ─────
    {
      // The project's own export, then a copy with ONE CHARM Type changed (scripts/make_tampered.py).
      const tmp = mkdtempSync(path.join(tmpdir(), "optislot-tamper-"));
      const good = path.join(tmp, "IO_Allocation_export.xlsx");
      const bad = path.join(tmp, "IO_Allocation_tampered.xlsx");
      writeFileSync(good, Buffer.from(await (await fetch(`${projectApi}/export/allocation`)).arrayBuffer()));
      const mk = spawnSync("uv", ["run", "--project", "backend", "python", "scripts/make_tampered.py", good, bad], { cwd: root, stdio: "inherit" });
      if (mk.status !== 0) problems.push("make_tampered.py failed");
      else {
        for (const theme of THEMES) {
          const ctx = await context(theme, VIEWPORTS[0]);
          const page = await ctx.newPage();
          watch(page, `proof ${theme}`);
          await page.goto(`${base}/proof?demo=1&project=demo`, { waitUntil: "networkidle", timeout: 180_000 });
          await page.waitForFunction(() => !!window.__optislot?.verify, null, { timeout: 60_000 });
          await settle(page, 900);
          for (const p of [0, 0.5, 1]) {
            await page.evaluate((v) => window.__optislot.verify.seek(v), p);
            await raf2(page);
            await sleep(160);
            await page.screenshot({ path: path.join(outDir, "motion", `verify__p${pct(p)}__${theme}.png`) });
            count++;
          }
          // wait for the upload to start (state leaves "done"), then for the scan + camera flight to finish
          const finish = async () => {
            await page.waitForFunction(() => window.__optislot.verify.state() !== "done", null, { timeout: 4000 }).catch(() => undefined);
            await page.waitForFunction(() => window.__optislot.verify.state() === "done", null, { timeout: 30_000 });
          };
          // an untouched export passes and is byte-identical to the certified output
          await page.setInputFiles("[data-testid=verify-file-input]", good);
          await finish();
          await sleep(500);
          if (!/PASS/.test(await page.locator("[data-testid=verdict-chip]").innerText())) problems.push(`proof ${theme}: the untouched export did not PASS`);
          if (!(await page.getByText("Byte-identical to the certified output").count())) problems.push(`proof ${theme}: the untouched export is not byte-identical to the certified output`);
          // the tampered copy fails: red markers on the slot, the failing check expanded, the camera on the slot
          await page.setInputFiles("[data-testid=verify-file-input]", bad);
          await sleep(1900); // mid-scan: the beam, the checks ticking
          await page.screenshot({ path: path.join(outDir, "motion", `tamper__mid__${theme}.png`) });
          await finish();
          await sleep(1900); // the camera has flown in and the pulses have run
          await page.screenshot({ path: path.join(outDir, "motion", `tamper__end__${theme}.png`) });
          count += 2;
          const markers = await page.locator("[data-testid=fail-marker]").count();
          const failRows = await page.locator("[data-testid=check-row][data-failed]").count();
          const tier = await page.evaluate(() => document.querySelector("[data-testid=world]")?.getAttribute("data-tier"));
          if (markers < 1) problems.push(`proof ${theme}: tampered export shows no red marker on the plant`);
          if (failRows < 1) problems.push(`proof ${theme}: tampered export shows no failing check`);
          if (tier !== "detail") problems.push(`proof ${theme}: the camera did not fly in to the slot (tier ${tier})`);
          await page.close();
          await ctx.close();
        }
      }
    }

    // ───── 2e. Mission Control: click a cabinet in the strip → the strip zooms → the Explorer dives in ─────
    {
      const ctx = await context("dark", VIEWPORTS[0]);
      const page = await ctx.newPage();
      watch(page, "mission dive");
      await page.goto(`${base}/mission?project=demo`, { waitUntil: "networkidle" });
      await settle(page, 1400);
      const box = await page.locator("[data-testid=plant-strip]").boundingBox();
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await sleep(230);
      await page.screenshot({ path: path.join(outDir, "motion", "mission-dive__mid__dark.png") });
      await sleep(1700);
      await page.screenshot({ path: path.join(outDir, "motion", "mission-dive__end__dark.png") });
      count += 2;
      if (!page.url().includes("/explorer")) problems.push("mission dive: clicking a cabinet did not open the Explorer");
      await page.close();
      await ctx.close();
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
      for (const route of ["/mission", "/proof"]) {
        const t1 = Date.now();
        await page.goto(`${base}${route}?project=stress10k`, { waitUntil: "networkidle" });
        await settle(page, 1200);
        perf.at(-1)[`${slug(route)}Ms`] = Date.now() - t1;
        await page.screenshot({ path: path.join(outDir, "stress", `${slug(route)}__dark.png`) });
        count++;
      }
      await page.close();
      await ctx.close();
    }
   }
    // ───── 3b. Signal Workbench (/lab): list, selection, ?tag= preselect, check → refused → alternative → apply → commit dialog → undo; Rev B quarantined fix ─────
    mkdirSync(path.join(outDir, "wb"), { recursive: true });
    const api = (p, body, project = "demo") => fetch(`${base}/api/projects/${project}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    for (const theme of THEMES) {
      for (const vp of VIEWPORTS) {
        const tag = `${theme}__${vp.width}x${vp.height}`;
        const ctx = await context(theme, vp, "calm");
        const page = await ctx.newPage();
        watch(page, `workbench ${tag}`);
        const snap = async (n) => { await sleep(450); await page.screenshot({ path: path.join(outDir, "wb", `${n}__${tag}.png`) }); count++; };
        await api("/placement/reset");
        await page.goto(`${base}/lab?project=demo`, { waitUntil: "networkidle" });
        await settle(page, 700);
        await snap("01-list");
        await page.locator('[data-testid="signal-row"]').first().click();
        await snap("02-selected");
        // ?tag= preselect (what the 3D "Try changes" button sends)
        await page.goto(`${base}/lab?project=demo&tag=${encodeURIComponent("320-XYV  -42170")}`, { waitUntil: "networkidle" });
        await settle(page, 700);
        await snap("03-preselect");
        await page.locator('[data-testid="pick-cabinet"]').selectOption({ index: 1 });
        await page.locator('[data-testid="pick-ch"]').nth(2).click();
        await page.locator('[data-testid="check-panel"]').waitFor({ timeout: 20_000 }).catch(() => problems.push(`workbench ${tag}: no check result`));
        await snap("04-refused");
        if (vp.width === 1440) {
          await page.locator('[data-testid="alt-chip"]').first().click();
          await page.locator('[data-testid="check-panel"][data-verdict="allowed"]').waitFor({ timeout: 20_000 }).catch(() => problems.push(`workbench ${tag}: alternative not allowed`));
          await snap("05-allowed");
          await page.locator('[data-testid="apply-move"]').click();
          await sleep(1200);
          await snap("06-applied");
          await page.locator('[data-testid="commit"]').click();
          await snap("07-commit-dialog");
          await page.keyboard.press("Escape");
          await page.locator('[data-testid="undo"]').click();
          await sleep(900);
          await api("/placement/reset");
        }
        await page.close();
        await ctx.close();
      }
    }
    {
      // Rev B gauntlet → a quarantined signal: its fixes, "Fix data" preview; then back to Rev A for the passes that follow
      const ctx = await context("dark", VIEWPORTS[0], "calm");
      const page = await ctx.newPage();
      watch(page, "workbench fix");
      const g = await api("/revisions/gauntlet");
      if (!g.ok) problems.push(`workbench: gauntlet failed ${g.status}`);
      await page.goto(`${base}/lab?project=demo`, { waitUntil: "networkidle" });
      await settle(page, 700);
      await page.getByRole("button", { name: /^quarantined/ }).click();
      await sleep(900);
      await page.locator('[data-testid="signal-row"]').first().click();
      await sleep(900);
      await page.locator('[data-testid="fix-panel"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(outDir, "wb", "08-quarantined__dark.png") });
      await page.locator('[data-testid="fix-preview"]').click();
      await page.locator('[data-testid="fix-preview-result"]').waitFor({ timeout: 30_000 }).catch(() => problems.push("workbench: fix preview did not answer"));
      await page.locator('[data-testid="fix-preview-result"]').scrollIntoViewIfNeeded();
      await sleep(400);
      await page.screenshot({ path: path.join(outDir, "wb", "09-fix-preview__dark.png") });
      count += 2;
      await page.close();
      await ctx.close();
      const back = await fetch(`${base}/api/projects/demo/revisions/switch?rev=A`, { method: "POST" });
      if (!back.ok) problems.push(`workbench: switch back to Rev A failed ${back.status}`);
    }
    if (!noStress) {
      // 10k signals: the first page paints fast, scrolling pages the rest in
      const ctx = await context("dark", VIEWPORTS[0], "calm");
      const page = await ctx.newPage();
      watch(page, "workbench 10k");
      const t0 = Date.now();
      await page.goto(`${base}/lab?project=stress10k`, { waitUntil: "networkidle" });
      await page.locator('[data-testid="signal-row"]').first().waitFor({ timeout: 60_000 });
      const first = Date.now() - t0;
      await page.locator('[role="grid"]').evaluate((el) => (el.scrollTop = 32 * 4000));
      await sleep(2500);
      await page.screenshot({ path: path.join(outDir, "wb", "10-stress10k-scrolled__dark.png") });
      count++;
      console.log(`workbench 10k: first rows after ${first} ms`);
      await page.close();
      await ctx.close();
    }
  }

  // ───── 4. 3D Marshalling Room: frames + time to first frame + FPS (CLAUDE.md §10.7 targets: ≥55 fps sample, ≥30 at 10k) ─────
  const projects3d = noStress ? ["demo"] : ["demo", "stress10k"];
  const runs3d = swift && !onlyWb ? [{ mode: "swiftshader", launch: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }, frames: true }] : [];
  // headed: keep rendering while the window is covered (otherwise rAF stops and fps.measure never resolves)
  const awake = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
  if (gpu && !onlyWb) runs3d.push({ mode: "gpu", launch: { headless: false, args: awake }, frames: true });
  for (const run of runs3d) {
    const b3 = await chromium.launch(run.launch);
    try {
      for (const project of projects3d) {
        const ctx = await context("dark", VIEWPORTS[0], "cinematic", "3d", b3);
        const page = await ctx.newPage();
        watch(page, `3d ${project} ${run.mode}`);
        const t0 = Date.now();
        await page.goto(`${base}${route3d}?demo=1&project=${project}`, { waitUntil: "networkidle", timeout: 180_000 });
        await page.waitForFunction(() => window.__optislot?.world3d?.ready?.() === true, null, { timeout: 240_000 });
        const row = { project, mode: run.mode, readyMs: Date.now() - t0, ...(await page.evaluate(() => window.__optislot.world3d.stats())) };
        const tag = `${project}__${run.mode}`;
        const snap = async (name) => {
          if (!run.frames) return;
          await page.screenshot({ path: path.join(outDir, "3d", `${name}__${tag}.png`) });
          count++;
        };
        await settle(page, 1500);
        await snap("L0");
        row.idle = await page.evaluate(() => window.__optislot.fps.measure(3000)); // L0 has the idle camera drift: every frame renders
        const fly = async (level, addr, name, { mid = 0 } = {}) => {
          const m = page.evaluate(() => window.__optislot.fps.measure(1800));
          await page.evaluate(([l, a]) => void window.__optislot.world3d.goTo(l, a), [level, addr]);
          if (mid) {
            await sleep(mid);
            await snap(`${name}-mid`);
          }
          const r = await m;
          await sleep(1200);
          await snap(name);
          return r;
        };
        row.toL1 = await fly(1, { cab: 0 }, "L1", { mid: 330 });
        if (project === "demo") {
          await page.evaluate(() => window.__optislot.world3d.flip());
          await sleep(1900);
          await snap("L1-rear");
          await page.evaluate(() => window.__optislot.world3d.flip());
          await sleep(1500);
          row.toL2 = await fly(2, { cab: 0, cioc: 1 }, "L2", { mid: 300 });
          row.toL3 = await fly(3, { cab: 0, cioc: 1, bp: 2 }, "L3", { mid: 260 });
          // hover a CHARM at L3 (centre of the view): outline + hover card with Try changes
          const vp = page.viewportSize();
          const box = await page.locator('[data-testid="world3d"]').boundingBox();
          await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2 - 6);
          await sleep(140);
          await page.mouse.move(box.x + box.width / 2 - 28, box.y + box.height / 2 - 4);
          await sleep(700);
          await snap("L3-hover");
          await page.mouse.move(vp.width - 5, vp.height - 5);
          await sleep(400);
          await page.evaluate(() => window.__optislot.world3d.sibling(1));
          await sleep(1500);
          await snap("L3-next");
          row.toL4 = await fly(4, { cab: 0, cioc: 1, bp: 3, ch: 2 }, "L4");
        }
        row.toNext = await fly(1, { cab: 1 }, "L1-next");
        await page.evaluate(() => void window.__optislot.world3d.goTo(0, {}));
        await sleep(1800);
        await snap("L0-back");
        // Upload Dive (≈7.5 s): frame at ~45 %, FPS over the first 5 s
        const dm = page.evaluate(() => window.__optislot.fps.measure(5000));
        await page.evaluate(() => void window.__optislot.world3d.playDive());
        await sleep(3400);
        await snap("dive-mid");
        row.dive = await dm;
        await sleep(5500);
        await snap("dive-end");
        if (project === "demo" && route3d === "/room") {
          // Before | Now over the Workbench sandbox: apply one allowed move (temp DB), let the Room pick it up and fly it in
          const api = (p, body) => fetch(`${base}/api/projects/${project}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
          await api("/placement/reset");
          const res = await api("/placement/apply", { tag: "320-XYV  -42170", target: { slot_id: "P30-DCM-32001-04/015/5/1" }, reason: "shots: closer to the junction box" });
          console.log(`3d room: sandbox apply → applied=${res.applied}`);
          if (!res.applied) problems.push(`3d room: sandbox move refused: ${JSON.stringify(res.check?.reasons ?? res).slice(0, 200)}`);
          await page.evaluate(() => window.__optislot.room.refresh());
          await sleep(1450);
          await snap("move-mid");
          await sleep(2600);
          await snap("now");
          await page.evaluate(() => window.__optislot.room.mode("before"));
          await sleep(900);
          await snap("before");
          await page.evaluate(() => window.__optislot.room.mode("now"));
          await page.locator('[data-testid="change-item"]').first().click({ timeout: 8000 }).catch(async () =>
            problems.push(`3d room: no change in the list (moves=${await page.evaluate(() => window.__optislot.room.moves())}, apply=${JSON.stringify(res).slice(0, 160)})`));
          await sleep(2600);
          await snap("change-fly");
          await api("/placement/reset");
          // L4 "Try changes" → the Try-out Lab with that signal's cable preselected
          try {
            await page.locator('[data-testid="charm-panel"] [data-testid="try-changes"]').click({ timeout: 8000 });
            await page.waitForURL(/\/lab/, { timeout: 20_000 });
            await sleep(1800);
            await snap("try-changes-lab");
          } catch (e) {
            problems.push(`3d room: Try changes → Lab failed: ${e.message.split("\n")[0]}`);
          }
        }
        row.stats = await page.evaluate(() => window.__optislot.world3d?.stats() ?? null);
        perf3d.push(row);
        await page.close();
        await ctx.close();
      }
    } finally {
      await b3.close();
    }
  }
} finally {
  await browser.close();
  server?.stop();
}
console.log(`${count} screenshots → ${outDir}`);
for (const p of perf) {
  console.log(`FPS ${p.project}: ` + p.glide.map((g) => `avg ${g.avg} fps · p95 ${g.p95} ms · worst ${g.worst} ms`).join("  |  ") + (p.gridNavMs ? `  · grid nav ${p.gridNavMs} ms` : "") + (p["mission-controlMs"] ? `  · mission control ${p["mission-controlMs"]} ms · proof ${p.proofMs} ms (10k, incl. 1.2 s settle)` : ""));
  if (p.glide.some((g) => g.avg < 50)) console.warn(`  ⚠ ${p.project}: glide below 50 fps`);
}
for (const r of perf3d) {
  const f = (g) => (g ? `${g.avg} fps (p95 ${g.p95} ms)` : "–");
  console.log(
    `3D ${r.project} [${r.mode}]: ${r.cabinets} cab · ${r.instances} CHARMs · ${r.drawCalls} draw calls · ready ${r.readyMs} ms · first frame ${r.firstFrameMs} ms` +
      ` · idle ${f(r.idle)} · →L1 ${f(r.toL1)}${r.toL2 ? ` · →L2 ${f(r.toL2)} · →L3 ${f(r.toL3)} · →L4 ${f(r.toL4)}` : ""} · →next cab ${f(r.toNext)} · dive ${f(r.dive)}`,
  );
}
console.log(`offline: ${external.size} request(s) to a non-local host · ${fixtureLoads.size} fixture chunk load(s) with the API up`);
for (const x of external) problems.push(`external request — ${x}`);
for (const x of fixtureLoads) problems.push(`fixture loaded while online — ${x}`);
if (problems.length) {
  console.error(`\n${problems.length} browser problem(s):\n  ` + [...new Set(problems)].join("\n  "));
  process.exitCode = 1;
}

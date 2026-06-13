#!/usr/bin/env node
/**
 * REAL in-browser performance benchmark (Phase 4 Part B).
 *
 * Builds the app, serves it with `vite preview`, and drives the real pipeline in headless Chromium
 * via Playwright. Every number is measured here — nothing invented.
 *
 * IMPORTANT finding handled honestly: CDP `Emulation.setCPUThrottlingRate` throttles the renderer
 * MAIN thread but NOT dedicated Web Workers. Our pipeline runs in a Worker, so worker timings are
 * ~flat across 1x/4x/6x (we record them as evidence). The valid CPU-slowdown PROXY for low-spec is
 * therefore the IDENTICAL pipeline run on the throttled MAIN thread. Neither is a physical device.
 *
 * Outputs: benchmarks/results.json, results.csv, benchmark.svg.
 * Run: `npx playwright install chromium` once, then `npm run benchmark`.
 */
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RAW = resolve(ROOT, 'data', 'raw');
const FIXTURES = resolve(ROOT, 'tests', 'fixtures');
const OUT = resolve(ROOT, 'benchmarks');
const PORT = 4173;
const URL = `http://localhost:${PORT}/benchmarks/bench.html`;
const STAGES = ['parse', 'filter', 'epoch', 'csp+lda', 'cv'];

const REPS = Number(process.env.BENCH_REPS ?? 12);
const RATES = [1, 4, 6];
const PRIMARY = 'S001';
const RUNS = (s) => ['R04', 'R08', 'R12'].map((r) => resolve(RAW, `${s}${r}.edf`));
const ACC_TOL = 1e-6;

const subjectMean = (s) => JSON.parse(readFileSync(resolve(FIXTURES, s, 'cv_accuracy.json'), 'utf8')).mean;

function availableSubjects() {
  const v = JSON.parse(readFileSync(resolve(FIXTURES, 'subjects.json'), 'utf8')).validated;
  return v.filter((s) => RUNS(s).every((f) => existsSync(f)));
}

function stats(xs) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const std = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, std, min: Math.min(...xs), max: Math.max(...xs), n };
}

async function waitForServer(url, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server not ready at ${url}`);
}

function guardAcc(reps, expected, label) {
  for (const r of reps) {
    if (Math.abs(r.meanAcc - expected) > ACC_TOL) {
      throw new Error(`accuracy guard failed (${label}): ${r.meanAcc} vs ${expected}`);
    }
  }
}

async function measure(page, hook, reps, expected, label) {
  await page.evaluate((h) => window[h](1), hook); // warm-up (discarded)
  const { reps: r } = await page.evaluate(([h, n]) => window[h](n), [hook, reps]);
  guardAcc(r, expected, label);
  const totals = r.map((x) => x.totalMs);
  const perStage = Object.fromEntries(STAGES.map((s) => [s, stats(r.map((x) => x.stageMs[s]))]));
  return { total: stats(totals), perStage, reps };
}

async function main() {
  const subjects = availableSubjects();
  if (!RUNS(PRIMARY).every((f) => existsSync(f))) {
    throw new Error(`${PRIMARY} EDFs missing in data/raw — run \`npm run fetch-data\` first.`);
  }

  console.log('Building app (vite build)…');
  execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' });
  console.log(`Starting vite preview on :${PORT}…`);
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });

  let browser;
  try {
    await waitForServer(URL);
    browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await page.goto(URL, { waitUntil: 'load' });

    const hardware = {
      cpu: os.cpus()[0]?.model ?? 'unknown',
      logicalCores: os.cpus().length,
      totalRamGB: +(os.totalmem() / 1e9).toFixed(2),
      os: `${os.platform()} ${os.release()} (${os.arch()})`,
      browser: `Playwright Chromium ${browser.version()}`,
      userAgent: await page.evaluate(() => navigator.userAgent),
      measuredAt: new Date().toISOString(),
    };
    console.log('Hardware:', hardware);

    const setFiles = (s) => page.setInputFiles('#edf', RUNS(s));
    const expected = subjectMean(PRIMARY);

    // --- Memory pass (unthrottled, main-thread run so the heap counter sees the pipeline) ---
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await setFiles(PRIMARY);
    const memory = await page.evaluate(() => window.__benchMemory());
    console.log('Memory:', memory);

    // --- Timing at each throttle rate: WORKER (evidence) + MAIN-THREAD (valid proxy) ---
    const conditionsWorker = [];
    const conditionsMain = [];
    for (const rate of RATES) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      await setFiles(PRIMARY);
      const w = await measure(page, '__benchTiming', REPS, expected, `worker@${rate}x`);
      const m = await measure(page, '__benchTimingMain', REPS, expected, `main@${rate}x`);
      conditionsWorker.push({ rate, ...w });
      conditionsMain.push({ rate, ...m });
      console.log(`  ${rate}x: worker ${w.total.mean.toFixed(0)}±${w.total.std.toFixed(0)} ms | main ${m.total.mean.toFixed(0)}±${m.total.std.toFixed(0)} ms`);
    }

    // --- Cross-subject spread (unthrottled worker, 1 rep each) ---
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const crossSubject = [];
    for (const s of subjects) {
      await setFiles(s);
      const { reps } = await page.evaluate(() => window.__benchTiming(1));
      guardAcc(reps, subjectMean(s), s);
      crossSubject.push({ subject: s, totalMs: reps[0].totalMs, meanAcc: reps[0].meanAcc });
    }

    const results = {
      hardware,
      method: {
        repsPerCondition: REPS,
        warmupDiscarded: 1,
        throttleRates: RATES,
        primarySubject: PRIMARY,
        workerTiming: 'real app Web Worker (src/workers/pipeline.worker.ts); per-stage from worker progress-event timestamps; total via performance.now',
        mainThreadTiming: 'identical runFromBuffers on the page main thread (CDP throttling reaches the main thread → valid CPU-slowdown proxy)',
        memory: 'identical runFromBuffers on the main thread so performance.memory.usedJSHeapSize (with --enable-precise-memory-info) captures pipeline allocations',
        accuracyGuard: `every rep meanAcc within ${ACC_TOL} of the oracle mean`,
      },
      caveats: {
        throttlingReachesWorker:
          'CDP Emulation.setCPUThrottlingRate throttles the renderer MAIN thread but NOT dedicated Web Workers. conditionsWorker is therefore ~flat across 1x/4x/6x (evidence). The low-spec CPU PROXY is conditionsMain (identical compute on the throttled main thread).',
        physicalDevice: 'Throttled numbers are a CPU-slowdown PROXY, NOT a physical low-spec device. Run `npm run benchmark` on a real device for that.',
        memory: 'performance.memory.usedJSHeapSize is Chromium-only, coarse/whole-heap (app + GC slack), not exact pipeline working set. measureUserAgentSpecificMemory skipped (no cross-origin isolation).',
        stageBoundaries: 'Per-stage durations derive from progress-event timestamps (chunk granularity); "parse" = EDF parse + concat + event extraction.',
      },
      headline: {
        realAppWorkerUnthrottledMs: conditionsWorker.find((c) => c.rate === 1).total,
        peakHeapMB: memory.available ? memory.peakMB : null,
      },
      memory,
      conditionsWorker,
      conditionsMain,
      crossSubject,
    };

    writeFileSync(resolve(OUT, 'results.json'), JSON.stringify(results, null, 2));
    writeCsv(results);
    writeSvg(results);
    printSummary(results);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

function writeCsv(results) {
  const rows = [['thread', 'rate', 'metric', 'mean_ms', 'std_ms', 'min_ms', 'max_ms', 'n']];
  const add = (thread, conds) => {
    for (const c of conds) {
      rows.push([thread, c.rate, 'total', c.total.mean, c.total.std, c.total.min, c.total.max, c.total.n]);
      for (const s of STAGES) {
        const st = c.perStage[s];
        rows.push([thread, c.rate, s, st.mean, st.std, st.min, st.max, st.n]);
      }
    }
  };
  add('worker', results.conditionsWorker);
  add('main', results.conditionsMain);
  writeFileSync(resolve(OUT, 'results.csv'), rows.map((r) => r.join(',')).join('\n') + '\n');
}

function writeSvg(results) {
  const conds = results.conditionsMain; // the valid CPU-slowdown proxy
  const W = 760;
  const H = 440;
  const pad = { l: 64, r: 20, t: 64, b: 64 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const maxTotal = Math.max(...conds.map((c) => c.total.max));
  const colors = ['#9ca3af', '#2563eb', '#16a34a', '#f59e0b', '#dc2626'];
  const yOf = (ms) => pad.t + plotH - (ms / maxTotal) * plotH;
  const bw = (plotW / conds.length) * 0.5;

  let bars = '';
  conds.forEach((c, i) => {
    const cx = pad.l + (i + 0.5) * (plotW / conds.length);
    let yTop = pad.t + plotH;
    STAGES.forEach((s, si) => {
      const h = (c.perStage[s].mean / maxTotal) * plotH;
      yTop -= h;
      bars += `<rect x="${cx - bw / 2}" y="${yTop}" width="${bw}" height="${h}" fill="${colors[si]}"/>`;
    });
    const yT = yOf(c.total.mean);
    const sH = (c.total.std / maxTotal) * plotH;
    bars += `<line x1="${cx}" y1="${yT - sH}" x2="${cx}" y2="${yT + sH}" stroke="#111" stroke-width="1.5"/>`;
    bars += `<text x="${cx}" y="${yT - sH - 6}" text-anchor="middle" font-size="12" font-weight="bold">${c.total.mean.toFixed(0)}±${c.total.std.toFixed(0)} ms</text>`;
    bars += `<text x="${cx}" y="${H - pad.b + 18}" text-anchor="middle" font-size="12">${c.rate}x CPU</text>`;
  });

  const legend = STAGES.map((s, i) => `<rect x="${pad.l + i * 140}" y="${H - 18}" width="12" height="12" fill="${colors[i]}"/><text x="${pad.l + i * 140 + 16}" y="${H - 8}" font-size="11">${s}</text>`).join('');
  const w1 = results.headline.realAppWorkerUnthrottledMs;
  const mem = results.memory.available ? `peak heap ${results.memory.peakMB.toFixed(1)} MB` : 'heap n/a';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui">
<text x="${W / 2}" y="22" text-anchor="middle" font-size="15" font-weight="bold">Pipeline runtime — CPU-throttle PROXY (main thread), ${results.hardware.cpu}</text>
<text x="${W / 2}" y="40" text-anchor="middle" font-size="11" fill="#555">n=${results.method.repsPerCondition}/cond · stacked = per-stage mean · whisker = ±std · real app (worker) @1x = ${w1.mean.toFixed(0)} ms · ${mem}</text>
<text x="${W / 2}" y="55" text-anchor="middle" font-size="10" fill="#b45309">4x/6x = CPU-slowdown proxy, NOT a physical device (CDP throttling does not reach Web Workers)</text>
<line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + plotH}" stroke="#999"/>
<line x1="${pad.l}" y1="${pad.t + plotH}" x2="${W - pad.r}" y2="${pad.t + plotH}" stroke="#999"/>
${bars}${legend}
</svg>`;
  writeFileSync(resolve(OUT, 'benchmark.svg'), svg);
}

function printSummary(results) {
  const line = (c) => `${c.rate}x: total ${c.total.mean.toFixed(0)}±${c.total.std.toFixed(0)} ms (min ${c.total.min.toFixed(0)}, max ${c.total.max.toFixed(0)}) | ` + STAGES.map((s) => `${s}=${c.perStage[s].mean.toFixed(0)}`).join(' ');
  console.log('\n===== BENCHMARK SUMMARY (real measurements) =====');
  console.log(`HW: ${results.hardware.cpu} · ${results.hardware.logicalCores} cores · ${results.hardware.totalRamGB} GB · ${results.hardware.os}`);
  console.log(`Browser: ${results.hardware.browser} · n=${results.method.repsPerCondition}/condition`);
  console.log('\nREAL APP (Web Worker) — CDP throttle does NOT reach workers (≈flat, evidence):');
  for (const c of results.conditionsWorker) console.log('  ' + line(c));
  console.log('\nCPU-SLOWDOWN PROXY (identical compute, throttled MAIN thread):');
  for (const c of results.conditionsMain) console.log('  ' + line(c));
  if (results.memory.available) {
    console.log(`\nMemory: peak heap ${results.memory.peakMB.toFixed(1)} MB (baseline ${results.memory.baseMB.toFixed(1)}, Δ ${results.memory.deltaMB.toFixed(1)}, limit ${results.memory.heapLimitMB.toFixed(0)} MB) — coarse whole-heap.`);
  } else {
    console.log('\nMemory: performance.memory unavailable in this browser build.');
  }
  console.log(`\nCross-subject totals (worker, 1x): ${results.crossSubject.map((c) => `${c.subject}=${c.totalMs.toFixed(0)}ms`).join(' ')}`);
  console.log('\nNOTE: 4x/6x are CPU-throttled PROXIES, not a physical low-spec device.');
  console.log('Files: benchmarks/results.json, results.csv, benchmark.svg');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

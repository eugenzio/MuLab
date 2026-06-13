# Performance benchmark (Phase 4 Part B)

Real, in-browser measurements of the client-side pipeline (filter → epoch → CSP → LDA → 5-fold CV)
running in the actual Web Worker. **Every number is measured by the harness — nothing is invented.**
Authoritative machine-readable values are in [`results.json`](./results.json) (+ [`results.csv`](./results.csv),
[`benchmark.svg`](./benchmark.svg)); the numbers quoted below are from the recorded reference run.

## Reproduce
```bash
npm run fetch-data            # EDFs into data/raw (if not already)
npx playwright install chromium   # once
npm run benchmark             # builds, serves (vite preview), drives headless Chromium
```
Override repetitions with `BENCH_REPS` (default 12). **To get a real low-spec number, run
`npm run benchmark` on the actual device** — the throttled figures here are a proxy (see caveats).

## What is measured
- **Real app (Web Worker):** the page drives `src/workers/pipeline.worker.ts` exactly like the UI.
  Per-stage durations come from the worker's progress-event timestamps; total from `performance.now()`.
- **CPU-slowdown proxy (main thread):** the *identical* `runFromBuffers` run on the page main thread.
- **Memory:** the identical pipeline on the main thread, sampling `performance.memory.usedJSHeapSize`
  (launched with `--enable-precise-memory-info`).
- **Correctness guard:** every timed rep must reproduce the oracle accuracy (S001 meanAcc = 0.8667)
  to within 1e-6, so timing never measures a broken run. 12 reps/condition, 1 warm-up discarded.

## Recorded reference run
- **Hardware:** Apple M4 · 10 logical cores · 17.18 GB RAM · darwin 24.6.0 (arm64).
- **Browser:** Playwright Chromium 148.0.7778.96 (headless). Subject S001 (45 epochs).

| Condition | Total (mean ± std) | parse | filter | epoch | csp+lda | cv |
| --- | --- | --- | --- | --- | --- | --- |
| **Real app (worker), 1×** | **1696 ± 20 ms** | 199 | 1185 | 61 | 49 | 202 |
| Worker, 4× | 1756 ± 28 ms | 210 | 1227 | 62 | 50 | 208 |
| Worker, 6× | 1748 ± 25 ms | 206 | 1227 | 63 | 50 | 202 |
| Proxy (main), 1× | 1013 ± 9 ms | 109 | 599 | 58 | 49 | 200 |
| **Proxy (main), 4×** | **3954 ± 16 ms** | 438 | 2371 | 223 | 183 | 739 |
| **Proxy (main), 6×** | **5992 ± 63 ms** | 668 | 3575 | 341 | 281 | 1127 |

- **Peak JS heap:** 192.2 MB (baseline 9.0, Δ 183.1; heap limit 4096 MB) — coarse whole-heap.
- **Cross-subject (worker, 1×):** S001–S010 totals 1723–1763 ms (all reproduce their oracle accuracy).

## Caveats (read before citing)
1. **Throttling does not reach Web Workers.** CDP `Emulation.setCPUThrottlingRate` throttles the
   renderer main thread only, so the **worker** timings are ≈flat across 1×/4×/6× (recorded as
   evidence). The CPU-slowdown evidence is the **main-thread proxy**, which scales as expected
   (1× → 4× → 6× ≈ 1013 → 3954 → 5992 ms, i.e. ~1.0/3.9/5.9×).
2. **Proxy ≠ physical device.** The 4×/6× figures are a Chromium CPU-slowdown **proxy**, NOT a
   measurement on a real Chromebook-class machine. A physical low-spec run is left for the author
   (same command).
3. **Memory is coarse.** `performance.memory.usedJSHeapSize` is Chromium-only and whole-heap
   (app + GC slack), not the exact pipeline working set. `measureUserAgentSpecificMemory()` is
   skipped (no cross-origin isolation set up). The ~192 MB peak fits a 4 GB Chromebook budget, but
   treat "fits low-spec RAM" as a documented assumption pending a real-device run.
4. **Stage boundaries** are derived from progress-event timestamps (chunk granularity); the `parse`
   bucket includes EDF parse + concatenation + event extraction.

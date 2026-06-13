# EEG/BCI Web Tool

Fully **client-side** (no backend, no install) browser tool for analyzing public
EEG motor-imagery datasets, intended to be validated against MNE-Python and
released as an open-source artifact.

> **Status: Phase 1 — data-parsing feasibility spike.** Only data loading/parsing
> is built. Signal processing, CSP, LDA, benchmarking, and UI come in later phases.
> Claims below about dataset licenses and library capabilities are **not settled** —
> see [`ASSUMPTIONS.md`](./ASSUMPTIONS.md).

## What works (Phase 1 verdict)

| Format | Source | In-browser parse? | Notes |
| --- | --- | --- | --- |
| **EDF / EDF+C** | PhysioNet EEGMMIDB | ✅ Yes | 64 ch @ 160 Hz + TAL annotations (T0/T1/T2) decoded. Pure JS via `edfdecoder` + our own TAL decoder. |
| **GDF 2.0** | BCI Competition IV 2a | ⚠️ Not directly | No reliable pure-JS GDF decoder found. Header is sniffable; full decode routes to a **Python pre-convert adapter** (planned). |

### Loading strategy
- **EDF/EDF+** loads directly in the browser, annotations included.
- **GDF** uses a **data-adapter fallback**: pre-convert in Python
  (`mne.io.read_raw_gdf` → cleaned `.npz`/JSON), and the tool loads that. The raw
  GDF format cannot be read directly in-browser in Phase 1. (Adapter script lands
  in Phase 2.)

## Quick start

```bash
npm install
npm run fetch-data   # downloads EEGMMIDB S001 EDFs into data/raw/ (gitignored)
npm test             # parser unit tests (EDF runs against the real file)
npm run dev          # open the page, pick data/raw/S001R04.edf to parse in a worker
```

`npm run fetch-data` also attempts open mirrors for BCI IV-2a; if they fail it
records a blocker in `data/raw/manifest.json` and you must supply the `.gdf`
yourself.

## Architecture (Phase 1)

```
src/
  parsers/
    types.ts   EegRecording — the format-agnostic contract all parsers produce
    edf.ts     EDF/EDF+ parser (edfdecoder) + EDF+ TAL annotation decoder
    gdf.ts     GDF header sniffer + honest "adapter required" verdict
  workers/
    parse.worker.ts   parses off the main thread (heavy compute added in Phase 3)
  main.ts      minimal demo UI: file -> worker -> parsed shape
scripts/
  fetch-data.mjs   downloads samples, writes a reproducible sha256 manifest
tests/         vitest unit tests (EDF against real data, GDF verdict locked in)
```

All signal data uses `Float64Array`. Heavy operations are destined for the Web
Worker so the main thread never blocks (the parse path already runs there).

## Phase 2 — Validation oracle + comparison harness

Builds the **MNE/scikit-learn reference oracle** (ground truth for the future TS
pipeline) on EEGMMIDB only, plus the **TS comparison machinery**. No TS
signal-processing pipeline yet — that is Phase 3.

**Oracle pipeline** (subject S001, left-vs-right fist motor imagery, runs R04+R08+R12;
T1=left, T2=right — *needs verification*):
load EDF → explicit FIR bandpass 8–30 Hz (zero-phase `filtfilt`) → manual epoching
(tmin 0.5 s, tmax 2.5 s) → **explicit CSP** (shrinkage cov, generalized eigh) → LDA
(`lsqr`, shrinkage 0.1) → 5-fold stratified CV. Mean CV accuracy ≈ **0.87**.

CSP is computed explicitly (not via `mne.decoding.CSP`) so Phase 3 can replicate the
exact algorithm; it is **cross-checked against `mne.decoding.CSP` (|cosine| = 1.0)** to
prove it equals the MNE reference. `tests/fixtures/params.json` is the single source of
truth Phase 3 consumes (filter taps, epoch window, CSP/LDA params, fold indices).

```
scripts/oracle/
  requirements.txt   pinned mne/scikit-learn/numpy/scipy (Python 3.12 venv)
  make_fixtures.py   the reference oracle
  run.sh             regenerate fixtures: `bash scripts/oracle/run.sh`
src/validation/
  tolerances.ts      PEARSON_R_MIN, TTEST_P_MIN, CSP_FROBENIUS_MAX (one place)
  metrics.ts         pearsonR, frobeniusNormDiff (+CSP sign/order alignment), pairedTTest
  fixtures.ts        typed loader + cross-fixture shape validation
tests/fixtures/      committed oracle outputs (regenerable)
tests/validation/    metric + fixture-shape unit tests
```

Regenerate the venv + fixtures:
```bash
python3.12 -m venv scripts/oracle/.venv
scripts/oracle/.venv/bin/pip install -r scripts/oracle/requirements.txt
bash scripts/oracle/run.sh
```

## Phase 3 — TS client-side pipeline (validated stage-by-stage)

The full analysis pipeline implemented in TypeScript, reading every parameter from
`params.json` and reproducing the MNE oracle. All stages match to ~machine precision:

| Stage | Module | Agreement vs oracle |
| --- | --- | --- |
| Filter (zero-phase FIR, scipy-exact filtfilt) | `src/pipeline/filter.ts` | pearson r = 0.99999999999, max abs 1.1e-13 µV |
| Epoching | `src/pipeline/epoch.ts` | 45 epochs (23/22); parser events == dumped |
| CSP (shrinkage cov, Cholesky-reduced generalized `eigh` via ml-matrix) | `src/pipeline/csp.ts` | aligned Frobenius 8.2e-15 |
| LDA (sklearn lsqr + shrinkage) | `src/pipeline/lda.ts` | max weight/bias diff 2.3e-13 |
| 5-fold CV (dumped folds) | `src/pipeline/cv.ts` | per-fold `[1,1,1,.667,.667]`, mean 0.867 (exact) |

`src/pipeline/runPipeline.ts` orchestrates the stages with async chunking;
`src/workers/pipeline.worker.ts` runs it off the main thread (wired to UI in Phase 4).
Linear algebra: **ml-matrix**; the generalized eigenproblem `eigh(cov_left, cov_left+cov_right)`
is reduced via Cholesky `C=LLᵀ` → symmetric EVD of `L⁻¹·cov_left·L⁻ᵀ` → `w = L⁻ᵀ·V`.

```
src/pipeline/   filter, epoch, csp, lda, cv, runPipeline (pure, Node-testable)
src/workers/    pipeline.worker.ts  (thin wrapper)
tests/pipeline/ one test per stage + e2e, all against the real EEG + fixtures
```

## Phase 4 Part A — Multi-subject validation

The browser pipeline equals the MNE oracle **per subject** across EEGMMIDB S001–S010 (same
pipeline, no per-subject tuning). The claim is *numerical correctness* (browser == oracle),
**not** BCI accuracy — the wide accuracy spread (0.33–0.93, some below chance) is normal subject
variability and is **not** "fixed".

| Subject | n_epochs | filter r | CSP Frobenius | LDA diff | CV mean | browser==oracle |
| --- | --- | --- | --- | --- | --- | --- |
| S001 | 45 | 1.0000000000 | 8.2e-15 | 2.3e-13 | 0.867 | ✅ |
| S002 | 45 | 1.0000000000 | 6.6e-15 | 2.4e-12 | 0.867 | ✅ |
| S003 | 45 | 1.0000000000 | 7.7e-15 | 3.2e-13 | 0.600 | ✅ |
| S004 | 45 | 1.0000000000 | 1.7e-14 | 1.5e-12 | 0.689 | ✅ |
| S005 | 45 | 1.0000000000 | 8.5e-15 | 4.1e-13 | 0.578 | ✅ |
| S006 | 45 | 1.0000000000 | 1.1e-14 | 1.7e-13 | 0.333 | ✅ |
| S007 | 45 | 1.0000000000 | 7.9e-15 | 1.7e-13 | 0.933 | ✅ |
| S008 | 45 | 1.0000000000 | 1.4e-14 | 3.3e-13 | 0.667 | ✅ |
| S009 | 45 | 1.0000000000 | 1.2e-14 | 4.6e-13 | 0.356 | ✅ |
| S010 | 45 | 1.0000000000 | 9.5e-15 | 1.8e-13 | 0.578 | ✅ |

**10/10 subjects validated, 0 skipped.** MNE cross-check `|cosine| = 1.0` for every subject.

Per-subject fixtures live under `tests/fixtures/<subject>/`; `tests/fixtures/subjects.json` lists
validated/skipped subjects (the oracle skips, never crashes, on `sfreq != 160`, channels `!= 64`,
or missing/insufficient T1/T2 events). `tests/pipeline/multisubject.test.ts` parametrizes over them.

Regenerate / extend:
```bash
EEGMMIDB_SUBJECTS="S001,S002,...,S010" npm run fetch-data   # default S001..S010
bash scripts/oracle/run.sh                                   # writes per-subject fixtures
npm test
```

## Phase 4 Part C — Minimal no-install UI

A no-backend web page drives the **existing** Web Worker end-to-end in the browser:

```bash
npm run fetch-data        # subjects' EDFs into data/raw/ (if not already)
npm run prep-sample       # optional: copy S001 runs into public/sample/ for one-click demo
npm run dev               # open the printed URL
```

In the page: pick a subject's three imagery EDFs (`SxxxR04/R08/R12.edf`) from `data/raw/` (or click
**Run bundled S001 sample** if prepped) → **Run analysis**. The worker parses the EDFs, runs
filter → epoch → CSP → LDA → 5-fold CV off the main thread, streams progress, and the page shows
**per-fold + mean CV accuracy, runtime, and the CSP spatial filters** as signed bar strips. For a
known subject the bundled MNE-seeded folds are used, so the displayed accuracy matches the oracle
(e.g. S001 → 86.7%); unknown subjects use a local CV split (labelled as such).

- **Data path:** file-picker (heavy EDFs stay user-provided, nothing large committed); the small
  per-subject `params`/`fold_indices` are bundled via `import.meta.glob`. `public/sample/` is
  gitignored and populated by `npm run prep-sample`.
- **Worker bundling:** `npm run build` now emits the `pipeline.worker` chunk (~95 kB).
- **Heavy compute** (EDF parse + filter + CSP + LDA + CV) runs entirely in the Worker.

```
index.html, src/main.ts         the page (subject select, file-picker, progress, results, CSP)
src/pipeline/runFromBuffers.ts   browser entry: parse → concat → events → runPipeline
src/pipeline/recording.ts        concatRecordings + concatEvents (shared with tests)
src/pipeline/stratifiedKFold.ts  local fold fallback (unknown subjects only)
src/workers/pipeline.worker.ts   'run' message: buffers + config + folds → result
tests/pipeline/runFromBuffers.test.ts, worker-contract.test.ts
```

Manual end-to-end check: `npm run dev` → pick `S001R04/R08/R12.edf` → Run → ~86.7% mean accuracy.

## Phase 4 Part B — Performance benchmark (real, in-browser)

`npm run benchmark` (Playwright + headless Chromium) drives the **real** pipeline Worker and records
runtime + memory — every number measured, none invented. See [`benchmarks/`](./benchmarks/)
(`results.json`, `results.csv`, `benchmark.svg`, `README.md`).

Reference run (Apple M4, 10 cores, 17.2 GB, Chromium 148, S001, n=12): real app **≈1.7 s** in the
Worker; peak JS heap **≈192 MB**. Honest caveat surfaced by the harness: CDP CPU throttling does
**not** reach Web Workers, so the low-spec CPU proxy is the identical compute on the throttled main
thread (1×/4×/6× ≈ 1.0/4.0/6.0 s). Throttled = proxy, **not** a physical device; a real low-spec run
is the same command on that device.

```bash
npx playwright install chromium   # once
npm run benchmark                 # -> benchmarks/results.json,.csv, benchmark.svg
```

## Status
Phases 1–3 + Phase 4 (Parts A, B, C) complete. The pipeline is validated browser==MNE across
S001–S010, runs in a Web Worker behind a no-install UI, and is benchmarked on real hardware.

## License
MIT (see [`ASSUMPTIONS.md`](./ASSUMPTIONS.md) for dataset-license caveats — those
are separate from this code's license).

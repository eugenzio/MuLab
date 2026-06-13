# Assumptions & "needs verification" log

Per the project engineering rules, no factual claim (dataset license, library
capability) is stated as settled. Everything uncertain is logged here.

## Datasets

- **PhysioNet EEGMMIDB license** — commonly cited as ODC-BY (Open Data Commons
  Attribution). **NEEDS VERIFICATION** against the dataset's own page before any
  redistribution claim in a publication. We download but do **not** commit the
  raw files (`data/raw/` is gitignored).
- **EEGMMIDB run semantics** — assumed: runs R03/R05/… = executed movement,
  R04/R06/… = motor imagery; T0 = rest, T1/T2 = the two imagery conditions
  (per run, the limb pairing differs). **NEEDS VERIFICATION** against the
  dataset documentation before using labels for classification (Phase 2+).
- **BCI Competition IV 2a access** — the standard `.gdf` files are
  registration-gated. The two open mirrors attempted in `scripts/fetch-data.mjs`
  returned HTTP 404 (recorded in `data/raw/manifest.json` → `blockers`). The user
  must obtain `A01T.gdf` (etc.) and place it in `data/raw/`. The canonical source
  and exact licensing are **NEEDS VERIFICATION**.

## Library capabilities

- **edfdecoder** (v0.1.2, pure JS) — verified in this spike to decode the EDF/EDF+
  header and physical signals for EEGMMIDB. It does **not** decode the EDF+
  annotation (TAL) track; it exposes that channel only as raw int16. We decode the
  TAL ourselves in `src/parsers/edf.ts`. Generality of this TAL decoder beyond
  EEGMMIDB (e.g. fractional record durations, multiple annotation signals) is
  **NEEDS VERIFICATION**.
- **Float64 conversion** — edfdecoder returns Float32 physical signals; we convert
  to Float64Array per the project's TypedArray precision rule. The extra copy is
  intentional and acceptable for the data sizes here.
- **GDF 2.0 in-browser** — as of this spike, no production-grade pure-JS GDF 2.0
  parser was found that reliably decodes signals + the binary event table with
  correct scaling. **NEEDS VERIFICATION** (the npm/JS ecosystem may have changed).
  The GDF fixed-header offsets used by `sniffGdfHeader` follow the GDF 2.x spec but
  have **not** been checked against MNE on a real file.

## Environment

- **Node v22.19.0 / npm 10.9.3** — used for scaffold, fetch, tests.
- **Python 3.14.2 + numpy 2.4.6** present, but **mne and scikit-learn are NOT
  installed**. Python 3.14 is very new → mne/sklearn wheel availability is
  **NEEDS VERIFICATION** for Phase 2; may require pinning a 3.11/3.12 venv.
  → **Resolved in Phase 2:** built a pinned venv on **Python 3.12.12** (3.11 absent).

## Phase 2 — oracle decisions & caveats

- **EEGMMIDB run/event semantics** — assumed Task 2 (imagine left/right fist) = runs
  R04/R08/R12, with **T1 = left fist, T2 = right fist, T0 = rest**. **NEEDS
  VERIFICATION** against PhysioNet docs; not asserted. Drives the left-vs-right labels.
- **Resolved oracle library versions:** mne 1.8.0, scikit-learn 1.5.2, numpy 2.0.2,
  scipy 1.14.1 on Python 3.12.12 (recorded in `tests/fixtures/params.json["env"]`).
- **Signal units:** the oracle keeps signals in **µV** (MNE returns Volts → ×1e6) to
  match the Phase 1 JS parser's native µV. Phase 3 must filter in µV for the CSP/Frobenius
  comparison to be unit-consistent (Pearson r is scale-invariant regardless).
- **CSP computed explicitly, not via `mne.decoding.CSP`.** On 64 ch / ~36 training
  trials, MNE's CSP enters an internal rank-reduction/whitening path (`_smart_eigh` →
  `pinv` divide-by-zero) that a from-scratch Phase 3 CSP cannot replicate. The explicit
  algorithm (shrinkage covariance + generalized `eigh`) is documented in `params.json`
  and **cross-checked against `mne.decoding.CSP` (|cosine| = 1.0)** — i.e. it provably
  equals the MNE reference while staying replicable.
- **CSP fixed shrinkage `reg=0.1`** (not `None`/empirical): the empirical 64×64 covariance
  from limited trials is ill-conditioned. Float shrinkage `(1-reg)*emp + reg*(tr/n)*I`
  (assume_centered) is well-conditioned and exactly replicable.
- **LDA fixed `shrinkage=0.1`** (not `'auto'`): so Phase 3 can replicate training exactly
  rather than re-deriving a data-dependent Ledoit-Wolf shrinkage.
- **NumPy 2.0 + Apple Accelerate BLAS spurious warnings:** plain finite `matmul` emits
  "divide by zero / overflow / invalid value encountered in matmul" while returning finite
  results (verified in isolation). Silenced via `np.seterr`; correctness is guarded by
  `assert_finite()` on every dumped array and by the MNE cross-check. Not a real numerical
  issue, but **environment-specific** — results are deterministic across reruns.
- **CSP comparison alignment rule** (`src/validation/metrics.ts::alignCsp`): components
  carry arbitrary sign and ordering. We greedily match impl→oracle rows by max |cosine|,
  then sign-flip; magnitude is **not** rescaled (a real scale difference must surface in
  the Frobenius norm). `CSP_FROBENIUS_MAX` calibrated in Phase 3 (1e-12).

## Phase 4 Part A — multi-subject validation

- **Subjects:** S001–S010 (override via `EEGMMIDB_SUBJECTS`). The claim is *numerical*
  (browser == MNE oracle per subject), **not** accuracy — the 0.33–0.93 spread (some below
  chance) is expected BCI-illiteracy variability and the pipeline was **not** tuned to it.
- **Skipped-subject criteria** (oracle skips, does not crash): sampling rate `!= 160 Hz`,
  EEG channel count `!= 64`, missing T1/T2 annotations, or `< n_splits` epochs in either class.
  For S001–S010 none were skipped; the documented bad EEGMMIDB subjects (S088/89/92/100) lie
  outside this range. Per-subject status is recorded in `tests/fixtures/subjects.json`.
- **EEGMMIDB run semantics** (R04/R08/R12 = imagine left/right fist; T1=left, T2=right) remain
  **NEEDS VERIFICATION** for all subjects — not asserted.
- **`filtered_subset` is a 16-channel subset** (sensorimotor FC/C/CP strip, indices 0–15) to
  keep per-subject fixtures small (~2 MB total). filtfilt is per-channel independent and CSP
  consumes all 64 filtered channels (Frobenius ~1e-14 per subject), so the subset fully
  validates the filter while the CSP check covers all channels.

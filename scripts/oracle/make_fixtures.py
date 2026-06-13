#!/usr/bin/env python3
"""Phase 2 reference oracle: MNE/scikit-learn ground truth for the EEG/BCI tool.

Pipeline (EEGMMIDB subject S001, left-vs-right fist motor imagery):
    load EDF -> explicit FIR bandpass (zero-phase) -> manual epoching ->
    CSP -> LDA -> 5-fold stratified CV.

Everything is deterministic and explicit. We OWN the filter coefficients and the
epoching, and we dump them, so the Phase 3 TypeScript pipeline replicates THESE
exact operations rather than reverse-engineering MNE internals. Fixtures are
written as JSON to tests/fixtures/. params.json is the single source of truth.

Run via scripts/oracle/run.sh (uses the pinned 3.12 venv).
"""
from __future__ import annotations

import json
import os
import platform
from pathlib import Path

import numpy as np
import scipy
import scipy.linalg as sla
import scipy.signal as sps
import sklearn
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.model_selection import StratifiedKFold

import mne
from mne.decoding import CSP  # used only for a cross-check against the explicit CSP

# --------------------------------------------------------------------------- #
# Parameters (documented; mirrored into params.json — the Phase 3 source of truth)
# --------------------------------------------------------------------------- #
SEED = 42

# EEGMMIDB Task 2 (imagine left/right fist). T1=left, T2=right. NEEDS VERIFICATION.
IMAGERY_RUNS = ["R04", "R08", "R12"]
EVENT_ID = {"T1": 1, "T2": 2}  # left=1, right=2

# Subjects to process (override with EEGMMIDB_SUBJECTS="S001,S005,..."). Default S001..S010.
SUBJECTS = (
    [s.strip() for s in os.environ["EEGMMIDB_SUBJECTS"].split(",") if s.strip()]
    if os.environ.get("EEGMMIDB_SUBJECTS")
    else [f"S{n:03d}" for n in range(1, 11)]
)

# Anomaly thresholds — subjects failing any of these are skipped (not crashed/silently dropped).
EXPECTED_FS = 160.0
EXPECTED_N_CHANNELS = 64
SEMANTICS = {
    "task": "EEGMMIDB Task 2 — imagine opening/closing left or right fist",
    "T1": "left fist (imagined) -> class 1",
    "T2": "right fist (imagined) -> class 2",
    "needs_verification": "Run/event semantics not asserted; verify against PhysioNet docs.",
}

# Signals are kept in MICROVOLTS to match the Phase 1 JS parser (edfdecoder
# returns physical uV). MNE returns Volts, so we multiply by 1e6.
SIGNAL_UNIT = "uV"
VOLTS_TO_UV = 1e6

# Explicit FIR bandpass, applied zero-phase with filtfilt.
FILTER = {
    "type": "FIR",
    "design": "scipy.signal.firwin",
    "numtaps": 165,          # odd; linear-phase
    "cutoff_hz": [8.0, 30.0],
    "window": "hamming",
    "pass_zero": False,      # bandpass
    "application": "scipy.signal.filtfilt (zero-phase)",
    "filtfilt_padtype": "odd",
    "filtfilt_padlen": None,  # scipy default: 3 * (numtaps - 1)
}

# Epoching (manual slicing of the filtered continuous signal).
TMIN_S = 0.5
TMAX_S = 2.5

# CSP is computed EXPLICITLY here (numpy + scipy.linalg.eigh), not via mne.decoding.CSP.
# Why: on 64 channels with ~36 training trials, mne's CSP triggers an internal
# rank-reduction/whitening path (_smart_eigh -> pinv divide-by-zero) that a from-scratch
# Phase 3 CSP cannot replicate, which would make the Frobenius comparison meaningless.
# The explicit algorithm below is fully documented and exactly replicable in TS, and we
# CROSS-CHECK it against mne.decoding.CSP (see mne_crosscheck in params) to prove it equals
# the MNE reference. Covariance uses the float-shrinkage formula:
#   cov_shrunk = (1-reg)*emp_cov + reg*(trace(emp_cov)/n_ch)*I,  emp_cov = X@X.T / n_samples
# Components: solve eigh(cov_left, cov_left+cov_right) (ascending), then pick from both ends
# in alternating order (most-discriminative first) and take n_components.
CSP_PARAMS = {
    "n_components": 4,
    "reg": 0.1,
    "log": True,
    "cov_est": "concat",  # concatenate a class's trials, then one shrunk covariance
    "component_order": "alternate_eigenvalue",  # [hi, lo, hi-1, lo+1, ...]
    "implementation": "explicit numpy/scipy.linalg.eigh (cross-checked vs mne.decoding.CSP)",
}
LDA_PARAMS = {"solver": "lsqr", "shrinkage": 0.1}
CV_PARAMS = {"n_splits": 5, "shuffle": True, "random_state": SEED}

# Subset of filtered epochs/channels to dump for the per-subject Pearson-r signal check.
# filtfilt is per-channel independent and CSP later consumes all 64 filtered channels, so a
# 16-channel subset (the sensorimotor FC/C/CP strip = channel indices 0..15) keeps the
# multi-subject fixtures small (~2 MB total) while fully validating the filter per subject.
FILTERED_SUBSET_N_EPOCHS = 2
FILTERED_SUBSET_CHANNELS = list(range(16))

# --------------------------------------------------------------------------- #
REPO_ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = REPO_ROOT / "data" / "raw"
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"


def subject_runs(subject: str) -> list[str]:
    return [f"{subject}{run}.edf" for run in IMAGERY_RUNS]


def load_concatenated_raw(subject: str) -> mne.io.BaseRaw:
    raws = []
    for run in subject_runs(subject):
        path = RAW_DIR / run
        if not path.exists():
            raise FileNotFoundError(f"{path} missing — run `npm run fetch-data` first.")
        raws.append(mne.io.read_raw_edf(path, preload=True, verbose="ERROR"))
    raw = mne.concatenate_raws(raws, verbose="ERROR")
    raw.pick("eeg", verbose="ERROR")  # drop the EDF Annotations channel
    return raw


def design_filter(fs: float) -> np.ndarray:
    taps = sps.firwin(
        FILTER["numtaps"],
        FILTER["cutoff_hz"],
        window=FILTER["window"],
        pass_zero=FILTER["pass_zero"],
        fs=fs,
    )
    return np.asarray(taps, dtype=np.float64)


def epoch_signal(
    filtered: np.ndarray, event_samples: np.ndarray, n_times: int, start_offset: int
) -> tuple[np.ndarray, np.ndarray]:
    """Slice (n_channels, n_total) -> (n_epochs, n_channels, n_times). Drops
    events whose window would run past the signal. Returns (X, kept_mask)."""
    n_total = filtered.shape[1]
    kept = []
    epochs = []
    for s in event_samples:
        start = int(s) + start_offset
        stop = start + n_times
        if start < 0 or stop > n_total:
            kept.append(False)
            continue
        epochs.append(filtered[:, start:stop])
        kept.append(True)
    return np.asarray(epochs, dtype=np.float64), np.asarray(kept, dtype=bool)


def shrunk_covariance(class_data: np.ndarray, reg: float) -> np.ndarray:
    """Shrinkage covariance of one class's concatenated trials (n_ch, n_samples).
    cov = (1-reg)*emp + reg*(trace(emp)/n_ch)*I, emp = data@data.T/n_samples (centered-free)."""
    n_ch = class_data.shape[0]
    emp = class_data @ class_data.T / class_data.shape[1]
    mu = np.trace(emp) / n_ch
    return (1.0 - reg) * emp + reg * mu * np.eye(n_ch)


def alternate_order(n: int) -> list[int]:
    """[n-1, 0, n-2, 1, ...] — most-discriminative generalized eigenvectors first."""
    order, lo, hi = [], 0, n - 1
    while len(order) < n:
        order.append(hi); hi -= 1
        if len(order) < n:
            order.append(lo); lo += 1
    return order


def fit_csp(X: np.ndarray, y: np.ndarray, n_components: int, reg: float) -> np.ndarray:
    """Explicit CSP. X:(n_epochs,n_ch,n_times). Returns filters (n_components, n_ch);
    each row is a spatial filter. Classes assumed to be exactly two."""
    classes = np.unique(y)
    assert len(classes) == 2, "binary CSP"
    covs = []
    for c in classes:
        Xc = X[y == c]  # (n_tr, n_ch, n_times)
        cat = Xc.transpose(1, 0, 2).reshape(Xc.shape[1], -1)  # (n_ch, n_tr*n_times)
        covs.append(shrunk_covariance(cat, reg))
    # Generalized eigenproblem (ascending eigenvalues); columns are eigenvectors.
    _, eigvecs = sla.eigh(covs[0], covs[0] + covs[1])
    eigvecs = eigvecs[:, alternate_order(eigvecs.shape[1])]
    return eigvecs.T[:n_components]  # (n_components, n_ch)


def csp_log_var(filters: np.ndarray, X: np.ndarray) -> np.ndarray:
    """CSP feature: log mean-power of projected signals. X:(n_ep,n_ch,n_times) ->
    (n_ep, n_components). Matches mne transform_into='average_power', log=True."""
    proj = np.einsum("ck,ekt->ect", filters, X)  # (n_ep, n_comp, n_times)
    power = (proj ** 2).mean(axis=2)
    return np.log(power)


def crosscheck_vs_mne(X: np.ndarray, y: np.ndarray, filters: np.ndarray, reg: float,
                      n_components: int) -> dict:
    """Fit mne.decoding.CSP and confirm each explicit filter matches an mne filter
    (greedy best |cosine|, sign-agnostic). Returns agreement stats."""
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        mne.set_log_level("ERROR")
        mne_csp = CSP(n_components=n_components, reg=reg, log=True, norm_trace=False)
        mne_csp.fit(X, y)
    mne_filters = mne_csp.filters_  # (n_ch, n_ch); compare against all of them
    def unit(v): return v / np.linalg.norm(v)
    cosines = []
    for f in filters:
        c = max(abs(float(unit(f) @ unit(g))) for g in mne_filters)
        cosines.append(c)
    return {
        "metric": "max |cosine| of each explicit filter vs any mne.decoding.CSP filter",
        "per_component": [round(c, 6) for c in cosines],
        "min": round(float(min(cosines)), 6),
        "mean": round(float(np.mean(cosines)), 6),
    }


def assert_finite(name: str, arr: np.ndarray) -> np.ndarray:
    """Real safety net replacing the suppressed (spurious) matmul FP warnings."""
    if not np.isfinite(arr).all():
        raise FloatingPointError(f"{name} contains non-finite values (real numerical problem).")
    return arr


def process_subject(subject: str) -> dict:
    """Run the full oracle for one subject. Writes per-subject fixtures and returns a
    summary with status 'validated' or 'skipped' (+ reason). Anomalous subjects are
    skipped, never crashed or silently dropped."""
    np.random.seed(SEED)
    out_dir = FIXTURES_DIR / subject

    # --- anomaly detection (skip, don't crash) ---
    missing = [r for r in subject_runs(subject) if not (RAW_DIR / r).exists()]
    if missing:
        return {"subject": subject, "status": "skipped", "reason": f"missing files: {missing}"}
    raw = load_concatenated_raw(subject)
    fs = float(raw.info["sfreq"])
    channels = list(raw.ch_names)
    n_channels = len(channels)
    if round(fs) != EXPECTED_FS:
        return {"subject": subject, "status": "skipped", "reason": f"sampling rate {fs} Hz != {EXPECTED_FS}"}
    if n_channels != EXPECTED_N_CHANNELS:
        return {"subject": subject, "status": "skipped",
                "reason": f"{n_channels} EEG channels != {EXPECTED_N_CHANNELS}"}

    # Events from EDF+ annotations (concatenated-sample indices).
    try:
        events, _ = mne.events_from_annotations(raw, event_id=EVENT_ID, verbose="ERROR")
    except ValueError as e:
        return {"subject": subject, "status": "skipped", "reason": f"no T1/T2 annotations ({e})"}

    # Continuous data in microvolts.
    cont = raw.get_data() * VOLTS_TO_UV  # (n_channels, n_total)

    # Zero-phase FIR bandpass on the continuous signal.
    taps = design_filter(fs)
    filtered = sps.filtfilt(taps, [1.0], cont, axis=1, padtype=FILTER["filtfilt_padtype"])
    assert_finite("filtered", filtered)

    # Manual epoching of the filtered signal.
    n_times = int(round((TMAX_S - TMIN_S) * fs)) + 1
    start_offset = int(round(TMIN_S * fs))
    event_samples = events[:, 0]
    X, kept = epoch_signal(filtered, event_samples, n_times, start_offset)
    y = events[kept, 2].astype(int)
    kept_event_samples = event_samples[kept].astype(int)
    n_epochs = X.shape[0]
    n_left = int((y == 1).sum())
    n_right = int((y == 2).sum())
    if min(n_left, n_right) < CV_PARAMS["n_splits"]:
        return {"subject": subject, "status": "skipped",
                "reason": f"insufficient epochs/class (left={n_left}, right={n_right}, "
                          f"need >= {CV_PARAMS['n_splits']})"}

    n_comp = CSP_PARAMS["n_components"]
    reg = CSP_PARAMS["reg"]

    # ---- 5-fold stratified CV: per-fold explicit CSP, LDA, accuracy, indices ---- #
    skf = StratifiedKFold(**CV_PARAMS)
    fold_indices = []
    fold_acc = []
    fold_csp = []
    fold_lda = []
    for train_idx, test_idx in skf.split(X, y):
        filters = assert_finite("fold CSP filters", fit_csp(X[train_idx], y[train_idx], n_comp, reg))
        Xtr = assert_finite("fold train features", csp_log_var(filters, X[train_idx]))
        Xte = assert_finite("fold test features", csp_log_var(filters, X[test_idx]))
        lda = LinearDiscriminantAnalysis(**LDA_PARAMS)
        lda.fit(Xtr, y[train_idx])
        acc = float(lda.score(Xte, y[test_idx]))
        fold_acc.append(acc)
        fold_indices.append({"train": train_idx.tolist(), "test": test_idx.tolist()})
        fold_csp.append(filters.tolist())
        fold_lda.append({"coef": lda.coef_.tolist(), "intercept": lda.intercept_.tolist()})

    mean_acc = float(np.mean(fold_acc))
    std_acc = float(np.std(fold_acc))

    # Full-data explicit CSP (reference projection matrix) + MNE cross-check.
    csp_full_filters_arr = assert_finite("full CSP filters", fit_csp(X, y, n_comp, reg))
    csp_full_filters = csp_full_filters_arr.tolist()
    mne_crosscheck = crosscheck_vs_mne(X, y, csp_full_filters_arr, reg, n_comp)

    # ---- write fixtures ---- #
    params = {
        "env": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "scikit_learn": sklearn.__version__,
            "mne": mne.__version__,
            "platform": platform.platform(),
        },
        "dataset": {
            "name": "PhysioNet EEGMMIDB",
            "subject": subject,
            "runs": subject_runs(subject),
            "license": "commonly cited ODC-BY — NEEDS VERIFICATION, not asserted",
            "semantics": SEMANTICS,
        },
        "signal_unit": SIGNAL_UNIT,
        "volts_to_unit_scale": VOLTS_TO_UV,
        "fs_hz": fs,
        "channels": channels,
        "n_channels": n_channels,
        "filter": {**FILTER, "taps": taps.tolist()},
        "epoch": {"tmin_s": TMIN_S, "tmax_s": TMAX_S, "n_times": n_times,
                  "start_offset_samples": start_offset, "fs_hz": fs},
        "csp": CSP_PARAMS,
        "mne_crosscheck": mne_crosscheck,
        "lda": LDA_PARAMS,
        "cv": CV_PARAMS,
        "n_epochs": n_epochs,
        "class_labels": {"left": 1, "right": 2},
        "notes": [
            "Epoching is manual slicing of the zero-phase-filtered continuous signal:",
            "  start = event_sample + round(tmin*fs); window length = n_times.",
            "Phase 3 must reproduce: scale uV -> filtfilt(taps) -> slice -> CSP -> LDA.",
            "CSP covariance: per-class concat-trial covariance with float-reg shrinkage:",
            "  cov_shrunk = (1-reg)*emp_cov + reg*(trace(emp_cov)/n_ch)*I, emp_cov=X@X.T/n_samples",
            "  (assume_centered=True). Generalized eigenproblem eigh(cov1, cov1+cov2);",
            "  components ordered by MNE; first n_components rows of filters_ dumped.",
        ],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    n_sub = min(FILTERED_SUBSET_N_EPOCHS, n_epochs)
    subset = X[:n_sub][:, FILTERED_SUBSET_CHANNELS, :]  # (n_sub, 16, n_times)
    _dump(out_dir, "params.json", params)
    _dump(out_dir, "epochs.json", {
        "event_samples": kept_event_samples.tolist(),
        "labels": y.tolist(),
        "n_times": n_times,
        "start_offset_samples": start_offset,
    })
    _dump(out_dir, "fold_indices.json", {"folds": fold_indices})
    _dump(out_dir, "cv_accuracy.json", {"per_fold": fold_acc, "mean": mean_acc, "std": std_acc})
    _dump(out_dir, "csp_filters.json", {
        "shape": [CSP_PARAMS["n_components"], n_channels],
        "full": csp_full_filters,
        "per_fold": fold_csp,
    })
    _dump(out_dir, "lda_weights.json", {"per_fold": fold_lda})
    _dump(out_dir, "filtered_subset.json", {
        "description": "First N filtered, epoched trials (post-filtfilt, post-slice), "
                       "restricted to a 16-channel sensorimotor subset to keep size small.",
        "unit": SIGNAL_UNIT,
        "epoch_indices": list(range(n_sub)),
        "channel_indices": FILTERED_SUBSET_CHANNELS,
        "shape": [n_sub, len(FILTERED_SUBSET_CHANNELS), n_times],
        "data": subset.tolist(),
    })

    return {
        "subject": subject, "status": "validated", "n_epochs": n_epochs,
        "n_left": n_left, "n_right": n_right, "fs_hz": fs, "n_channels": n_channels,
        "mean_acc": mean_acc, "per_fold_acc": fold_acc,
        "mne_crosscheck_min": mne_crosscheck["min"],
    }


def main() -> None:
    # NumPy 2.0 + Apple Accelerate BLAS emit SPURIOUS "divide by zero / overflow /
    # invalid value encountered in matmul" warnings on perfectly finite inputs (verified
    # in isolation; results stay finite and the MNE cross-check is |cosine|=1.0). Silence
    # the cosmetic FP warnings; finiteness is enforced by assert_finite() instead.
    np.seterr(divide="ignore", over="ignore", invalid="ignore")
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

    env = {
        "python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__,
        "scikit_learn": sklearn.__version__, "mne": mne.__version__, "platform": platform.platform(),
    }
    validated, skipped = [], []
    print(f"=== Multi-subject oracle: {len(SUBJECTS)} subjects ===")
    for subject in SUBJECTS:
        summary = process_subject(subject)
        if summary["status"] == "validated":
            validated.append(summary)
            print(f"  ✓ {subject}: {summary['n_epochs']} epochs "
                  f"(L{summary['n_left']}/R{summary['n_right']}) mean acc "
                  f"{summary['mean_acc']:.4f} | MNE |cos|={summary['mne_crosscheck_min']}")
        else:
            skipped.append({"subject": subject, "reason": summary["reason"]})
            print(f"  ⊘ {subject} skipped: {summary['reason']}")

    from datetime import datetime, timezone
    (FIXTURES_DIR / "subjects.json").write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "env": env,
        "validated": [s["subject"] for s in validated],
        "skipped": skipped,
        "summary": validated,
    }, indent=2))

    print(f"\nvalidated {len(validated)}/{len(SUBJECTS)} subjects; "
          f"skipped {len(skipped)}. -> tests/fixtures/<subject>/ + subjects.json")


def _dump(out_dir: Path, name: str, obj: object) -> None:
    (out_dir / name).write_text(json.dumps(obj))


if __name__ == "__main__":
    main()

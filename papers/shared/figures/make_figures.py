#!/usr/bin/env python3
"""Generate paper figures as PDFs from REAL repo data only (no invented points).

Sources: tests/fixtures/<subject>/cv_accuracy.json, tests/fixtures/S001/csp_filters.json,
papers/shared/figures/agreement.json, benchmarks/results.json. Run with the project venv:
    scripts/oracle/.venv/bin/python papers/shared/figures/make_figures.py
"""
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
FIX = ROOT / "tests" / "fixtures"


def load(p):
    return json.loads(Path(p).read_text())


SUBJECTS = load(FIX / "subjects.json")["validated"]
AGREE = load(HERE / "agreement.json")
RESULTS = load(ROOT / "benchmarks" / "results.json")
STAGES = ["parse", "filter", "epoch", "csp+lda", "cv"]
COLORS = ["#9ca3af", "#2563eb", "#16a34a", "#f59e0b", "#dc2626"]


def fig_accuracy():
    means = [load(FIX / s / "cv_accuracy.json")["mean"] * 100 for s in SUBJECTS]
    fig, ax = plt.subplots(figsize=(6.4, 3.2))
    ax.bar(SUBJECTS, means, color="#2563eb")
    ax.axhline(50, color="#888", ls="--", lw=1, label="chance (50%)")
    ax.set_ylabel("5-fold CV accuracy (%)")
    ax.set_ylim(0, 100)
    ax.set_title("Per-subject accuracy — browser pipeline == MNE oracle\n"
                 "(filter r=1.0; CSP Frobenius <2e-14; LDA diff <3e-12 for every subject)", fontsize=9)
    ax.legend(fontsize=8)
    plt.xticks(rotation=45, fontsize=8)
    fig.tight_layout()
    fig.savefig(HERE / "accuracy.pdf")
    plt.close(fig)


def fig_csp():
    filt = np.array(load(FIX / "S001" / "csp_filters.json")["full"])  # (4, 64)
    fig, ax = plt.subplots(figsize=(6.4, 2.4))
    vmax = np.abs(filt).max()
    im = ax.imshow(filt, aspect="auto", cmap="RdBu_r", vmin=-vmax, vmax=vmax)
    ax.set_yticks(range(4))
    ax.set_yticklabels([f"CSP {i + 1}" for i in range(4)])
    ax.set_xlabel("EEG channel (1–64)")
    ax.set_title("S001 CSP spatial filters (4 components × 64 channels)", fontsize=9)
    fig.colorbar(im, ax=ax, fraction=0.025, pad=0.02, label="weight")
    fig.tight_layout()
    fig.savefig(HERE / "csp_s001.pdf")
    plt.close(fig)


def _stage_means(cond):
    return [cond["perStage"][s]["mean"] for s in STAGES]


def fig_performance():
    w1 = next(c for c in RESULTS["conditionsWorker"] if c["rate"] == 1)
    mains = {c["rate"]: c for c in RESULTS["conditionsMain"]}
    bars = [("worker 1x\n(real app)", w1), ("main 1x", mains[1]), ("main 4x", mains[4]), ("main 6x", mains[6])]
    fig, ax = plt.subplots(figsize=(6.4, 3.4))
    x = np.arange(len(bars))
    bottom = np.zeros(len(bars))
    for si, s in enumerate(STAGES):
        vals = np.array([_stage_means(c)[si] for _, c in bars])
        ax.bar(x, vals, bottom=bottom, color=COLORS[si], label=s)
        bottom += vals
    for i, (_, c) in enumerate(bars):
        ax.text(i, c["total"]["mean"] + 80, f"{c['total']['mean']:.0f}", ha="center", fontsize=8, fontweight="bold")
    ax.set_xticks(x)
    ax.set_xticklabels([b[0] for b in bars], fontsize=8)
    ax.set_ylabel("runtime (ms)")
    hw = RESULTS["hardware"]
    ax.set_title(f"Pipeline runtime ({hw['cpu']}, {hw['browser'].replace('Playwright ', '')}, n={RESULTS['method']['repsPerCondition']})\n"
                 "main 4x/6x = CPU-throttled PROXY, not a physical device", fontsize=9)
    ax.legend(fontsize=8, ncol=5, loc="upper left")
    fig.tight_layout()
    fig.savefig(HERE / "performance.pdf")
    plt.close(fig)


def fig_throttle_finding():
    rates = [1, 4, 6]
    w = {c["rate"]: c["total"]["mean"] for c in RESULTS["conditionsWorker"]}
    m = {c["rate"]: c["total"]["mean"] for c in RESULTS["conditionsMain"]}
    fig, ax = plt.subplots(figsize=(6.0, 3.2))
    x = np.arange(len(rates))
    ax.bar(x - 0.2, [w[r] for r in rates], 0.4, label="Web Worker (real app)", color="#9ca3af")
    ax.bar(x + 0.2, [m[r] for r in rates], 0.4, label="main thread (proxy)", color="#2563eb")
    ax.set_xticks(x)
    ax.set_xticklabels([f"{r}x CPU" for r in rates])
    ax.set_ylabel("total runtime (ms)")
    ax.set_title("CDP CPU throttling reaches the main thread but NOT Web Workers\n"
                 "(worker ~flat; main-thread proxy scales ~1/4/6x)", fontsize=9)
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(HERE / "throttle_finding.pdf")
    plt.close(fig)


if __name__ == "__main__":
    fig_accuracy()
    fig_csp()
    fig_performance()
    fig_throttle_finding()
    print("wrote accuracy.pdf csp_s001.pdf performance.pdf throttle_finding.pdf")

/**
 * Single source of validation tolerances (Phase 2).
 *
 * These thresholds decide whether the Phase 3 TS pipeline is judged equivalent to
 * the MNE/scikit-learn oracle. Keep them here so they are easy to audit and tune.
 */

/** Filtered-signal agreement: Pearson r must exceed this (target from the spec). */
export const PEARSON_R_MIN = 0.999;

/** Paired t-test on per-fold accuracies: p > this ⇒ accuracies are equivalent. */
export const TTEST_P_MIN = 0.05;

/**
 * CSP projection-matrix agreement: aligned Frobenius norm of (oracle − impl) must be
 * below this. CALIBRATED in Phase 3: the TS CSP (Cholesky reduction + ml-matrix symmetric
 * EVD) reproduced the oracle's scipy.linalg.eigh filters to an aligned Frobenius diff of
 * ~8.2e-15 — i.e. floating-point round-off between two LAPACK-class symmetric solvers.
 * Set to 1e-12, comfortably above the achieved value while still ~1000× machine epsilon.
 */
export const CSP_FROBENIUS_MAX = 1e-12;

/**
 * LDA weight/bias agreement vs the oracle (sklearn lsqr). The TS LDA solves the same 4×4
 * system, so agreement is float round-off. Achieved ~1e-13 in Phase 3; set to 1e-9.
 */
export const LDA_WEIGHT_MAX = 1e-9;

/** Generic float comparison epsilon for shape/exactness checks. */
export const FLOAT_EPS = 1e-9;

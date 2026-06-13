/**
 * Stage 1 — zero-phase FIR filtering, replicating scipy.signal.filtfilt EXACTLY.
 *
 * The oracle (Phase 2) designed an FIR bandpass (8–30 Hz, 165 taps) and applied it with
 * scipy.signal.filtfilt(padtype='odd', padlen=None). To reproduce it to machine precision
 * we mirror scipy's exact procedure (verified against scipy: max abs diff = 0.0):
 *   odd-extend by padlen → forward lfilter with initial state zi*ext[0] → reverse →
 *   lfilter with zi*y[0] → reverse → trim padlen.
 *
 * All coefficients come from params.json — nothing is redesigned here.
 */

/**
 * Steady-state initial conditions for an FIR filter (a = [1]).
 * Closed form: zi[k] = sum(b[k+1:]) (matches scipy.signal.lfilter_zi to ~1e-16).
 */
export function lfilterZiFir(b: number[] | Float64Array): Float64Array {
  const m = b.length - 1; // state length = numtaps - 1
  const zi = new Float64Array(m);
  let suffix = 0;
  // zi[k] = sum of b[k+1 ..]; build from the right.
  for (let k = m - 1; k >= 0; k--) {
    suffix += b[k + 1]!;
    zi[k] = suffix;
  }
  return zi;
}

/**
 * FIR filter via scipy's transposed-direct-form-II recurrence (denominator a = [1]),
 * with caller-supplied initial state `zi` (length b.length-1).
 */
export function lfilter(b: number[] | Float64Array, x: Float64Array, zi: Float64Array): Float64Array {
  const n = b.length;
  const z = Float64Array.from(zi); // working state, mutated
  const y = new Float64Array(x.length);
  const b0 = b[0]!;
  for (let m = 0; m < x.length; m++) {
    const xm = x[m]!;
    const ym = b0 * xm + z[0]!;
    y[m] = ym;
    // a[i+1] = 0 for an FIR filter, so the -a*ym terms vanish.
    for (let i = 0; i < n - 2; i++) z[i] = b[i + 1]! * xm + z[i + 1]!;
    z[n - 2] = b[n - 1]! * xm;
  }
  return y;
}

/** scipy "odd" extension of `x` by `padlen` samples on each end. */
function oddExtend(x: Float64Array, padlen: number): Float64Array {
  const n = x.length;
  const ext = new Float64Array(n + 2 * padlen);
  const x0 = x[0]!;
  const xN = x[n - 1]!;
  for (let i = 0; i < padlen; i++) {
    ext[i] = 2 * x0 - x[padlen - i]!; // mirrors x[padlen:0:-1]
    ext[n + padlen + i] = 2 * xN - x[n - 2 - i]!; // mirrors x[-2:-(padlen+2):-1]
  }
  ext.set(x, padlen);
  return ext;
}

function reversed(x: Float64Array): Float64Array {
  const n = x.length;
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) r[i] = x[n - 1 - i]!;
  return r;
}

/**
 * Zero-phase filtfilt of a single channel. `padtype` only 'odd' is supported (the oracle's).
 * `padlen` defaults to scipy's `3 * max(len(a), len(b))` = 3 * numtaps (a is trivial here).
 */
export function filtfilt(
  taps: number[] | Float64Array,
  x: Float64Array,
  padlen: number = 3 * taps.length,
): Float64Array {
  if (x.length <= padlen) {
    throw new Error(`filtfilt: signal length ${x.length} must exceed padlen ${padlen}`);
  }
  const zi = lfilterZiFir(taps);
  const ext = oddExtend(x, padlen);

  const ziF = scale(zi, ext[0]!);
  let y = lfilter(taps, ext, ziF);
  y = reversed(y);
  const ziB = scale(zi, y[0]!);
  y = lfilter(taps, y, ziB);
  y = reversed(y);

  return y.subarray(padlen, y.length - padlen);
}

function scale(v: Float64Array, k: number): Float64Array {
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * k;
  return out;
}

/** Apply filtfilt to every channel of a (n_channels × n_samples) signal set. */
export function filtfiltChannels(taps: number[] | Float64Array, signals: Float64Array[]): Float64Array[] {
  return signals.map((ch) => filtfilt(taps, ch));
}

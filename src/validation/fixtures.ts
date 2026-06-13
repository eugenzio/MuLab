/**
 * Typed loader + shape validation for the Phase 2 oracle fixtures (tests/fixtures/).
 *
 * `params.json` is the single source of truth that Phase 3 will consume. The parse*
 * functions are pure (take already-parsed JSON); `readFixtures` is a Node helper used
 * by tests/CI (not imported by the browser bundle).
 */

export interface FilterParams {
  type: string;
  numtaps: number;
  cutoff_hz: [number, number];
  window: string;
  pass_zero: boolean;
  application: string;
  filtfilt_padtype: string;
  taps: number[];
}

export interface EpochParams {
  tmin_s: number;
  tmax_s: number;
  n_times: number;
  start_offset_samples: number;
  fs_hz: number;
}

export interface Params {
  env: Record<string, string>;
  dataset: Record<string, unknown>;
  signal_unit: string;
  fs_hz: number;
  channels: string[];
  n_channels: number;
  filter: FilterParams;
  epoch: EpochParams;
  csp: { n_components: number; reg: number; log: boolean; [k: string]: unknown };
  lda: { solver: string; shrinkage: number };
  cv: { n_splits: number; shuffle: boolean; random_state: number };
  n_epochs: number;
}

export interface Epochs {
  event_samples: number[];
  labels: number[];
  n_times: number;
  start_offset_samples: number;
}

export interface FoldIndices {
  folds: { train: number[]; test: number[] }[];
}

export interface CvAccuracy {
  per_fold: number[];
  mean: number;
  std: number;
}

export interface CspFilters {
  shape: [number, number];
  full: number[][];
  per_fold: number[][][];
}

export interface FilteredSubset {
  unit: string;
  epoch_indices: number[];
  /** Channel indices the subset was restricted to (sensorimotor strip, size-saving). */
  channel_indices: number[];
  shape: [number, number, number];
  data: number[][][];
}

export interface LdaWeights {
  /** Per fold: binary-collapsed coef ([[w0..wF]]) and intercept ([b]). */
  per_fold: { coef: number[][]; intercept: number[] }[];
}

export interface Fixtures {
  params: Params;
  epochs: Epochs;
  foldIndices: FoldIndices;
  cvAccuracy: CvAccuracy;
  cspFilters: CspFilters;
  filteredSubset: FilteredSubset;
  ldaWeights: LdaWeights;
}

/** Validate cross-fixture shape consistency. Throws on the first mismatch. */
export function validateFixtures(f: Fixtures): void {
  const { params, cspFilters, filteredSubset, foldIndices, cvAccuracy, epochs } = f;
  const nc = params.n_channels;

  if (params.channels.length !== nc) {
    throw new Error(`channels length ${params.channels.length} ≠ n_channels ${nc}`);
  }
  if (params.filter.taps.length !== params.filter.numtaps) {
    throw new Error(`taps length ${params.filter.taps.length} ≠ numtaps ${params.filter.numtaps}`);
  }
  // CSP matrix: (n_components × n_channels).
  const ncomp = params.csp.n_components;
  if (cspFilters.shape[0] !== ncomp || cspFilters.shape[1] !== nc) {
    throw new Error(`csp shape ${cspFilters.shape} ≠ [${ncomp}, ${nc}]`);
  }
  if (cspFilters.full.length !== ncomp || cspFilters.full[0]!.length !== nc) {
    throw new Error('csp.full dims do not match declared shape');
  }
  if (cspFilters.per_fold.length !== params.cv.n_splits) {
    throw new Error(`csp.per_fold folds ${cspFilters.per_fold.length} ≠ n_splits ${params.cv.n_splits}`);
  }
  // Folds + accuracies.
  if (foldIndices.folds.length !== params.cv.n_splits) {
    throw new Error('fold_indices folds ≠ n_splits');
  }
  if (cvAccuracy.per_fold.length !== params.cv.n_splits) {
    throw new Error('cv_accuracy per_fold ≠ n_splits');
  }
  // Filtered subset: (n_epochs_subset × n_subset_channels × n_times).
  const [se, sc, st] = filteredSubset.shape;
  if (sc !== filteredSubset.channel_indices.length || st !== params.epoch.n_times) {
    throw new Error(`filtered_subset shape ${filteredSubset.shape} inconsistent with channel_indices/n_times`);
  }
  if (Math.max(...filteredSubset.channel_indices) >= nc) {
    throw new Error('filtered_subset channel_indices out of range');
  }
  if (filteredSubset.data.length !== se) throw new Error('filtered_subset data length ≠ shape[0]');
  // Epochs labels match dumped count.
  if (epochs.labels.length !== params.n_epochs || epochs.event_samples.length !== params.n_epochs) {
    throw new Error('epochs labels/event_samples length ≠ n_epochs');
  }
}

/** Node-only: read + validate all fixtures from a directory. */
export async function readFixtures(dir: string): Promise<Fixtures> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const read = async <T>(name: string): Promise<T> =>
    JSON.parse(await readFile(join(dir, name), 'utf8')) as T;

  const fixtures: Fixtures = {
    params: await read<Params>('params.json'),
    epochs: await read<Epochs>('epochs.json'),
    foldIndices: await read<FoldIndices>('fold_indices.json'),
    cvAccuracy: await read<CvAccuracy>('cv_accuracy.json'),
    cspFilters: await read<CspFilters>('csp_filters.json'),
    filteredSubset: await read<FilteredSubset>('filtered_subset.json'),
    ldaWeights: await read<LdaWeights>('lda_weights.json'),
  };
  validateFixtures(fixtures);
  return fixtures;
}

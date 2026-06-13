/**
 * Stage 2 — epoching: slice the filtered continuous signal around events.
 *
 * Replicates the oracle's manual epoching: start = eventSample + start_offset_samples,
 * window length = n_times. All parameters come from params.json / epochs.json.
 */
import type { EegAnnotation } from '../parsers/types.ts';

/** An epoch: one Float64Array per channel, each of length n_times. */
export type Epoch = Float64Array[];

/**
 * Slice epochs from a (n_channels × n_samples) filtered signal. Events whose window
 * would exceed the signal are dropped (returned in `kept`), matching the oracle.
 */
export function epochSignal(
  filtered: Float64Array[],
  eventSamples: number[],
  startOffset: number,
  nTimes: number,
): { epochs: Epoch[]; kept: boolean[] } {
  const nSamples = filtered[0]?.length ?? 0;
  const epochs: Epoch[] = [];
  const kept: boolean[] = [];
  for (const s of eventSamples) {
    const start = s + startOffset;
    const stop = start + nTimes;
    if (start < 0 || stop > nSamples) {
      kept.push(false);
      continue;
    }
    epochs.push(filtered.map((ch) => ch.subarray(start, stop)));
    kept.push(true);
  }
  return { epochs, kept };
}

/**
 * Cross-check helper: derive concatenated T1/T2 event samples from per-run annotations,
 * matching MNE's events_from_annotations (sample = round(onsetSec * fs) + run offset).
 * Used to validate the parser→event path against the dumped event_samples.
 */
export function extractT12Events(
  runAnnotations: EegAnnotation[][],
  runLengths: number[],
  fs: number,
): { sample: number; label: number }[] {
  const events: { sample: number; label: number }[] = [];
  let offset = 0;
  for (let r = 0; r < runAnnotations.length; r++) {
    for (const a of runAnnotations[r]!) {
      const cls = a.label === 'T1' ? 1 : a.label === 'T2' ? 2 : 0;
      if (cls === 0) continue;
      events.push({ sample: Math.round(a.onsetSec * fs) + offset, label: cls });
    }
    offset += runLengths[r]!;
  }
  return events;
}

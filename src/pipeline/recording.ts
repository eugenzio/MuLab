/**
 * Concatenate parsed EDF runs into one continuous recording and derive its T1/T2 events.
 *
 * Shared by the browser entry (`runFromBuffers`) and the test helper. The concatenation
 * order is the caller's (runs are passed already in R04→R08→R12 order), matching the oracle.
 */
import type { EegRecording } from '../parsers/types.ts';
import { extractT12Events } from './epoch.ts';

export interface ConcatenatedRecording {
  channels: string[];
  /** Concatenated continuous signal, one Float64Array per channel (µV). */
  signals: Float64Array[];
  sampleRateHz: number;
  runLengths: number[];
}

/** Concatenate per-channel signals across runs (edfdecoder returns physical µV). */
export function concatRecordings(recs: EegRecording[]): ConcatenatedRecording {
  if (recs.length === 0) throw new Error('concatRecordings: no recordings');
  const channels = recs[0]!.channels;
  const nCh = channels.length;
  for (const r of recs) {
    if (r.channels.length !== nCh) {
      throw new Error(`channel count mismatch: ${r.channels.length} vs ${nCh}`);
    }
  }
  const runLengths = recs.map((r) => r.nSamples);
  const total = runLengths.reduce((s, n) => s + n, 0);

  const signals: Float64Array[] = [];
  for (let c = 0; c < nCh; c++) {
    const cat = new Float64Array(total);
    let off = 0;
    for (const rec of recs) {
      cat.set(rec.signals[c]!, off);
      off += rec.nSamples;
    }
    signals.push(cat);
  }
  return { channels, signals, sampleRateHz: recs[0]!.sampleRateHz, runLengths };
}

/**
 * Derive concatenated T1/T2 event samples + labels from the per-run annotations.
 * Reuses the Phase-3-validated `extractT12Events` (parser-derived events == oracle).
 */
export function concatEvents(recs: EegRecording[], sampleRateHz: number): {
  eventSamples: number[];
  labels: number[];
} {
  const runAnnotations = recs.map((r) => r.annotations);
  const runLengths = recs.map((r) => r.nSamples);
  const events = extractT12Events(runAnnotations, runLengths, sampleRateHz);
  return { eventSamples: events.map((e) => e.sample), labels: events.map((e) => e.label) };
}

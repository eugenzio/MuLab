/// <reference lib="webworker" />
/**
 * Parse worker — proves the parsing path runs off the main thread (Phase 1).
 * Heavy compute (filtering, CSP, LDA) will be added here in Phase 3.
 */
import { parseEdf } from '../parsers/edf.ts';
import { parseGdf, GdfUnsupportedError } from '../parsers/gdf.ts';
import type { EegRecording } from '../parsers/types.ts';

export interface ParseRequest {
  buffer: ArrayBuffer;
  kind: 'edf' | 'gdf';
}

/** Lightweight, postMessage-friendly summary (no large signal arrays echoed back). */
export interface ParseSummary {
  ok: boolean;
  format: EegRecording['format'] | 'gdf-unsupported';
  channels: number;
  sampleRateHz: number;
  nSamples: number;
  annotationCount: number;
  firstChannels: string[];
  firstAnnotations: { onsetSec: number; durationSec: number; label: string }[];
  notes: string[];
  error?: string;
}

self.onmessage = (e: MessageEvent<ParseRequest>) => {
  const { buffer, kind } = e.data;
  try {
    if (kind === 'gdf') {
      parseGdf(buffer); // always throws in Phase 1 (adapter required)
      return;
    }
    const rec = parseEdf(buffer);
    const summary: ParseSummary = {
      ok: true,
      format: rec.format,
      channels: rec.channels.length,
      sampleRateHz: rec.sampleRateHz,
      nSamples: rec.nSamples,
      annotationCount: rec.annotations.length,
      firstChannels: rec.channels.slice(0, 8),
      firstAnnotations: rec.annotations.slice(0, 5),
      notes: rec.notes,
    };
    self.postMessage(summary);
  } catch (err) {
    const summary: ParseSummary = {
      ok: false,
      format: kind === 'gdf' ? 'gdf-unsupported' : 'unknown',
      channels: 0,
      sampleRateHz: 0,
      nSamples: 0,
      annotationCount: 0,
      firstChannels: [],
      firstAnnotations: [],
      notes: err instanceof GdfUnsupportedError && err.sniff ? [`GDF version: ${err.sniff.version}`] : [],
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(summary);
  }
};

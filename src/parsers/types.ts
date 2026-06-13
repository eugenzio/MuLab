/**
 * Canonical in-memory shape that every dataset parser must produce.
 *
 * Both the EDF/EDF+ parser and the GDF parser (or its Python-preconvert adapter
 * fallback) normalize into this single contract so downstream pipeline stages
 * (Phase 3+) never care which raw format the data came from.
 */
export interface EegAnnotation {
  onsetSec: number;
  durationSec: number;
  /** Raw event label/code as found in the file (e.g. EEGMMIDB "T0"/"T1"/"T2"). */
  label: string;
}

export type EegFormat = 'EDF' | 'EDF+C' | 'EDF+D' | 'GDF' | 'unknown';

export interface EegRecording {
  /** Channel labels in acquisition order. */
  channels: string[];
  /** Sampling rate in Hz. Assumes a single uniform rate across signal channels. */
  sampleRateHz: number;
  /** One Float64Array per channel, length === nSamples. */
  signals: Float64Array[];
  /** Number of samples per channel. */
  nSamples: number;
  /** Events/markers. Empty array if none could be extracted (see `notes`). */
  annotations: EegAnnotation[];
  /** Detected container format. */
  format: EegFormat;
  /**
   * Free-text caveats discovered while parsing — e.g. "annotation track not
   * exposed by edfdecoder (needs verification)". Surfaced to the UI/report so no
   * capability is silently assumed.
   */
  notes: string[];
}

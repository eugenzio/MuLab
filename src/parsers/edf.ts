/**
 * EDF / EDF+ parser.
 *
 * Wraps the pure-JS `edfdecoder` package (works in Node and browser) and
 * normalizes into the {@link EegRecording} contract.
 *
 * Findings from the Phase 1 spike (PhysioNet EEGMMIDB S001):
 *  - edfdecoder cleanly decodes the header and physical signals.
 *  - The file is EDF+C with a trailing "EDF Annotations" channel.
 *  - edfdecoder does NOT decode the EDF+ annotation (TAL) track — it exposes that
 *    channel only as raw int16 samples. We therefore reconstruct the TAL bytes
 *    from those int16 values (little-endian) and parse them ourselves below.
 *    This recovers the T0/T1/T2 motor-imagery event markers.
 */
import { EdfDecoder } from 'edfdecoder';
import type { EegAnnotation, EegFormat, EegRecording } from './types.ts';

const ANNOTATION_LABEL = 'EDF Annotations';

// EDF+ Time-stamped Annotation List (TAL) byte separators.
const TAL_END = 0x00; // ends one TAL within a record's annotation signal
const TAL_DURATION_SEP = 0x15; // separates onset from duration (decimal 21)
const TAL_FIELD_SEP = 0x14; // separates onset/duration block and annotation texts (decimal 20)

/** Classify the container from the EDF header's reserved field. */
function classifyFormat(reserved: string): EegFormat {
  const r = reserved.trimEnd();
  if (r.startsWith('EDF+C')) return 'EDF+C';
  if (r.startsWith('EDF+D')) return 'EDF+D';
  // Plain EDF leaves the reserved field blank.
  return 'EDF';
}

/**
 * Reassemble the annotation channel's raw int16 samples (per record) into the
 * original little-endian byte stream and parse all non-timekeeping TALs.
 */
function parseAnnotations(
  edf: EdfOutput,
  annotationChannel: number,
  nRecords: number,
): EegAnnotation[] {
  const annotations: EegAnnotation[] = [];

  for (let rec = 0; rec < nRecords; rec++) {
    const int16 = edf.getRawSignal(annotationChannel, rec);
    if (!int16) continue;
    const bytes = new Uint8Array(int16.length * 2);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < int16.length; i++) dv.setInt16(i * 2, int16[i] ?? 0, true);

    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== TAL_END) continue;
      if (i > start) parseTal(bytes.subarray(start, i), annotations);
      start = i + 1;
    }
  }
  return annotations;
}

/** Parse a single TAL chunk (without its trailing 0x00) and append real events. */
function parseTal(chunk: Uint8Array, out: EegAnnotation[]): void {
  // Split chunk on the field separator 0x14.
  const fields: Uint8Array[] = [];
  let s = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] === TAL_FIELD_SEP) {
      fields.push(chunk.subarray(s, i));
      s = i + 1;
    }
  }
  if (s < chunk.length) fields.push(chunk.subarray(s));
  if (fields.length === 0) return;

  // First field is "onset" or "onset\x15duration".
  const timing = fields[0]!;
  let onsetBytes = timing;
  let durationBytes: Uint8Array | null = null;
  for (let i = 0; i < timing.length; i++) {
    if (timing[i] === TAL_DURATION_SEP) {
      onsetBytes = timing.subarray(0, i);
      durationBytes = timing.subarray(i + 1);
      break;
    }
  }
  const onsetSec = Number(latin1(onsetBytes));
  const durationSec = durationBytes ? Number(latin1(durationBytes)) : 0;
  if (!Number.isFinite(onsetSec)) return;

  // Remaining fields are annotation texts; empty ones are the per-record
  // timekeeping TAL and carry no event.
  for (let i = 1; i < fields.length; i++) {
    const label = latin1(fields[i]!).trim();
    if (label.length > 0) {
      out.push({ onsetSec, durationSec: Number.isFinite(durationSec) ? durationSec : 0, label });
    }
  }
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** Minimal structural type for the edfdecoder output object we rely on. */
interface EdfOutput {
  getReservedField(): string;
  getNumberOfSignals(): number;
  getNumberOfRecords(): number;
  getRecordDuration(): number;
  getSignalLabel(i: number): string;
  getSignalSamplingFrequency(i: number): number;
  getPhysicalSignalConcatRecords(i: number, recStart: number, recEnd: number): Float32Array;
  getRawSignal(i: number, rec: number): Int16Array | null;
}

/**
 * Parse an EDF/EDF+ ArrayBuffer into an {@link EegRecording}.
 * The "EDF Annotations" channel is excluded from `signals` and decoded into
 * `annotations` instead.
 */
export function parseEdf(buffer: ArrayBuffer): EegRecording {
  const decoder = new EdfDecoder();
  decoder.setInput(buffer);
  decoder.decode();
  const edf = decoder.getOutput() as unknown as EdfOutput;

  const notes: string[] = [];
  const format = classifyFormat(edf.getReservedField());
  const nSignals = edf.getNumberOfSignals();
  const nRecords = edf.getNumberOfRecords();

  const channels: string[] = [];
  const signals: Float64Array[] = [];
  let sampleRateHz = 0;
  let annotationChannel = -1;

  for (let i = 0; i < nSignals; i++) {
    const label = edf.getSignalLabel(i).trim();
    if (label === ANNOTATION_LABEL) {
      annotationChannel = i;
      continue;
    }
    const f32 = edf.getPhysicalSignalConcatRecords(i, 0, nRecords);
    // Contract uses Float64 for downstream numerical stability; convert once.
    signals.push(Float64Array.from(f32));
    channels.push(label);
    const fs = edf.getSignalSamplingFrequency(i);
    if (sampleRateHz === 0) sampleRateHz = fs;
    else if (fs !== sampleRateHz) {
      notes.push(
        `Mixed sampling rates detected (channel "${label}" = ${fs} Hz vs ${sampleRateHz} Hz). ` +
          `Downstream stages assume a uniform rate — NEEDS VERIFICATION for this dataset.`,
      );
    }
  }

  const annotations =
    annotationChannel >= 0 ? parseAnnotations(edf, annotationChannel, nRecords) : [];

  if (annotationChannel >= 0 && annotations.length === 0) {
    notes.push('Annotation channel present but no TAL events were decoded — NEEDS VERIFICATION.');
  }
  if (annotationChannel < 0 && (format === 'EDF+C' || format === 'EDF+D')) {
    notes.push('EDF+ header but no "EDF Annotations" channel found.');
  }

  const nSamples = signals[0]?.length ?? 0;

  return { channels, sampleRateHz, signals, nSamples, annotations, format, notes };
}

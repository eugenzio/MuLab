/**
 * Shared test helper: parse + concatenate the EEGMMIDB runs the oracle used, and load
 * the Phase 2 fixtures. Mirrors the oracle's concatenation order (R04, R08, R12).
 */
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEdf } from '../../src/parsers/edf.ts';
import type { EegAnnotation } from '../../src/parsers/types.ts';
import { concatRecordings } from '../../src/pipeline/recording.ts';
import { readFixtures, type Fixtures } from '../../src/validation/fixtures.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..');
const RAW = resolve(REPO_ROOT, 'data', 'raw');
const FIXTURES = resolve(REPO_ROOT, 'tests', 'fixtures');
const IMAGERY_RUNS = ['R04', 'R08', 'R12'];

const subjectRuns = (subject: string): string[] => IMAGERY_RUNS.map((r) => `${subject}${r}.edf`);
const subjectDir = (subject: string): string => resolve(FIXTURES, subject);

/** True if a subject has both its raw EDFs and its generated fixtures. */
export function hasSubject(subject: string): boolean {
  return (
    subjectRuns(subject).every((r) => existsSync(resolve(RAW, r))) &&
    existsSync(resolve(subjectDir(subject), 'params.json'))
  );
}

/** Subjects the oracle validated (from subjects.json), filtered to those with data present. */
export function availableSubjects(): string[] {
  const manifest = resolve(FIXTURES, 'subjects.json');
  if (!existsSync(manifest)) return [];
  const validated: string[] = JSON.parse(readFileSync(manifest, 'utf8')).validated ?? [];
  return validated.filter(hasSubject);
}

/** Backward-compatible: the Phase 3 single-subject stage tests use S001. */
export const HAS_DATA = hasSubject('S001');

export interface ConcatRecording {
  channels: string[];
  /** Concatenated continuous signal, one Float64Array per channel (µV). */
  signals: Float64Array[];
  sampleRateHz: number;
  /** Per-run sample lengths, for deriving concatenated event positions. */
  runLengths: number[];
  /** Per-run annotations (onsets relative to that run). */
  runAnnotations: EegAnnotation[][];
}

async function bufferOf(name: string): Promise<ArrayBuffer> {
  const b = await readFile(resolve(RAW, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** Parse a subject's R04/R08/R12 and concatenate per channel (edfdecoder returns µV). */
export async function loadConcatenated(subject = 'S001'): Promise<ConcatRecording> {
  const recs = [];
  for (const r of subjectRuns(subject)) recs.push(parseEdf(await bufferOf(r)));
  const { channels, signals, sampleRateHz, runLengths } = concatRecordings(recs);
  return { channels, signals, sampleRateHz, runLengths, runAnnotations: recs.map((r) => r.annotations) };
}

export async function loadFixtures(subject = 'S001'): Promise<Fixtures> {
  return readFixtures(subjectDir(subject));
}

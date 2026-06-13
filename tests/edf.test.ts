import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseEdf } from '../src/parsers/edf.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = resolve(__dirname, '..', 'data', 'raw');
const EDF_FILE = resolve(RAW, 'S001R04.edf'); // EEGMMIDB motor-imagery run

async function loadBuffer(path: string): Promise<ArrayBuffer> {
  const buf = await readFile(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// Tests require the sample data. Run `npm run fetch-data` first.
const describeIfData = existsSync(EDF_FILE) ? describe : describe.skip;

describeIfData('parseEdf — PhysioNet EEGMMIDB S001R04 (EDF+C)', () => {
  it('classifies the container as EDF+C', async () => {
    const rec = parseEdf(await loadBuffer(EDF_FILE));
    expect(rec.format).toBe('EDF+C');
  });

  it('extracts 64 EEG channels at 160 Hz (annotation channel excluded)', async () => {
    const rec = parseEdf(await loadBuffer(EDF_FILE));
    expect(rec.channels.length).toBe(64);
    expect(rec.sampleRateHz).toBe(160);
    expect(rec.channels).not.toContain('EDF Annotations');
    // Known EEGMMIDB montage starts at Fc5 and ends at Iz.
    expect(rec.channels[0]).toBe('Fc5.');
    expect(rec.channels.at(-1)).toBe('Iz..');
  });

  it('produces Float64 signals with consistent length = nSamples', async () => {
    const rec = parseEdf(await loadBuffer(EDF_FILE));
    expect(rec.signals.length).toBe(64);
    expect(rec.nSamples).toBe(125 * 160); // 125 records × 160 samples/record = 20000
    for (const sig of rec.signals) {
      expect(sig).toBeInstanceOf(Float64Array);
      expect(sig.length).toBe(rec.nSamples);
    }
  });

  it('decodes EDF+ TAL annotations into T0/T1/T2 events', async () => {
    const rec = parseEdf(await loadBuffer(EDF_FILE));
    expect(rec.annotations.length).toBeGreaterThan(0);
    const labels = new Set(rec.annotations.map((a) => a.label));
    // EEGMMIDB uses T0 (rest) and T1/T2 (the two imagery conditions).
    expect(labels.has('T0')).toBe(true);
    expect([...labels].every((l) => /^T[012]$/.test(l))).toBe(true);
    // First event is at onset 0 with a positive duration.
    expect(rec.annotations[0]!.onsetSec).toBe(0);
    expect(rec.annotations[0]!.durationSec).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from 'vitest';
import { sniffGdfHeader, parseGdf, GdfUnsupportedError } from '../src/parsers/gdf.ts';

/**
 * We have no real BCI IV-2a GDF file (registration-gated; open mirrors 404'd in
 * the spike — see data/raw/manifest.json blockers). These tests synthesize a
 * minimal GDF 2.0 fixed header to exercise the sniffer and lock in the Phase 1
 * verdict: direct in-browser GDF decode is unsupported -> adapter required.
 */
function makeGdfHeader(opts: {
  version?: string;
  numChannels: number;
  numRecords: number;
  durNum: number;
  durDen: number;
}): ArrayBuffer {
  const buf = new ArrayBuffer(256);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const version = (opts.version ?? 'GDF 2.20').padEnd(8, ' ');
  for (let i = 0; i < 8; i++) u8[i] = version.charCodeAt(i);
  dv.setBigInt64(236, BigInt(opts.numRecords), true);
  dv.setUint32(244, opts.durNum, true);
  dv.setUint32(248, opts.durDen, true);
  dv.setUint16(252, opts.numChannels, true);
  return buf;
}

describe('sniffGdfHeader', () => {
  it('reads version, channel count and record geometry from a GDF 2.0 header', () => {
    // BCI IV-2a A0xT: 25 channels (22 EEG + 3 EOG), 250 Hz.
    const buf = makeGdfHeader({ numChannels: 25, numRecords: 1000, durNum: 1, durDen: 250 });
    const sniff = sniffGdfHeader(buf);
    expect(sniff.isGdf).toBe(true);
    expect(sniff.version).toBe('GDF 2.20');
    expect(sniff.numChannels).toBe(25);
    expect(sniff.numRecords).toBe(1000);
    expect(sniff.recordDurationSec).toBeCloseTo(1 / 250);
  });

  it('flags non-GDF buffers', () => {
    const sniff = sniffGdfHeader(new ArrayBuffer(256));
    expect(sniff.isGdf).toBe(false);
  });
});

describe('parseGdf — Phase 1 verdict: adapter required', () => {
  it('throws GdfUnsupportedError with the sniffed header for a real GDF', () => {
    const buf = makeGdfHeader({ numChannels: 25, numRecords: 1000, durNum: 1, durDen: 250 });
    expect(() => parseGdf(buf)).toThrow(GdfUnsupportedError);
    try {
      parseGdf(buf);
    } catch (err) {
      expect(err).toBeInstanceOf(GdfUnsupportedError);
      const e = err as GdfUnsupportedError;
      expect(e.adapterRequired).toBe(true);
      expect(e.sniff?.numChannels).toBe(25);
      expect(e.message).toMatch(/adapter|pre-convert|mne/i);
    }
  });

  it('throws a clear non-GDF error for unrelated buffers', () => {
    expect(() => parseGdf(new ArrayBuffer(256))).toThrow(/Not a GDF file/);
  });
});

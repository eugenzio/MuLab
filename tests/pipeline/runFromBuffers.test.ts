import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { runFromBuffers, type PipelineConfig } from '../../src/pipeline/runFromBuffers.ts';
import { frobeniusNormDiff } from '../../src/validation/metrics.ts';
import { CSP_FROBENIUS_MAX } from '../../src/validation/tolerances.ts';
import { loadFixtures } from './_data.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = resolve(__dirname, '..', '..', 'data', 'raw');
const RUNS = ['S001R04.edf', 'S001R08.edf', 'S001R12.edf'];
const HAS = RUNS.every((r) => existsSync(resolve(RAW, r))) &&
  existsSync(resolve(__dirname, '..', 'fixtures', 'S001', 'params.json'));

const d = HAS ? describe : describe.skip;

async function bufOf(name: string): Promise<ArrayBuffer> {
  const b = await readFile(resolve(RAW, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

d('runFromBuffers — browser entry path == oracle (S001)', () => {
  it('parses raw EDFs, runs the pipeline, and reproduces the oracle with bundled folds', async () => {
    const f = await loadFixtures('S001');
    const config: PipelineConfig = {
      taps: f.params.filter.taps,
      startOffset: f.epochs.start_offset_samples,
      nTimes: f.params.epoch.n_times,
      nComponents: f.params.csp.n_components,
      reg: f.params.csp.reg,
      shrinkage: f.params.lda.shrinkage,
    };
    const buffers = await Promise.all(RUNS.map(bufOf));

    const stages: string[] = [];
    const result = await runFromBuffers(buffers, config, f.foldIndices.folds, (s) => stages.push(s));

    expect(result.usedProvidedFolds).toBe(true);
    expect(result.nEpochs).toBe(f.params.n_epochs);
    expect(result.nChannels).toBe(64);
    expect(result.meanAcc).toBeCloseTo(f.cvAccuracy.mean, 10); // 0.8667
    expect(frobeniusNormDiff(f.cspFilters.full, result.cspFilters)).toBeLessThan(CSP_FROBENIUS_MAX);
    expect(stages).toContain('filter');
  });

  it('falls back to a local stratified split when no folds are provided', async () => {
    const f = await loadFixtures('S001');
    const config: PipelineConfig = {
      taps: f.params.filter.taps,
      startOffset: f.epochs.start_offset_samples,
      nTimes: f.params.epoch.n_times,
      nComponents: f.params.csp.n_components,
      reg: f.params.csp.reg,
      shrinkage: f.params.lda.shrinkage,
    };
    const buffers = await Promise.all(RUNS.map(bufOf));
    const result = await runFromBuffers(buffers, config, null);
    expect(result.usedProvidedFolds).toBe(false);
    expect(result.perFoldAcc.length).toBe(5);
    expect(result.meanAcc).toBeGreaterThanOrEqual(0);
    expect(result.meanAcc).toBeLessThanOrEqual(1);
  });
});

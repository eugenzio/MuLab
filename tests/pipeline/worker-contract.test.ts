import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { PipelineWorkerMessage, PipelineWorkerRequest } from '../../src/workers/pipeline.worker.ts';
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

d('pipeline.worker message contract', () => {
  it('handles a "run" request: emits progress then a result with the oracle accuracy', async () => {
    // Shim the worker global `self` before importing the worker module.
    const messages: PipelineWorkerMessage[] = [];
    type WorkerSelf = { onmessage: ((e: { data: PipelineWorkerRequest }) => Promise<void>) | null; postMessage: (m: PipelineWorkerMessage) => void };
    const fakeSelf: WorkerSelf = { onmessage: null, postMessage: (m) => messages.push(m) };
    (globalThis as unknown as { self: WorkerSelf }).self = fakeSelf;

    await import('../../src/workers/pipeline.worker.ts');
    expect(typeof fakeSelf.onmessage).toBe('function');

    const f = await loadFixtures('S001');
    const req: PipelineWorkerRequest = {
      type: 'run',
      buffers: await Promise.all(RUNS.map(bufOf)),
      config: {
        taps: f.params.filter.taps,
        startOffset: f.epochs.start_offset_samples,
        nTimes: f.params.epoch.n_times,
        nComponents: f.params.csp.n_components,
        reg: f.params.csp.reg,
        shrinkage: f.params.lda.shrinkage,
      },
      folds: f.foldIndices.folds,
    };
    await fakeSelf.onmessage!({ data: req });

    expect(messages.some((m) => m.type === 'progress')).toBe(true);
    const result = messages.find((m) => m.type === 'result');
    expect(result).toBeDefined();
    if (result && result.type === 'result') {
      expect(result.result.meanAcc).toBeCloseTo(f.cvAccuracy.mean, 10);
    }
    expect(messages.some((m) => m.type === 'error')).toBe(false);
  });
});

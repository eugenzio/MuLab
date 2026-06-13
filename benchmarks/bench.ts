/**
 * Benchmark harness page logic. Exposes window.__benchTiming / __benchMemory which Playwright
 * (scripts/benchmark.mjs) calls. Timing runs the REAL app worker (src/workers/pipeline.worker.ts);
 * memory runs the identical runFromBuffers on the main thread so performance.memory sees the
 * pipeline's allocations. EDFs are supplied via the hidden file input (Playwright setInputFiles).
 */
import type { PipelineConfig } from '../src/pipeline/runFromBuffers.ts';
import { runFromBuffers } from '../src/pipeline/runFromBuffers.ts';
import type { Fold } from '../src/pipeline/stratifiedKFold.ts';
import type { PipelineWorkerRequest, PipelineWorkerMessage } from '../src/workers/pipeline.worker.ts';

interface ParamsJson {
  filter: { taps: number[] };
  epoch: { start_offset_samples: number; n_times: number };
  csp: { n_components: number; reg: number };
  lda: { shrinkage: number };
}
const paramsGlob = import.meta.glob('../tests/fixtures/*/params.json', { eager: true, import: 'default' });
const foldsGlob = import.meta.glob('../tests/fixtures/*/fold_indices.json', { eager: true, import: 'default' });
const subjectOf = (p: string): string => /fixtures\/([^/]+)\//.exec(p)?.[1] ?? p;

const CONFIG = new Map<string, PipelineConfig>();
const FOLDS = new Map<string, Fold[]>();
for (const [path, mod] of Object.entries(paramsGlob)) {
  const p = mod as ParamsJson;
  CONFIG.set(subjectOf(path), {
    taps: p.filter.taps,
    startOffset: p.epoch.start_offset_samples,
    nTimes: p.epoch.n_times,
    nComponents: p.csp.n_components,
    reg: p.csp.reg,
    shrinkage: p.lda.shrinkage,
  });
}
for (const [path, mod] of Object.entries(foldsGlob)) FOLDS.set(subjectOf(path), (mod as { folds: Fold[] }).folds);
const DEFAULT_CONFIG = [...CONFIG.values()][0]!;

const STAGES = ['parse', 'filter', 'epoch', 'csp+lda', 'cv'] as const;
type StageMs = Record<(typeof STAGES)[number], number>;
export interface RepTiming { totalMs: number; stageMs: StageMs; meanAcc: number }

async function readInput(): Promise<{ subject: string; buffers: ArrayBuffer[] }> {
  const input = document.getElementById('edf') as HTMLInputElement;
  const files = [...(input.files ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (files.length !== 3) throw new Error(`expected 3 EDF files, got ${files.length}`);
  const subject = /^(S\d{3})/.exec(files[0]!.name)?.[1] ?? '';
  const buffers = await Promise.all(files.map((f) => f.arrayBuffer()));
  return { subject, buffers };
}

const perfMemory = (): number | null =>
  (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
const heapLimit = (): number | null =>
  (performance as unknown as { memory?: { jsHeapSizeLimit: number } }).memory?.jsHeapSizeLimit ?? null;

function runViaWorker(worker: Worker, buffers: ArrayBuffer[], config: PipelineConfig, folds: Fold[] | null): Promise<RepTiming> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const firstSeen: Partial<Record<string, number>> = {};
    worker.onmessage = (e: MessageEvent<PipelineWorkerMessage>) => {
      const m = e.data;
      if (m.type === 'progress') {
        if (firstSeen[m.stage] === undefined) firstSeen[m.stage] = performance.now();
      } else if (m.type === 'result') {
        resolve(deriveStages(t0, firstSeen, performance.now(), m.result.meanAcc));
      } else {
        reject(new Error(m.error));
      }
    };
    const copies = buffers.map((b) => b.slice(0));
    const req: PipelineWorkerRequest = { type: 'run', buffers: copies, config, folds };
    worker.postMessage(req, copies);
  });
}

function deriveStages(t0: number, firstSeen: Partial<Record<string, number>>, tEnd: number, meanAcc: number): RepTiming {
  const at = (s: string): number => firstSeen[s] ?? tEnd;
  return {
    totalMs: tEnd - t0,
    stageMs: {
      parse: at('filter') - t0,
      filter: at('epoch') - at('filter'),
      epoch: at('csp+lda') - at('epoch'),
      'csp+lda': at('cv') - at('csp+lda'),
      cv: tEnd - at('cv'),
    },
    meanAcc,
  };
}

declare global {
  interface Window {
    __benchTiming(reps: number): Promise<{ subject: string; reps: RepTiming[] }>;
    __benchTimingMain(reps: number): Promise<{ subject: string; reps: RepTiming[] }>;
    __benchMemory(): Promise<{
      available: boolean;
      baseMB?: number;
      peakMB?: number;
      deltaMB?: number;
      heapLimitMB?: number;
      meanAcc?: number;
    }>;
  }
}

window.__benchTiming = async (reps: number) => {
  const { subject, buffers } = await readInput();
  const config = CONFIG.get(subject) ?? DEFAULT_CONFIG;
  const folds = FOLDS.get(subject) ?? null;
  const worker = new Worker(new URL('../src/workers/pipeline.worker.ts', import.meta.url), { type: 'module' });
  try {
    const out: RepTiming[] = [];
    for (let i = 0; i < reps; i++) out.push(await runViaWorker(worker, buffers, config, folds));
    return { subject, reps: out };
  } finally {
    worker.terminate();
  }
};

// Identical pipeline on the MAIN THREAD. CDP CPU throttling reaches the main thread (it does NOT
// reach dedicated Web Workers), so this path is the valid CPU-slowdown proxy for low-spec.
window.__benchTimingMain = async (reps: number) => {
  const { subject, buffers } = await readInput();
  const config = CONFIG.get(subject) ?? DEFAULT_CONFIG;
  const folds = FOLDS.get(subject) ?? null;
  const out: RepTiming[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    const firstSeen: Partial<Record<string, number>> = {};
    const result = await runFromBuffers(buffers.map((b) => b.slice(0)), config, folds, (stage) => {
      if (firstSeen[stage] === undefined) firstSeen[stage] = performance.now();
    });
    out.push(deriveStages(t0, firstSeen, performance.now(), result.meanAcc));
  }
  return { subject, reps: out };
};

window.__benchMemory = async () => {
  const { subject, buffers } = await readInput();
  const config = CONFIG.get(subject) ?? DEFAULT_CONFIG;
  const folds = FOLDS.get(subject) ?? null;
  if (perfMemory() === null) return { available: false };

  (globalThis as unknown as { gc?: () => void }).gc?.(); // cleaner baseline when --expose-gc is set
  const base = perfMemory()!;
  let peak = base;
  const sample = (): void => {
    const m = perfMemory();
    if (m !== null && m > peak) peak = m;
  };
  const result = await runFromBuffers(buffers.map((b) => b.slice(0)), config, folds, sample);
  sample();
  const MB = 1048576;
  return {
    available: true,
    baseMB: base / MB,
    peakMB: peak / MB,
    deltaMB: (peak - base) / MB,
    heapLimitMB: (heapLimit() ?? 0) / MB,
    meanAcc: result.meanAcc,
  };
};

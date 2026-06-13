/// <reference lib="webworker" />
/**
 * Pipeline worker — runs the full pipeline off the main thread. Two request shapes:
 *  - 'run'  : raw EDF ArrayBuffers + config + folds → parse + concat + events + pipeline.
 *  - 'input': a pre-built PipelineInput (kept for back-compat / direct tests).
 * Posts progress events then a single result (or error). Heavy compute never touches main.
 */
import { runPipeline, type PipelineInput, type PipelineResult } from '../pipeline/runPipeline.ts';
import { runFromBuffers, type PipelineConfig, type RunFromBuffersResult } from '../pipeline/runFromBuffers.ts';
import type { Fold } from '../pipeline/stratifiedKFold.ts';

export type PipelineWorkerRequest =
  | { type: 'run'; buffers: ArrayBuffer[]; config: PipelineConfig; folds: Fold[] | null }
  | { type: 'input'; input: PipelineInput };

export type PipelineWorkerMessage =
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'result'; result: PipelineResult | RunFromBuffersResult }
  | { type: 'error'; error: string };

const post = (m: PipelineWorkerMessage) => self.postMessage(m);
const onProgress = (stage: string, fraction: number) => post({ type: 'progress', stage, fraction });

self.onmessage = async (e: MessageEvent<PipelineWorkerRequest>) => {
  try {
    const req = e.data;
    const result =
      req.type === 'run'
        ? await runFromBuffers(req.buffers, req.config, req.folds, onProgress)
        : await runPipeline(req.input, onProgress);
    post({ type: 'result', result });
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};

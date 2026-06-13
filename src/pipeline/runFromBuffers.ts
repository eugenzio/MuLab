/**
 * Browser entry point: raw EDF ArrayBuffers → full pipeline result.
 *
 * Runs inside the Web Worker so the main thread stays free. Parses each EDF with the
 * Phase-1 `parseEdf`, concatenates, derives T1/T2 events (the Phase-3-validated path),
 * then calls the unchanged `runPipeline`. Folds come from the caller (the subject's
 * MNE-seeded `fold_indices.json` when known) or a documented local stratified fallback.
 */
import { parseEdf } from '../parsers/edf.ts';
import { concatRecordings, concatEvents } from './recording.ts';
import { stratifiedKFold, type Fold } from './stratifiedKFold.ts';
import { runPipeline, type PipelineResult, type ProgressFn } from './runPipeline.ts';

/** Subject-independent pipeline configuration (read from a bundled params.json). */
export interface PipelineConfig {
  taps: number[];
  startOffset: number;
  nTimes: number;
  nComponents: number;
  reg: number;
  shrinkage: number;
}

export interface RunFromBuffersResult extends PipelineResult {
  nChannels: number;
  labels: number[];
  /** True if the caller supplied MNE-seeded folds; false if the local fallback split was used. */
  usedProvidedFolds: boolean;
}

export async function runFromBuffers(
  buffers: ArrayBuffer[],
  config: PipelineConfig,
  folds: Fold[] | null,
  onProgress: ProgressFn = () => {},
): Promise<RunFromBuffersResult> {
  if (buffers.length === 0) throw new Error('runFromBuffers: no EDF buffers provided');

  const recs = buffers.map((b) => parseEdf(b));
  const { channels, signals, sampleRateHz } = concatRecordings(recs);
  const { eventSamples, labels } = concatEvents(recs, sampleRateHz);
  if (labels.length === 0) throw new Error('No T1/T2 events found in the provided EDF files.');
  onProgress('parse', 1); // marks end of EDF parse + concat + event extraction (not pipeline math)

  const usedProvidedFolds = folds !== null && folds.length > 0;
  const useFolds = usedProvidedFolds ? folds! : stratifiedKFold(labels);

  const result = await runPipeline(
    {
      signals,
      taps: config.taps,
      startOffset: config.startOffset,
      nTimes: config.nTimes,
      eventSamples,
      labels,
      nComponents: config.nComponents,
      reg: config.reg,
      shrinkage: config.shrinkage,
      folds: useFolds,
    },
    onProgress,
  );

  return { ...result, nChannels: channels.length, labels, usedProvidedFolds };
}

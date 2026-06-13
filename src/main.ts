/**
 * Minimal no-install UI: pick a subject's EDF runs → run the full pipeline in the Web Worker
 * → show live progress, CV accuracy, runtime, and a CSP spatial-filter summary. No backend.
 *
 * Heavy work (EDF parse + filter + CSP + LDA + CV) runs in pipeline.worker.ts. The small
 * per-subject params/fold fixtures are bundled (params are the source of truth, not hardcoded);
 * the heavy EDFs are user-provided via the file-picker (or an optional bundled sample).
 */
import type { PipelineConfig } from './pipeline/runFromBuffers.ts';
import type { PipelineResult } from './pipeline/runPipeline.ts';
import type { Fold } from './pipeline/stratifiedKFold.ts';
import type {
  PipelineWorkerRequest,
  PipelineWorkerMessage,
} from './workers/pipeline.worker.ts';

// --- bundled fixtures (params = source of truth; small) ---------------------------- //
const paramsGlob = import.meta.glob('../tests/fixtures/*/params.json', { eager: true, import: 'default' });
const foldsGlob = import.meta.glob('../tests/fixtures/*/fold_indices.json', { eager: true, import: 'default' });

interface ParamsJson {
  filter: { taps: number[] };
  epoch: { start_offset_samples: number; n_times: number };
  csp: { n_components: number; reg: number };
  lda: { shrinkage: number };
}
const subjectOf = (path: string): string => /fixtures\/([^/]+)\//.exec(path)?.[1] ?? path;

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
for (const [path, mod] of Object.entries(foldsGlob)) {
  FOLDS.set(subjectOf(path), (mod as { folds: Fold[] }).folds);
}
const SUBJECTS = [...CONFIG.keys()].sort();
/** Any subject's config works as the default (taps/CSP/LDA are subject-independent). */
const DEFAULT_CONFIG = CONFIG.get(SUBJECTS[0] ?? '') ?? null;

// --- DOM ---------------------------------------------------------------------------- //
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const subjectSel = $<HTMLSelectElement>('subject');
const filesInput = $<HTMLInputElement>('files');
const runBtn = $<HTMLButtonElement>('run');
const sampleBtn = $<HTMLButtonElement>('sample');
const hint = $<HTMLParagraphElement>('hint');
const errorEl = $<HTMLParagraphElement>('error');
const progressCard = $<HTMLDivElement>('progressCard');
const stageEl = $<HTMLDivElement>('stage');
const bar = $<HTMLProgressElement>('bar');
const results = $<HTMLDivElement>('results');

for (const s of SUBJECTS) {
  const opt = document.createElement('option');
  opt.value = s;
  opt.textContent = s;
  subjectSel.append(opt);
}
hint.textContent = SUBJECTS.length
  ? `Pick a subject's three imagery EDFs (e.g. ${SUBJECTS[0]}R04.edf, R08, R12) from your data/raw folder.`
  : 'No bundled subject fixtures found — pick any subject’s 3 EDFs (a local CV split will be used).';

let pickedBuffers: ArrayBuffer[] = [];
let pickedSubject = '';

function setError(msg: string): void {
  errorEl.textContent = msg;
}

filesInput.addEventListener('change', async () => {
  setError('');
  pickedBuffers = [];
  runBtn.disabled = true;
  const files = [...(filesInput.files ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (files.length !== 3) {
    setError(`Select exactly 3 EDF files (R04, R08, R12); you selected ${files.length}.`);
    return;
  }
  if (!files.every((f) => f.name.toLowerCase().endsWith('.edf'))) {
    setError('All three files must be .edf.');
    return;
  }
  pickedSubject = /^(S\d{3})/.exec(files[0]!.name)?.[1] ?? '';
  if (pickedSubject) subjectSel.value = SUBJECTS.includes(pickedSubject) ? pickedSubject : subjectSel.value;
  pickedBuffers = await Promise.all(files.map((f) => f.arrayBuffer()));
  runBtn.disabled = false;
  hint.textContent = `Loaded ${files.map((f) => f.name).join(', ')}.`;
});

runBtn.addEventListener('click', () => runPipeline(pickedBuffers, pickedSubject || subjectSel.value));

// Optional one-click bundled sample (populated by `npm run prep-sample`).
void (async () => {
  try {
    const res = await fetch('/sample/manifest.json');
    if (!res.ok) return;
    const manifest = (await res.json()) as { subject: string; files: string[] };
    sampleBtn.classList.remove('hidden');
    sampleBtn.textContent = `Run bundled ${manifest.subject} sample`;
    sampleBtn.addEventListener('click', async () => {
      setError('');
      try {
        const buffers = await Promise.all(
          manifest.files.map((f) => fetch(`/sample/${f}`).then((r) => r.arrayBuffer())),
        );
        await runPipeline(buffers, manifest.subject);
      } catch (err) {
        setError(`Sample load failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  } catch {
    /* no bundled sample — file-picker only */
  }
})();

// --- run via the worker ------------------------------------------------------------- //
function runPipeline(buffers: ArrayBuffer[], subject: string): void {
  if (buffers.length !== 3) {
    setError('Need 3 EDF buffers to run.');
    return;
  }
  const config = CONFIG.get(subject) ?? DEFAULT_CONFIG;
  if (!config) {
    setError('No pipeline params available (missing bundled fixtures).');
    return;
  }
  const folds = FOLDS.get(subject) ?? null;

  setError('');
  results.classList.add('hidden');
  progressCard.classList.remove('hidden');
  bar.value = 0;
  stageEl.textContent = 'Starting…';
  runBtn.disabled = true;
  const t0 = performance.now();

  const worker = new Worker(new URL('./workers/pipeline.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<PipelineWorkerMessage>) => {
    const msg = e.data;
    if (msg.type === 'progress') {
      stageEl.textContent = `${msg.stage}… ${(msg.fraction * 100).toFixed(0)}%`;
      bar.value = msg.fraction;
    } else if (msg.type === 'result') {
      const runtime = performance.now() - t0;
      renderResult(msg.result, subject, folds !== null, runtime);
      worker.terminate();
      runBtn.disabled = false;
    } else {
      setError(`Pipeline error: ${msg.error}`);
      progressCard.classList.add('hidden');
      worker.terminate();
      runBtn.disabled = false;
    }
  };
  worker.onerror = (e) => {
    setError(`Worker error: ${e.message}`);
    progressCard.classList.add('hidden');
    runBtn.disabled = false;
  };

  // Copy buffers before transfer so a re-run with the same picked files still works.
  const copies = buffers.map((b) => b.slice(0));
  const req: PipelineWorkerRequest = { type: 'run', buffers: copies, config, folds };
  worker.postMessage(req, copies);
}

// --- rendering ---------------------------------------------------------------------- //
function renderResult(
  result: PipelineResult,
  subject: string,
  usedProvidedFolds: boolean,
  runtimeMs: number,
): void {
  progressCard.classList.add('hidden');
  results.classList.remove('hidden');
  bar.value = 1;

  $('meanAcc').textContent = `${(result.meanAcc * 100).toFixed(1)}%`;
  $('runtime').textContent = `${runtimeMs.toFixed(0)} ms in worker`;
  $('foldNote').textContent = usedProvidedFolds
    ? `${subject}: MNE-seeded folds (== oracle)`
    : 'local CV split (not MNE-seeded)';

  const folds = $<HTMLTableElement>('folds');
  folds.innerHTML =
    '<tr><th>fold</th>' +
    result.perFoldAcc.map((_, i) => `<th>${i + 1}</th>`).join('') +
    '</tr><tr><td>acc</td>' +
    result.perFoldAcc.map((a) => `<td>${(a * 100).toFixed(1)}%</td>`).join('') +
    '</tr>';

  // CSP filters as simple signed bar strips (no plotting library).
  $('ncomp').textContent = String(result.cspFilters.length);
  const csp = $('csp');
  csp.innerHTML = '';
  for (const filter of result.cspFilters) {
    const max = Math.max(...filter.map((v) => Math.abs(v))) || 1;
    const row = document.createElement('div');
    row.className = 'csp-row';
    for (const v of filter) {
      const b = document.createElement('div');
      b.className = 'csp-bar' + (v < 0 ? ' neg' : '');
      b.style.height = `${4 + (Math.abs(v) / max) * 24}px`;
      row.append(b);
    }
    csp.append(row);
  }
}

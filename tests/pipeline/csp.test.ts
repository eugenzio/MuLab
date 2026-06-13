import { describe, it, expect } from 'vitest';
import { filtfiltChannels } from '../../src/pipeline/filter.ts';
import { epochSignal } from '../../src/pipeline/epoch.ts';
import { fitCsp } from '../../src/pipeline/csp.ts';
import { frobeniusNormDiff } from '../../src/validation/metrics.ts';
import { CSP_FROBENIUS_MAX } from '../../src/validation/tolerances.ts';
import { HAS_DATA, loadConcatenated, loadFixtures } from './_data.ts';

const d = HAS_DATA ? describe : describe.skip;

d('Stage 3 — CSP matches the oracle (csp_filters)', () => {
  it('reproduces the full-data CSP filters within CSP_FROBENIUS_MAX', async () => {
    const { signals } = await loadConcatenated();
    const f = await loadFixtures();
    const filtered = filtfiltChannels(f.params.filter.taps, signals);
    const { epochs } = epochSignal(
      filtered,
      f.epochs.event_samples,
      f.epochs.start_offset_samples,
      f.params.epoch.n_times,
    );

    const model = fitCsp(epochs, f.epochs.labels, f.params.csp.n_components, f.params.csp.reg);
    const frob = frobeniusNormDiff(f.cspFilters.full, model.filters);

    // eslint-disable-next-line no-console
    console.log(`Stage 3 CSP: aligned Frobenius diff vs oracle = ${frob}`);
    expect(model.filters.length).toBe(f.params.csp.n_components);
    expect(model.filters[0]!.length).toBe(f.params.n_channels);
    expect(frob).toBeLessThan(CSP_FROBENIUS_MAX);
  });
});

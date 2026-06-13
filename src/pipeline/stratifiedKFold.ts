/**
 * Deterministic stratified k-fold split — FALLBACK ONLY, for subjects without bundled
 * oracle fold indices. NOTE: this is NOT sklearn's seeded shuffle, so a run using these
 * folds is exploratory and will not reproduce the MNE-seeded accuracies. Known subjects
 * always use their dumped `fold_indices.json` instead.
 */
export interface Fold {
  train: number[];
  test: number[];
}

/** Stratified contiguous k-fold: within each class, split sorted indices into k groups. */
export function stratifiedKFold(labels: number[], k = 5): Fold[] {
  const byClass = new Map<number, number[]>();
  labels.forEach((l, i) => {
    if (!byClass.has(l)) byClass.set(l, []);
    byClass.get(l)!.push(i);
  });

  const testSets: number[][] = Array.from({ length: k }, () => []);
  for (const idxs of byClass.values()) {
    for (let i = 0; i < idxs.length; i++) {
      // Round-robin assignment keeps fold sizes balanced and class-stratified.
      testSets[i % k]!.push(idxs[i]!);
    }
  }

  const all = labels.map((_, i) => i);
  return testSets.map((test) => {
    const testSet = new Set(test);
    return { train: all.filter((i) => !testSet.has(i)), test: [...test].sort((a, b) => a - b) };
  });
}

#!/usr/bin/env node
/**
 * Phase 1 sample-data fetcher.
 *
 * Downloads small samples for the parsing feasibility spike and writes a manifest
 * (filename, bytes, sha256) so the spike is reproducible.
 *
 * Sources:
 *  - PhysioNet EEGMMIDB (EDF/EDF+): openly downloadable over HTTPS.
 *    License: stated as ODC-BY on PhysioNet — NEEDS VERIFICATION (see ASSUMPTIONS.md).
 *  - BCI Competition IV 2a (GDF 2.0): normally registration-gated. We attempt a few
 *    open mirrors; if none succeed, we LOG A BLOCKER and the user must supply the
 *    file into data/raw/ manually. We do not claim any mirror is authoritative.
 *
 * No file is overwritten if it already exists (idempotent re-runs).
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(__dirname, '..', 'data', 'raw');

/** PhysioNet EEGMMIDB.
 *  - R04, R08, R12 = Task 2: motor IMAGERY of left/right fist (T1=left, T2=right);
 *    concatenated per subject by the oracle for left-vs-right hand classification.
 *  - R03 (S001 only) = real movement — Phase 1 contrast.
 *  Run semantics: NEEDS VERIFICATION (ASSUMPTIONS.md).
 *  Subjects default to S001..S010; override with EEGMMIDB_SUBJECTS="S001,S005,..." */
const EEGMMIDB_ROOT = 'https://physionet.org/files/eegmmidb/1.0.0';
const IMAGERY_RUNS = ['R04', 'R08', 'R12'];
const SUBJECTS = (process.env.EEGMMIDB_SUBJECTS?.split(',').map((s) => s.trim()).filter(Boolean)) ??
  Array.from({ length: 10 }, (_, i) => `S${String(i + 1).padStart(3, '0')}`);

/** Build the per-subject EDF file list (subject, filename, url). */
function eegmmidbFileList() {
  const files = [];
  for (const subj of SUBJECTS) {
    for (const run of IMAGERY_RUNS) {
      const name = `${subj}${run}.edf`;
      files.push({ subj, name, url: `${EEGMMIDB_ROOT}/${subj}/${name}` });
    }
  }
  // Keep the Phase 1 contrast run for S001 if S001 is in the set.
  if (SUBJECTS.includes('S001')) {
    files.unshift({ subj: 'S001', name: 'S001R03.edf', url: `${EEGMMIDB_ROOT}/S001/S001R03.edf` });
  }
  return files;
}

/**
 * BCI IV 2a candidate mirrors for subject A01T. These are BEST-EFFORT and may
 * be dead or incorrect — verdict is decided at runtime by what actually downloads.
 * The canonical source (bnci-horizon-2020.eu / bbci) is the reference; community
 * mirrors are attempted because the canonical host has historically been flaky.
 */
const bciIV2aCandidates = [
  {
    name: 'A01T.gdf',
    urls: [
      'https://bnci-horizon-2020.eu/database/data-sets/001-2014/A01T.gdf',
      'https://lampx.tugraz.at/~bci/database/001-2014/A01T.gdf',
    ],
  },
];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Download `url` to `dest`. Returns true on success, false on any failure. */
async function download(url, dest) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) {
      console.warn(`  ✗ ${url} -> HTTP ${res.status}`);
      return false;
    }
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return true;
  } catch (err) {
    console.warn(`  ✗ ${url} -> ${err.message}`);
    return false;
  }
}

async function recordManifest(manifest, name, filePath) {
  const buf = await readFile(filePath);
  manifest.push({ name, bytes: buf.byteLength, sha256: sha256(buf) });
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  const manifest = [];
  const blockers = [];

  // --- PhysioNet EEGMMIDB (EDF) ---
  const eegmmidbFiles = eegmmidbFileList();
  console.log(`PhysioNet EEGMMIDB (EDF/EDF+): ${SUBJECTS.length} subjects, ${eegmmidbFiles.length} files`);
  for (const { name, url } of eegmmidbFiles) {
    const dest = join(RAW_DIR, name);
    if (await exists(dest)) {
      console.log(`  • ${name} already present, skipping`);
    } else {
      const ok = await download(url, dest);
      if (ok) console.log(`  ✓ ${name}`);
      else {
        blockers.push(`EEGMMIDB ${name}: download failed (${url})`);
        continue;
      }
    }
    await recordManifest(manifest, name, dest);
  }

  // --- BCI Competition IV 2a (GDF) — best-effort mirrors ---
  console.log('\nBCI Competition IV 2a (GDF 2.0) — attempting open mirrors:');
  for (const file of bciIV2aCandidates) {
    const dest = join(RAW_DIR, file.name);
    if (await exists(dest)) {
      console.log(`  • ${file.name} already present, skipping`);
      await recordManifest(manifest, file.name, dest);
      continue;
    }
    let got = false;
    for (const url of file.urls) {
      console.log(`  … trying ${url}`);
      if (await download(url, dest)) {
        const buf = await readFile(dest);
        // GDF magic = "GDF" + version. Reject obvious HTML error pages.
        const head = buf.subarray(0, 3).toString('latin1');
        if (head === 'GDF') {
          console.log(`  ✓ ${file.name} (magic OK)`);
          await recordManifest(manifest, file.name, dest);
          got = true;
          break;
        }
        console.warn(`  ✗ ${url} -> downloaded but magic="${head}" (not GDF)`);
      }
    }
    if (!got) {
      blockers.push(
        `BCI IV 2a ${file.name}: no open mirror returned a valid GDF file. ` +
          `User must register at the dataset source and place ${file.name} in data/raw/.`,
      );
    }
  }

  // --- Write manifest + report blockers ---
  const manifestPath = join(RAW_DIR, 'manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), files: manifest, blockers }, null, 2),
  );

  console.log('\n--- Summary ---');
  for (const m of manifest) console.log(`  ${m.name}  ${m.bytes} bytes  sha256=${m.sha256.slice(0, 16)}…`);
  if (blockers.length) {
    console.log('\n⚠ Blockers (documented, not fatal):');
    for (const b of blockers) console.log(`  - ${b}`);
  }
  console.log(`\nManifest written to ${manifestPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

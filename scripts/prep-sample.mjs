#!/usr/bin/env node
/**
 * Copy a sample subject's imagery EDFs from data/raw/ into public/sample/ so the demo page
 * can offer a zero-click "Run bundled sample". public/sample/ is gitignored (the EDFs are
 * large and license-caveated); run this after `npm run fetch-data`.
 */
import { mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SUBJECT = process.env.SAMPLE_SUBJECT ?? 'S001';
const FILES = ['R04', 'R08', 'R12'].map((r) => `${SUBJECT}${r}.edf`);
const RAW = resolve(ROOT, 'data', 'raw');
const OUT = resolve(ROOT, 'public', 'sample');

async function main() {
  await mkdir(OUT, { recursive: true });
  for (const f of FILES) {
    const src = resolve(RAW, f);
    try {
      await stat(src);
    } catch {
      console.error(`✗ ${f} not found in data/raw — run \`npm run fetch-data\` first.`);
      process.exit(1);
    }
    await copyFile(src, resolve(OUT, f));
    console.log(`  ✓ ${f}`);
  }
  await writeFile(resolve(OUT, 'manifest.json'), JSON.stringify({ subject: SUBJECT, files: FILES }, null, 2));
  console.log(`Bundled sample ${SUBJECT} -> public/sample/ (gitignored).`);
}

main();

#!/usr/bin/env bash
# Reports any BARE digit in the manuscript BODIES that is not inside a number macro, \todo,
# a citation/ref/label/include, a subject/run identifier (S001, R04, T1), or an Nx throttle label.
# Anti-fabrication guard: every quantitative claim must be a macro from numbers.tex or a \todo.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

node --input-type=module <<'EOF'
import { readFileSync } from 'node:fs';
const files = ['softwarex/main.tex', 'ieeeaccess/main.tex'];
let total = 0;
for (const f of files) {
  const src = readFileSync(new URL('./' + f, 'file://' + process.env.PWD + '/papers/').pathname, 'utf8');
  const body = (src.split('\\begin{document}')[1] ?? src).split('\\end{document}')[0];
  const hits = [];
  body.split('\n').forEach((raw, i) => {
    let s = raw.replace(/(^|[^\\])%.*$/, '$1');               // strip comments (keep \%)
    s = s.replace(/\\todo\{[^{}]*\}/g, '');                    // \todo{...}
    s = s.replace(/[0-9]+\\times/g, '');                       // Nx throttle labels
    s = s.replace(/\\(cite|ref|eqref|label|includegraphics|input|bibliography|bibliographystyle|documentclass|markboth|thanks|author|address|journal|title|usepackage|newcommand|resizebox|IEEEPARstart|vspace|hspace|vskip|hskip|setlength|addtolength)(\[[^\]]*\])?(\{[^{}]*\})?(\{[^{}]*\})?/g, '');
    s = s.replace(/\\[A-Za-z]+/g, '');                         // number macros + structural cmds
    s = s.replace(/S\d{3}|R\d{2}|T[12]/g, '');                 // dataset identifiers
    if (/[0-9]/.test(s)) hits.push(`${f}:${i + 1}: ${raw.trim()}`);
  });
  if (hits.length) { console.log(`\n[${f}] ${hits.length} line(s) with bare numbers:`); hits.forEach((h) => console.log('  ' + h)); }
  total += hits.length;
}
if (total === 0) console.log('OK: no bare numbers in manuscript bodies (all via macros / \\todo / identifiers).');
else { console.log(`\nFAIL: ${total} line(s) need a macro or \\todo.`); process.exitCode = 1; }
EOF

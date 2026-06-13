# Manuscript drafts (SoftwareX primary, IEEE Access alternative)

Two LaTeX drafts populated **only from real repo data** (see the per-macro source comments in
`shared/numbers.tex`). Finish and submit **one**. Every number is a macro from `numbers.tex` or a
visible `[TODO: ...]`; every citation is tagged `% TODO author must verify`.

## Build
No `latexmk`; use pdflatex + bibtex directly:
```bash
# regenerate figures + numbers first (real data)
scripts/oracle/.venv/bin/python papers/shared/figures/make_figures.py
# (numbers.tex is generated from JSON; see commit history / the generator in the Part report)

cd papers/softwarex   && pdflatex main && bibtex main && pdflatex main && pdflatex main
cd ../ieeeaccess      && pdflatex main && bibtex main && pdflatex main && pdflatex main
```
If a class is missing: `tlmgr install elsarticle ieeetran`.

## Checks
```bash
bash papers/check_numbers.sh   # no bare numbers in prose (must pass)
bash papers/wordcount.sh       # SoftwareX running words (<=3000) + figure count (<=6)
```

## OFFICIAL TEMPLATE TRANSFER (read before submitting)
These drafts use `elsarticle` / `IEEEtran` so they compile now, **but**:
- **SoftwareX** reviews only submissions made on its **official template**. Paste the finished
  content into the official SoftwareX template from the Elsevier Author Center before submitting.
- **IEEE Access** requires **`IEEEaccess.cls`** from the IEEE Author Center. Switch
  `\documentclass[journal]{IEEEtran}` to the official class before submitting.

## Author finishing checklist (`[TODO: ...]`)
**Both papers**
- Author affiliation; ORCID.
- Public **GitHub** repository URL (not GitLab).
- OSS license decision (MIT or Apache-2.0) + add a `LICENSE` file.
- Verify EEGMMIDB / PhysioNet license (ODC-By?).
- Complete the literature sweep to confirm the "to our knowledge" gap; add any needed citations.
- Verify **every** `refs.bib` entry (all tagged `% TODO author must verify`); fill the `\todo`
  fields for the tool projects and choose/verify the canonical CSP reference.
- **Physical low-spec device benchmark** — the repo has only the M4 run + a CPU-throttle *proxy*.
  Run `npm run benchmark` on a real low-spec device and add the number (do not present the proxy
  as a device).

**SoftwareX-specific**
- Code-metadata table C1–C9: version/tag, repo URL, (optional) reproducible capsule, license,
  docs URL, support email.
- CRediT roles if co-authors are added.

**IEEE Access-specific**
- Author biography (+ photo); acknowledgments.
- Switch to `IEEEaccess.cls`.

## Files
- `shared/numbers.tex` — every real number as a macro (regenerated from JSON; each line cites its
  source file). **Do not hand-edit numbers.**
- `shared/refs.bib`, `shared/code_metadata.tex`, `shared/figures/` (PDFs from real data + the
  `make_figures.py` generator + `architecture.tex` TikZ + `agreement.json`).
- `softwarex/main.tex`, `ieeeaccess/main.tex`.

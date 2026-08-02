# Structured Task Decomposition Improves Reliability of LLM-Based Knowledge Analysis

A reproducible benchmark comparing five execution strategies for structured
knowledge-analysis tasks. This repository contains **two versions** of the same
work — read whichever you prefer:

| Version | File | Style | Best for |
|---|---|---|---|
| **Engineering report** | [`paper/reliability-benchmark.md`](paper/reliability-benchmark.md) | Direct, conversational, plain English | Developers / engineers who want the gist fast |
| **Academic preprint** | [`paper/arxiv/main.tex`](paper/arxiv/main.tex) → [PDF](paper/arxiv/main.pdf) | Formal academic format (LaTeX) | Citation / formal reference |

Both versions report the **same experiment, same numbers, same conclusions**.
(Chinese companion: [`paper/reliability-benchmark_CN.md`](paper/reliability-benchmark_CN.md))

## Headline findings

1. **Reliability.** Decomposing a structured-analysis task into
   `extract → analyze → judge` lifts the success rate of returning valid
   structured output from **~31% to ~92%**. Retry alone adds only **+8** points;
   decomposition adds **+54**. **Decomposition — not retry — is the dominant
   driver of reliability.**
2. **Quality.** A multi-model Panel+Judge architecture produces higher-quality
   output than a single-model pipeline on accuracy (+1.0/5), coverage (+0.9/5),
   overall quality (+0.9/5), and hallucination rate. Graded by two independent
   LLM judges (Gemini + KIMI K2.6) in a blinded A/B setup with **7/7 inter-rater
   agreement**, validated by a human anchor with **3/3 agreement**.

> **Honesty note on wording.** The quality result is phrased as *"evidence
> consistently favors"* rather than *"proves"* — n=7 and a single domain
> (financial text) are not general proof. See the paper's Limitations section.

## Repository layout

```
papers-staging/
├── paper/
│   ├── reliability-benchmark.md      # engineering report (English) — read this first
│   ├── reliability-benchmark_CN.md   # Chinese companion
│   └── arxiv/
│       ├── main.tex                  # academic preprint (LaTeX source)
│       ├── main.pdf                  # compiled PDF (generate via Overleaf, see below)
│       ├── references.bib            # bibliography (7 entries, arXiv-verified)
│       └── figures/                  # (reserved; tables are in-tabular)
└── benchmark/
    ├── benchmark.ts                  # reference harness (5 modes: M1/M1R/M2/M3/M4)
    ├── extract-grading.ts            # blinded grading-pack generator (self-contained, runnable)
    ├── README.md                     # how to reproduce
    └── samples/
        ├── samples.json              # corpus manifest + SHA-256 fingerprints
        └── CORPUS.md                 # corpus provenance & reproduction notes
```

## Reproducibility

The benchmark harness and corpus are anchored to repository commit **`9301168`**
of the original reference implementation (the baseline at which all five modes
were functionally complete). The copy in `benchmark/` is taken from a later HEAD
of that project; see [`benchmark/README.md`](benchmark/README.md) for exact
provenance and run commands.

## Corpus note (important)

The 13 source documents are publicly accessible video transcripts. **The
transcript texts are NOT redistributed in this repository** — only a manifest
with SHA-256 fingerprints and character counts (`benchmark/samples/samples.json`
+ [`benchmark/samples/CORPUS.md`](benchmark/samples/CORPUS.md)). This respects
the original creators' distribution rights. Readers reproduce the runs by
obtaining the source documents and verifying them against the published
fingerprints.

## Compiling the academic PDF

The repository ships LaTeX **source**, not a compiled PDF (to keep the diff
clean). To produce `paper/arxiv/main.pdf`:

1. Go to [overleaf.com](https://www.overleaf.com) (free, no install needed).
2. New Project → Upload Project → zip `paper/arxiv/` and upload.
3. Set compiler to **pdfLaTeX**; the build runs `pdflatex → bibtex → pdflatex ×2`
   automatically.
4. Download the resulting `main.pdf`, place it at `paper/arxiv/main.pdf`.

(The `main.pdf` path is gitignored so you can keep a local copy without
committing the binary.)

## AI assistance disclosure

The experimental design, benchmark implementation, data collection, and analysis
were conducted entirely by the author. The prose of the academic manuscript was
prepared with assistance from an AI writing tool for drafting and polishing; all
technical content, experimental results, and conclusions were authored,
verified, and are the sole responsibility of the author. This disclosure also
appears in the paper's Acknowledgments section.

## Status & scope

This is a **small-scale, single-domain engineering benchmark** (n=13 for
reliability, n=7 for quality; all financial-investing text). Conclusions are
directional, not statistically definitive. The benchmark is designed to be
re-run on other domains by swapping the corpus. Feedback welcome via issues.

## Citing

(BibTeX entry to be added once a stable release/DOI is assigned.)

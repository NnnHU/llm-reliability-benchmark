# Benchmark reproduction

This directory contains the reproduction artifacts for the paper *"Structured
Task Decomposition Improves Reliability of LLM-Based Knowledge Analysis."*

## What is here

| File | Runnable? | Purpose |
|---|---|---|
| `benchmark.ts` | **No — reference copy** | The five-mode benchmark harness (M1/M1R/M2/M3/M4). Drives the original project's Mixture-of-Agents engine. |
| `extract-grading.ts` | **Yes — self-contained** | Generates blinded A/B grading packs from prior run traces. Uses only Node.js built-ins. |
| `samples/samples.json` | Data | Corpus manifest: 13 cases, each with queries + a content fingerprint. |
| `samples/CORPUS.md` | Doc | Corpus provenance, the full fingerprint table, and how to obtain/verify source docs. |

## Provenance

- `benchmark.ts` is copied from the **current HEAD (`e546e69`)** of the original
  reference-implementation project.
- The **reproduction baseline** referenced by the paper is commit **`9301168`**
  (the commit at which all five modes were functionally complete and the
  reported numbers were produced). This is the commit cited in §4 of the paper.
- `extract-grading.ts` is copied from the same project; it has no project-internal
  dependencies and runs standalone.

## Why `benchmark.ts` is a reference copy, not runnable here

`benchmark.ts` drives the **real** Mixture-of-Agents engine — it is deliberately
*not* a re-implemented fetch, so that the pipeline under test is exactly what the
application runs. It imports engine modules via relative paths
(`../src/services/moaEngine.js`, `../src/services/httpClient.js`,
`../src/i18n/index.js`) and their transitive dependencies. Those engine modules
are **not** shipped with this copy, because they belong to a separate product
codebase and are outside the scope of this paper artifact.

**To execute the full benchmark**, obtain the reference implementation at commit
`9301168`, place this `benchmark.ts` at `scripts/benchmark.ts` in that project,
configure `.env`, and run `npm run bench`. The numbers in the paper are produced
by exactly that setup.

## Running `extract-grading.ts` (self-contained)

This script only needs Node.js (and `tsx` for direct `.ts` execution). It reads
prior benchmark traces and the corpus manifest, and emits blinded grading files.

```bash
# From a checkout that has bench-results/ populated by a prior benchmark run:
npx tsx scripts/extract-grading.ts [runId]
#   runId defaults to the v1 run "2026-08-01T19-50-03".
```

It writes:
- `bench-results/grading-pack/<NN>-<caseId>.txt` — per-case A/B grading files
- `bench-results/grading-pack/PROMPT.md` — master grading prompt
- `bench-results/quality-grading-key.json` — the A/B → mode mapping (keep secret
  until grading is complete)

## Configuration (for `benchmark.ts`)

The harness reads an `.env` file with two OpenAI-compatible providers:

```
VITE_VERDEX_PROVIDER_BASE_URL=...
VITE_VERDEX_PROVIDER_API_KEY=...
VITE_VERDEX_PROVIDER_MODEL=deepseek-v4-flash
VITE_VERDEX_PROVIDER2_BASE_URL=...        # optional second panel model
VITE_VERDEX_PROVIDER2_API_KEY=...
VITE_VERDEX_PROVIDER2_MODEL=deepseek-v4-pro
# VITE_VERDEX_REQUEST_TIMEOUT_MS=360000   # optional, default 360000
```

> **Note on the `VITE_VERDEX_*` names.** These environment variable names are
> **historical** — they come from the original product codebase and are retained
> **verbatim** so that prior run traces and `.env` files remain reproducible
> without renaming. They do not refer to any product discussed in the paper. Do
> not rename them, or existing reproduction setups will break.

## Run commands (in the original project, at commit `9301168`)

```bash
# Run all 5 modes on all 13 cases (~40-70 min, ~150 API calls)
npm run bench -- --full

# Incremental: run only M1R + M4, merging prior M1/M2/M3 traces
npm run bench

# Re-run only M2 + M3 (e.g. after fixing an extract-retry issue)
npm run bench -- --remediate
```

## Outputs

`bench-results/` (not redistributed with this artifact — contains real model
output):

- `<runId>-<case>-<query>-trace.json` — full-fidelity traces (untruncated)
- `<runId>-<case>-<query>-report.md` — per-case comparison tables
- `<runId>-SUMMARY.md` — aggregate + key-question analysis

## Corpus

See `samples/CORPUS.md`. The source documents are publicly accessible video
transcripts; **only fingerprints are distributed**, not the transcript texts.

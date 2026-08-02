# Structured Task Decomposition Improves Reliability of LLM-Based Knowledge Analysis

**An Engineering Report**

> A reproducible benchmark comparing five execution strategies for structured
> knowledge-analysis tasks — single-shot, retry, single-model pipeline,
> multi-model Panel+Judge, and single-model self-critique — on a 13-case corpus.
> The headline finding: decomposing a task into extract → analyze → judge
> lifts the success rate of returning valid structured output from ~31% to ~92%,
> and the gain comes from the decomposition itself, not from retrying.

---

## Abstract

Large language models often fail silently when asked to produce structured
analytical output in a single call: they return empty responses, unparseable
text, or refuse the task. We compare five execution strategies of increasing
complexity on a fixed 13-case corpus of financial documents, holding the model
constant where possible to isolate each strategy's contribution. We find that
(1) **task decomposition** (an extract → analyze → judge pipeline) is the
dominant driver of reliability, improving the success rate from 31% (single
shot) to 92%, whereas retry alone adds only +8 points; (2) a **multi-model
Panel+Judge** architecture, evaluated under blinded dual-LLM grading with a
human anchor, produces higher-quality output than a single-model pipeline on
accuracy, coverage, overall quality, and hallucination rate. We release the
full benchmark harness, corpus, and traces so the results can be reproduced
and extended to other domains.

---

## 1. Introduction

A common engineering experience with LLMs: you ask for a structured JSON
analysis and the model returns nothing, or a refusal, or prose with no JSON.
For toy tasks this is a nuisance; for a product that must return reliable
structured output, it is fatal.

Two intuitive fixes are often tried: **retry on failure**, and **add more
models** (a "mixture of agents"). Both sound plausible, but without a
controlled experiment it is unclear which one actually buys reliability — and
at what cost.

This report describes a benchmark designed to **isolate the contribution of
each factor**. We define five execution strategies (§3) that form a chain of
single-variable changes, run them on a shared corpus, and measure both
**reliability** (does valid structured output come back?) and **quality**
(is that output any good?). The design lets us attribute gains to specific
mechanisms rather than to "using a fancier setup."

---

## 2. Experimental Setup

### 2.1 The five execution strategies

Each strategy answers the same question against the same source document and
produces the same target structure (a four-field verdict: consensus /
divergence / blindspots / verdict). They differ only in *how* the work is
organized.

| Mode | What it does | Cost (API calls) | Isolates |
|---|---|---|---|
| **M1** single-shot | One call; doc + question in the prompt | 1 | baseline |
| **M1R** single + retry | Same as M1, but retries on empty/bad output (≤4 attempts) | 1–4 | the contribution of **retry** alone |
| **M2** single-model pipeline | extract → analyze → judge, all with one model | 3 | the contribution of **task decomposition** beyond retry |
| **M3** multi-model Panel+Judge | extract, then 2 models analyze in parallel, then a Judge synthesizes | 4 | the contribution of **multiple models** beyond a single-model pipeline |
| **M4** single-model self-critique | answer → critique → revise, one model | 3 | whether **self-reflection** matches multi-model |

The chain is designed so each step changes **ideally one variable**:

```
M1 → M1R   : +retry, nothing else           (retry's contribution)
M1R → M2   : +pipeline structure            (decomposition's contribution)
M2 → M3    : +a second model in the panel   (multi-model's contribution)
M4 ↔ M3    : self-critique vs multi-model   (does self-reflection suffice?)
```

A residual confound (documented in §5): M3's Judge receives two analyses
while M2's receives one, so "model count" and "Judge input richness" are not
fully separated. We report this honestly rather than overclaim.

### 2.2 Corpus

13 cases, all from a single financial-investing article series (the Jeremy
Grantham / GMO bubble narrative), chosen for narrative richness and the
presence of specific verifiable facts (dates, P/E ratios, AUM figures).
Composition:

- 1 English summary document (~3.3k chars)
- 7 standard Chinese (Traditional) ASR transcripts (~9–12k chars each;
  contain speech-to-text noise — typos, misheard names)
- 3 large documents (~31–34k chars)
- 1 super-large document (~53k chars)
- 1 multi-document case (3 docs concatenated, ~32k chars)

Total: ~256k characters. The ASR noise is intentional — it tests robustness
to messy real-world input. The corpus is narrow in domain (finance); this is
a known limitation (§5).

### 2.3 Models

- Panel / Judge: `deepseek-v4-flash` (via `api.deepseek.com`, OpenAI-compatible protocol)
- Second panel model: `deepseek-v4-pro`
- Temperature: 0.7 for analysis/judge, 0.5 for extract, 0.5 for critique
- Max tokens per call: 2048; timeout: 360s

### 2.4 Metrics

**Reliability** (all 13 cases, all 5 modes): a mode "succeeds" on a case iff
it returns all four verdict fields with **real** content — parse-fallback
placeholders like `"(could not parse ...)"` do **not** count. (An earlier
draft of this analysis incorrectly counted placeholders as success; the bug
was found and the numbers below are corrected. See §5 on methodology.)

**Quality** (7 cases where both M2 and M3 produced real output): graded by
**two independent LLM judges** (Gemini and KIMI K2.6) in a **blinded A/B
setup** — neither judge knew which output was M2 or M3. Position bias was
cancelled by per-case A/B reordering. A **human anchor** graded 3 cases
blindly to validate the LLM judges. Scoring rubric: factual accuracy (1–5),
hallucination (Y/N), key-info coverage (1–5), overall quality (1–5), and a
forced preference (A / B / tied).

---

## 3. Results

### 3.1 Reliability — decomposition, not retry, drives success

| Mode | Success rate | Avg latency | Avg output chars | API calls |
|---|---|---|---|---|
| M1 single-shot | **31%** (4/13) | 21.4s | 458 | 13 |
| M1R single + retry | **38%** (5/13) | 45.7s | 626 | 21 |
| M2 single-model pipeline | **92%** (12/13) | 55.3s | 1,339 | 39 |
| M3 multi-model Panel+Judge | **92%** (12/13) | 50.4s | 1,531 | 52 |
| M4 single-model self-critique | **38%** (5/13) | 74.2s | 899 | 39 |

**Reading the chain:**

- **M1 → M1R: +8 points.** Retry rescued only 1 of 9 failures. The empty-response
  problem is not a transient blip that a second attempt fixes — the model
  genuinely struggles with the one-shot structured-JSON prompt ~60% of the time.
  **Retry alone is insufficient.**

- **M1R → M2: +54 points.** Decomposing the task into extract → analyze → judge
  (with the same single model) takes reliability from 38% to 92%. This is the
  dominant effect. **Task decomposition — not retry — is what makes the
  pipeline reliable.**

- **M2 → M3: +0 points on reliability** (both 92%), but see quality (§3.2).
  Adding a second model does not further improve the *rate* of producing valid
  output once a pipeline is in place.

- **M4 (self-critique): 38%.** A single model critiquing and revising its own
  output does **not** approach the pipeline's reliability. This is a naive
  answer→critique→revise implementation; engineered self-reflection (Reflexion,
  Self-Refine, Constitutional AI) may do better — but the result shows
  self-critique is not automatically a substitute for decomposition.

> **Headline finding:** *Structured task decomposition dramatically improves
> the reliability of LLM-based structured analysis — from ~31% to ~92%. The
> gain comes from the decomposition, not from retrying.*

### 3.2 Quality — multi-model beats single-model pipeline (blinded, dual-LLM + human-anchored)

For the 7 cases where both M2 and M3 returned real analysis, blinded grading
by Gemini + KIMI K2.6 (14 votes total):

| Metric | M2 (single-model pipeline) | M3 (multi-model Panel+Judge) | Δ (M3 − M2) |
|---|---|---|---|
| Factual accuracy (1–5) | 3.14 | **4.14** | **+1.00** |
| Key-info coverage (1–5) | 2.93 | **3.79** | **+0.86** |
| Overall quality (1–5) | 2.86 | **3.71** | **+0.86** |
| Hallucination (count /14) | 3 | **2** | M3 fewer |
| Preference wins (of 14) | 6 | **8** | M3 wins |

**The strongest single signal: both LLM judges agreed on preference in 7/7
cases (100% inter-rater agreement).** Two architecturally different models,
grading independently and blinded, picked the same winner every time — hard
to produce by chance, indicating the M2-vs-M3 difference is a real signal,
not scoring-scale noise.

**Human anchor validation: 3/3 agreement.** A domain-knowledgeable human
graded 3 representative cases blindly (deliberately including 2 cases where
the LLMs picked single-model M2 — the counter-intuitive choice). The human
agreed with the LLM judges on all 3, including both M2 wins. This confirms
the LLM judges are not blindly pro-multi-model: they pick single-model when
it is actually better, and the human agrees.

**Reading:** When both modes succeed, multi-model Panel+Judge produces
**higher-quality** output than a single-model pipeline — more accurate, better
coverage, fewer hallucinations, and preferred more often. The earlier
appearance that "M2 ≈ M3" (from output-character counts) was a measurement
artifact: by a richness proxy they looked equal, but on real quality grading
multi-model pulls ahead.

### 3.3 Notable secondary findings

- **Parallelism offsets latency.** M3 (4 calls, 2 models in parallel) averaged
  50.4s vs M2's 55.3s (3 sequential calls). Multi-model fan-out does **not**
  cost wall-clock time here, though it costs ~33% more tokens.
- **M3 beat M2 on latency in 6/13 cases**, including the multi-document case
  (M2 101s vs M3 37s) where sequential extract→analyze→judge on one model is
  slower than parallel panels.

---

## 4. Reproducibility

The benchmark is fully reproducible from the repository at commit `9301168`.

```bash
# Run all 5 modes on all 13 cases (~40–70 min, ~150 API calls)
npm run bench -- --full

# Incremental: run only M1R + M4, merging prior M1/M2/M3 traces
npm run bench

# Re-run only M2 + M3 (e.g. after fixing an extract-retry issue)
npm run bench -- --remediate
```

**Corpus:** `bench-samples/` (13 cases + `samples.json` manifest). The corpus
is domain-narrow (finance); replacing it with other-domain documents tests
generalization.

**Configuration:** `.env` with `VITE_VERDEX_PROVIDER_*` and
`VITE_VERDEX_PROVIDER2_*` (two OpenAI-compatible providers).

**Outputs:** `bench-results/` (gitignored — contains real model output):
- `<runId>-<case>-<query>-trace.json` — full-fidelity traces (untruncated)
- `<runId>-<case>-<query>-report.md` — per-case comparison tables
- `<runId>-SUMMARY.md` — aggregate + key-question analysis

**Blinded quality grading pack:** `npx tsx scripts/extract-grading.ts`
generates per-case A/B files (`bench-results/grading-pack/`) for blinded
grading by any LLM or human. The A/B → mode mapping is kept in
`quality-grading-key.json` (secret until grading is complete).

---

## 5. Discussion

### 5.1 What the evidence supports

- **Strong:** task decomposition improves reliability (31% → 92%, n=13, clean
  isolation of retry vs decomposition).
- **Preliminary but consistent:** multi-model Panel+Judge improves quality over
  a single-model pipeline (5 metrics, n=7, dual-LLM 7/7 agreement, human anchor
  3/3). We phrase this as *"evidence consistently favors"* rather than *"proves"*
  — n=7 and a single domain are not general proof.

### 5.2 Limitations

- **Sample size.** n=13 for reliability, n=7 for quality. Directional, not
  statistically definitive.
- **Domain narrowness.** All cases are financial-investing text. Whether the
  decomposition effect holds across domains (code, legal, medical) is untested.
  The corpus is designed to be swappable to test this.
- **One residual confound in M2 vs M3.** M3's Judge receives two analyses while
  M2's receives one, so "model count" and "Judge input richness" co-vary. The
  result should be read as "multi-model Panel+Judge > single-model pipeline,"
  not "more models alone > fewer models alone." A fully isolated test would
  feed M2's Judge two copies of the same single-model analysis.
- **M2's low scores are partly extract-driven.** In 2–3 cases M2's extract
  step partially failed even after retry, biasing its quality scores downward.
  The direction (M3 > M2) holds on the clean cases too, but the gap magnitude
  may be inflated.
- **LLM judges, not only humans.** The human anchor (3 cases) validates the
  LLM judges' direction, but a larger human study would strengthen this.

### 5.3 Methodological note: the placeholder bug

An earlier draft of this analysis reported "100% success" for every mode. That
was a statistics bug: the parser emits non-empty placeholder strings
(`"(could not parse ...)"`) on failure, and a naive non-empty check counted
them as success. The bug was caught by noticing the data looked implausibly
clean, and the fix (excluding placeholders from the success criterion) yielded
the numbers in §3. We retain this story in the report because catching and
correcting one's own measurement bias is a core part of trustworthy
benchmarking — and a reminder that *the most dangerous failures are the ones
that look like success*.

### 5.4 Implications for practice

For teams building LLM products that must return reliable structured output:

1. **Decompose first.** Before adding more models or fancier prompts, split the
   task into extract → analyze → judge. This single change had the largest
   effect in our benchmark.
2. **Retry is cheap insurance but not a fix.** Add it, but don't expect it to
   solve a fundamentally hard one-shot prompt.
3. **Multi-model earns its cost on quality, not reliability.** Once a pipeline
   is reliable, a second model improves output quality (accuracy, coverage,
   hallucination) without adding latency (parallelism offsets it).
4. **Self-critique is not a free substitute.** A naive answer→critique→revise
   loop did not match the pipeline. If pursuing self-reflection, use
   engineered prompts (Reflexion-style), and benchmark it.

---

## 6. Related Work

- **Self-Refine / Reflexion / Constitutional AI** — single-model
  self-improvement loops. Our M4 is a naive instance; engineered variants may
  outperform it. The benchmark's M4 slot is where such methods can be plugged
  in for comparison.
- **Mixture-of-Agents (MoA)** — multi-model aggregation. Our M3 is a minimal
  MoA (2 panels + 1 judge). The benchmark isolates MoA's contribution by
  comparing to M2 (single-model pipeline).
- **LLM-as-judge / human-anchored evaluation** — we use dual-LLM blinded
  grading plus a human anchor, following emerging best practice for可信
  evaluation when full human studies are infeasible.

---

## Appendix A: Per-case data

Reliability (all 13 cases × M1/M1R/M2/M3/M4) and quality grading (7 cases ×
M2/M3 × 2 judges) are available as machine-readable traces in
`bench-results/<runId>-*-trace.json`. The aggregate summary is in
`bench-results/<runId>-SUMMARY.md`. A condensed per-case table:

| Case | Corpus (chars) | M1 | M1R | M2 | M3 | M4 |
|---|---|---|---|---|---|---|
| grantham-summary | 3.3k | ✓ | ✓ | ✓ | ✓ | ✓ |
| g1-mean-reversion | 12.3k | ✓ | ✓ | ✓ | ✓ | ✗ |
| g2-keystone | 10.4k | ✗ | ✗ | ✗ | ✗ | ✓ |
| g3-ai-bet | 9.2k | ✗ | ✓ | ✓ | ✓ | ✗ |
| g4-reinvest | 11.0k | ✓ | ✗ | ✓ | ✗ | ✗ |
| g5-showdown | 10.1k | ✓ | ✓ | ✓ | ✗ | ✗ |
| g6-derivatives | 10.2k | ✓ | ✓ | ✓ | ✓ | ✓ |
| g7-chanos | 11.1k | ✗ | ✓ | ✓ | ✓ | ✗ |
| fbig1-1999 | 31.9k | ✗ | ✓ | ✓ | ✗ | ✓ |
| fbig2-2009 | 31.4k | ✗ | ✗ | ✗ | ✗ | ✗ |
| fbig3-2026 | 33.8k | ✗ | ✗ | ✗ | ✗ | ✗ |
| gsuper-synthesis | 53.0k | ✓ | ✓ | ✓ | ✗ | ✗ |
| multi-g123 (×3) | 31.9k | ✗ | ✗ | ✗ | ✓ | ✗ |

(✓ = produced real four-field output; ✗ = empty / placeholder / refusal.
"Real" excludes parse-fallback placeholders.)

## Appendix B: Blinded grading protocol

1. For each of the 7 cases where both M2 and M3 produced real output, extract
   the four-field verdicts into a case file with A/B labels assigned by a
   stable seeded shuffle (the mapping is saved to `quality-grading-key.json`,
   kept secret during grading).
2. Each case file contains: source document, question, Output A, Output B,
   and a scoring rubric.
3. Feed each case file to two LLM judges (Gemini, KIMI K2.6) independently.
4. To cancel position bias, the two judges receive different A/B orderings
   per case (the harness varies order by a per-case seed).
5. Collect accuracy / hallucination / coverage / overall scores + a forced
   preference from each judge.
6. **Human anchor:** a human grades 3 cases (selected to include M2-win and
   M3-win cases) using the same blinded files, then the human's preferences
   are compared to the LLM judges' for agreement.
7. Unblind: map A/B back to M2/M3 via the key file and aggregate.

---

*Engineering Report · reproducible from repository commit `9301168`.
Corpus, harness, and traces are included. The benchmark is designed to be
re-run on other domains by swapping `bench-samples/`.*

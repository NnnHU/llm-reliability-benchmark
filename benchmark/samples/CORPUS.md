# Corpus: provenance, fingerprints, and reproduction

This documents the 13-case benchmark corpus used in the paper *"Structured Task
Decomposition Improves Reliability of LLM-Based Knowledge Analysis."*

## Summary

- **13 cases**, all from a single financial-investing narrative series (the
  Jeremy Grantham / GMO bubble narrative). Chosen for narrative richness and the
  presence of specific verifiable facts (dates, P/E ratios, AUM figures).
- Composition: 1 English summary (~3.3k chars), 7 Chinese (Traditional) ASR
  transcripts (~9–12k chars each, containing speech-to-text noise), 3 large
  documents (~31–34k chars), 1 super-large (~53k chars), 1 multi-document case
  (3 docs concatenated, ~32k chars). Total ~256k characters.
- The ASR noise (typos, misheard names) is intentional — it tests robustness to
  messy real-world input.
- **Domain is narrow (finance); this is a stated limitation of the paper.**

## ⚠️ The transcript texts are NOT distributed here

The source documents are **publicly accessible video transcripts**. Their
copyright belongs to the original creators. Redistributing the full transcript
texts — e.g. bundling them in this repository or an arXiv submission — would
exceed the rights granted by the source platform's terms of service.

Therefore this artifact distributes **only**:

- `samples.json` — the manifest (case IDs, document filenames, queries, and a
  content fingerprint per case)
- this file — provenance notes and the full fingerprint table

Readers reproduce the runs by **obtaining the source documents themselves** and
**verifying each file against its published fingerprint** below.

## How to obtain and verify the source documents

1. Obtain each `.txt` file listed in the fingerprint table (the documents are
   publicly accessible video transcripts; the source is not named in the paper
   to avoid implying endorsement).
2. For each file, compute its SHA-256 and character count:
   ```bash
   sha256sum <file>
   wc -m <file>
   ```
3. Compare against the fingerprint in the table below (and in
   `samples.json`). If both match, your local copy is byte-identical to the one
   used in the paper.
4. Place the verified `.txt` files in the `bench-samples/` directory of the
   reference implementation (commit `9301168`) and run the benchmark.

The `fingerprint` field in `samples.json` is the machine-readable version of the
table below.

## Fingerprint table

Character counts use `wc -m` (character count, not byte count). SHA-256 is over
the raw file bytes.

| Case ID | Document | Chars | SHA-256 |
|---|---|---:|---|
| `grantham-summary` | `grantham.txt` | 3,249 | `50771767c9e0d536e53f4fc826fb82719ca2e71c800e777acf28fd6697eb25d9` |
| `g1-mean-reversion` | `g1.txt` | 12,323 | `b5d27c0be3ec068d2124b47efcc3376c038c0552e619bfd99fc5603c714d760c` |
| `g2-keystone` | `g2.txt` | 10,373 | `da1b85f198198fba19cb9f91d9a7a4695b02c835f32af941f9b50775ce898095` |
| `g3-ai-bet` | `g3.txt` | 9,138 | `0deb18f328835b0b702c91aa0efbbeb1c3d02e08d1cc7dd9e1797e5dfb9cf393` |
| `g4-reinvest` | `g4.txt` | 11,026 | `8134a3cdfdc6dffbcdd7a42c46651ba64e392805b3e5e9bfaa643c341a61061f` |
| `g5-showdown` | `g5.txt` | 10,122 | `838ab3b812910ef7b6b74d6d98aeb4d9b8973284d388f183b307bafc40a9c692` |
| `g6-derivatives` | `g6.txt` | 10,233 | `26c733963568fb6c0b88f985d2af073dd93889ce0e24c4fb394e7f05e4c537e2` |
| `g7-chanos` | `g7.txt` | 11,128 | `68fcd1583f04b871b516b6a08ab961ccf3b9321e5f7566b2d779de1f0a5dcaaf` |
| `fbig1-1999` | `F-big1.txt` | 31,834 | `0779aebb770fd7790c3b4d607b97b38f0f000f58dd11ecd5a7325befc3f132b5` |
| `fbig2-2009` | `F-big2.txt` | 31,381 | `c87933e4efe3806429aea4659f0684c51144f1e234a970bc41cb5d317e524a65` |
| `fbig3-2026` | `F-big3.txt` | 33,824 | `357619738cc76b8f90e8c849014451da5d5c41f4685140ae010785c909566415` |
| `gsuper-synthesis` | `G-super.txt` | 52,982 | `a494ba67f12cd964f9f1bdabfd520ec2d97c18b9951aa144e5e5a075641d921c` |
| `multi-g123` | `g1.txt` + `g2.txt` + `g3.txt` (concatenated in this order) | 31,834 | `0779aebb770fd7790c3b4d607b97b38f0f000f58dd11ecd5a7325befc3f132b5` |

### Note on the multi-document case

`multi-g123` concatenates `g1.txt`, `g2.txt`, `g3.txt` in that order
(12,323 + 10,373 + 9,138 = 31,834 chars). Its combined SHA-256 is computed over
that concatenation. (It happens to equal the fingerprint of `F-big1.txt` because
`F-big1.txt`'s content is exactly that same concatenation — i.e. `F-big1` and
`multi-g123` share the same source text. This is a property of the corpus, not
an error.)

## Extending the corpus

The corpus is designed to be **swappable** to test cross-domain generalization
(code, legal, medical). To add cases: drop new `.txt` files in `bench-samples/`,
add entries to `samples.json` with the same schema (including a `fingerprint`),
and re-run. Replacing the entire corpus with other-domain documents is the
cleanest test of whether the decomposition effect holds beyond finance.

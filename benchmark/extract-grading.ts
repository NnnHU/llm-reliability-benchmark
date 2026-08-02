/**
 * Quality grading pack generator (for LLM web-UI cross-grading).
 *
 * Self-contained: this script has NO project-internal dependencies — it uses
 * only Node.js built-ins (node:fs / node:path / node:url). It reads prior
 * benchmark traces from bench-results/ and the corpus manifest from
 * bench-samples/, and emits blinded A/B grading files. Runnable standalone
 * with `npx tsx scripts/extract-grading.ts [runId]`.
 *
 * Emits per-case .txt files ready to copy-paste into the Gemini / ChatGPT web UI,
 * plus a master prompt. Each case file contains: source doc + question + two
 * blinded outputs (A/B) + a bilingual scoring rubric.
 *
 * The A/B assignment is a STABLE blind shuffle (seeded), so re-running won't
 * reshuffle. The A->mode mapping is saved to a key file (keep secret from the
 * graders until done).
 *
 * To cancel position bias between the two graders: feed Gemini the file as-is
 * (A then B), and feed ChatGPT with A/B swapped (the master prompt explains how).
 *
 * Usage: npx tsx scripts/extract-grading.ts [runId]
 *   runId defaults to the v1 run "2026-08-01T19-50-03".
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RESULTS_DIR = join(ROOT, "bench-results");
const GRADING_DIR = join(RESULTS_DIR, "grading-pack");
const SAMPLES_DIR = join(ROOT, "bench-samples");

interface VerdictFields { consensus: string; divergences: string; blindspots: string; verdict: string; }
interface ModeInTrace { mode: string; ok: boolean; fields: VerdictFields; }

/** Deterministic seeded shuffle (same input + seed -> same output). */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isPlaceholder(v: string): boolean {
  const t = (v || "").trim();
  if (!t) return true;
  if (/^\(.*\)$/.test(t) && t.length < 60) return true;
  return /^(could not parse|judge returned no content|no content|未能|裁判未返回)/i.test(t);
}

function loadTrace(runId: string, caseId: string, queryId: string): ModeInTrace[] | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(RESULTS_DIR, `${runId}-${caseId}-${queryId}-trace.json`), "utf8")
    ) as { results: ModeInTrace[] };
    return raw.results;
  } catch {
    return null;
  }
}

const realFieldCount = (r: ModeInTrace) =>
  (["consensus", "divergences", "blindspots", "verdict"] as const).filter(
    (k) => !isPlaceholder(r.fields[k])
  ).length;

/** Detect "unusable" outputs: either the extract step returned empty, or the
 *  verdict text reads as a canned "cannot answer / extracted knowledge empty"
 *  refusal (which happens when extract poisoned the pipeline). Such outputs
 *  carry no real analysis and must be excluded from quality grading.
 *
 *  Note: phrases like "no substantive disagreement" are LEGITIMATE analysis
 *  (the experts genuinely agreed), so we match only true refusal patterns. */
const JUNK_RE = /extracted knowledge.*(empty|not provided|missing|was not)|unable to (produce|answer|provide) a (factual |real )?answer|cannot (produce|provide) (a |an )?(factual |real )?answer/i;
function isUsableOutput(r: ModeInTrace): boolean {
  if (realFieldCount(r) < 3) return false;
  const blob = `${r.fields.consensus} ${r.fields.divergences} ${r.fields.blindspots} ${r.fields.verdict}`;
  if (JUNK_RE.test(blob)) return false;
  // Also reject if all four fields together are suspiciously short.
  if (blob.trim().length < 150) return false;
  return true;
}

function renderOutput(label: string, f: VerdictFields): string {
  return [
    `### 输出 ${label} / Output ${label}`,
    `- 共识 / Consensus: ${f.consensus}`,
    `- 分歧 / Divergences: ${f.divergences}`,
    `- 盲点 / Blindspots: ${f.blindspots}`,
    `- 裁决 / Verdict: ${f.verdict}`,
  ].join("\n");
}

/** The per-case body. order = "AB" or "BA" (for position-bias cancellation). */
function buildCaseText(
  caseNo: number, caseId: string, query: string, corpus: string,
  first: { label: string; f: VerdictFields }, second: { label: string; f: VerdictFields }
): string {
  return [
    `# 案例 ${caseNo}: ${caseId}`,
    ``,
    `## 问题 / Question`,
    query,
    ``,
    `## 原文 / Source document`,
    corpus,
    ``,
    `## 待评分的两份输出 / Two outputs to grade`,
    `下面有两份针对同一问题和原文的分析输出（标记为 ${first.label} 和 ${second.label}）。`,
    `Two analysis outputs for the same question and source, labeled ${first.label} and ${second.label}.`,
    ``,
    renderOutput(first.label, first.f),
    ``,
    renderOutput(second.label, second.f),
    ``,
    `## 评分要求 / Scoring rubric`,
    `请对 ${first.label} 和 ${second.label} 分别打分，严格依据原文事实核对。`,
    `Grade ${first.label} and ${second.label} independently, strictly against the source.`,
    ``,
    `每个输出给出 4 个分数 + 1 个偏好：`,
    `For each output, give 4 scores + 1 preference:`,
    ``,
    `1. 事实准确率 Factual accuracy (1-5): 是否准确反映原文？有无错误陈述？(1=大量错误, 5=完全准确)`,
    `2. 幻觉 Hallucination (Y/N): 是否编造了原文不存在的内容/数字/人物？(Y=有幻觉, N=无)`,
    `3. 关键信息覆盖 Coverage (1-5): 是否覆盖原文核心要点？有无重大遗漏？(1=严重遗漏, 5=覆盖完整)`,
    `4. 总体质量 Overall quality (1-5): 作为分析报告的整体质量。(1=很差, 5=优秀)`,
    `5. 偏好 Preference: ${first.label}更好 / ${second.label}更好 / 差不多 (${first.label} better / ${second.label} better / tied)`,
    ``,
    `## 输出格式 / Output format (请严格按此格式，方便汇总)`,
    "```",
    `${first.label}: accuracy=, hallucination=, coverage=, overall=`,
    `${second.label}: accuracy=, hallucination=, coverage=, overall=`,
    `preference: ${first.label}/${second.label}/tied`,
    `reason: (一句话理由)`,
    "```",
    ``,
    `注意 Notes:`,
    `- 严格依据原文核对，不要凭常识补充原文没有的内容。`,
    `  Grade strictly against the source; do not add outside knowledge.`,
    `- 如果输出更长但内容更空/重复，不要因此给高分。`,
    `  Longer is not better if it's padding/repetition.`,
    `- 幻觉判定：输出里任何原文没有的具体数字、人名、事件都算幻觉。`,
    `  Any specific number/name/event not in the source counts as hallucination.`,
  ].join("\n");
}

function main(): void {
  const runId = process.argv[2] ?? "2026-08-01T19-50-03";
  mkdirSync(GRADING_DIR, { recursive: true });
  // Clean old per-case txt + PROMPT.md from a prior run so stale files don't
  // accumulate and number-collide with fresh ones. Keep the hand-written
  // *-系统指令.txt system-prompt files.
  for (const f of readdirSync(GRADING_DIR)) {
    if (f.endsWith("-系统指令.txt")) continue;
    try { unlinkSync(join(GRADING_DIR, f)); } catch { /* ignore */ }
  }

  const manifest = JSON.parse(readFileSync(join(SAMPLES_DIR, "samples.json"), "utf8")) as {
    cases: { id: string; doc: string; multiDocs?: string[]; queries: { id: string; text: string }[] }[];
  };

  const blindMap: Record<string, { A: string; B: string }> = {};
  let caseNo = 0;
  let skipped = 0;
  const indexLines: string[] = [];

  for (const c of manifest.cases) {
    for (const q of c.queries) {
      const results = loadTrace(runId, c.id, q.id);
      if (!results) { skipped++; continue; }
      const m2 = results.find((r) => r.mode === "M2-single-multi-step");
      const m3 = results.find((r) => r.mode === "M3-multi-model");
      if (!m2 || !m3) { skipped++; continue; }
      if (!isUsableOutput(m2) || !isUsableOutput(m3)) {
        console.log(`  skip ${c.id}/${q.id}: unusable output (extract failed or refusal text)`);
        skipped++;
        continue;
      }
      caseNo++;
      const names = [c.doc, ...(c.multiDocs ?? [])];
      const corpus = names
        .map((n) => `=== ${n} ===\n${readFileSync(join(SAMPLES_DIR, n), "utf8")}`)
        .join("\n\n");

      // Stable blind shuffle per case.
      const seed = caseNo * 1000 + 7;
      const modes = seededShuffle([{ tag: "M2", f: m2.fields }, { tag: "M3", f: m3.fields }], seed);
      blindMap[`${c.id}/${q.id}`] = { A: modes[0].tag, B: modes[1].tag };

      // File content: A then B (Gemini uses this as-is).
      const text = buildCaseText(
        caseNo, c.id, q.text, corpus,
        { label: "A", f: modes[0].f }, { label: "B", f: modes[1].f }
      );
      const fname = `${String(caseNo).padStart(2, "0")}-${c.id}.txt`;
      writeFileSync(join(GRADING_DIR, fname), text, "utf8");
      // NOTE: do NOT record the A/B->mode mapping here — that would leak the blind
      // into PROMPT.md. The mapping lives only in quality-grading-key.json.
      indexLines.push(fname);
    }
  }

  // Master prompt: explains how to grade, including the position-swap trick.
  const prompt = [
    `# 质量打分提示词 / Quality Grading Prompt`,
    ``,
    `## 任务 / Task`,
    `下面有一系列案例文件，每个文件包含一段原文、一个问题，以及两份分析输出（标记为 A 和 B）。`,
    `请你对 A 和 B 分别打分。`,
    ``,
    `Each case file has a source doc, a question, and two analysis outputs (A and B).`,
    `Grade A and B independently per the rubric in each file.`,
    ``,
    `## 怎么用 / How to use`,
    `1. 打开 grading-pack/ 目录里的案例文件（01-xxx.txt 到 ${String(caseNo).padStart(2,"0")}-xxx.txt）。`,
    `2. 把整个文件内容复制粘贴到 AI 网页界面（Gemini 或 ChatGPT）。`,
    `3. 收集它返回的分数。`,
    `4. **⚠️ 不要打开 quality-grading-key.json** —— 那是 A/B 对应答案，看了会破坏盲评。`,
    ``,
    `## 抵消位置偏差 / Cancel position bias (重要!)`,
    `Gemini 和 ChatGPT 对"谁排在前面"有轻微偏好。为抵消：`,
    ``,
    `- **Gemini**: 直接粘贴文件（A 在前，B 在后）。`,
    `- **ChatGPT**: 粘贴前，手动把文件里"输出 A"整段和"输出 B"整段**对调位置**（让 B 在前）。`,
    `  ChatGPT 的输出里仍然会出现 A 和 B 的分数，顺序不影响你记录。`,
    ``,
    `这样两个 AI 看到的顺序相反，取平均可抵消位置偏差。`,
    `Gemini and ChatGPT have a slight preference for whichever output appears first.`,
    `Feed Gemini the file as-is (A first); for ChatGPT, manually swap the A and B output`,
    `blocks before pasting (B first). Their scores still reference A/B labels, so averaging`,
    `cancels the position bias.`,
    ``,
    `## 案例清单 / Case list`,
    ...indexLines.map((l) => `- ${l}`),
    ``,
    `## 收集分数后 / After collecting scores`,
    `把两个 AI 对每个案例的打分发回给我（格式: A: accuracy=.. hallucination=.. coverage=.. overall=..；`,
    `B: ...；preference: ...）。我会解盲（A/B 对应回 M2/M3）并统计分析。`,
    `Send both AIs' scores back; I'll unblind (A/B -> M2/M3) and analyze.`,
  ].join("\n");
  writeFileSync(join(GRADING_DIR, "PROMPT.md"), prompt, "utf8");

  // Blind key (secret until grading done).
  writeFileSync(
    join(RESULTS_DIR, "quality-grading-key.json"),
    JSON.stringify({ runId, generatedAt: new Date().toISOString(), blindMap, totalCases: caseNo }, null, 2),
    "utf8"
  );

  console.log(`✓ Grading pack: ${GRADING_DIR}`);
  console.log(`  ${caseNo} case .txt files + PROMPT.md`);
  console.log(`  ${skipped} cases skipped (placeholder-heavy)`);
  console.log(`✓ Blind key: ${join(RESULTS_DIR, "quality-grading-key.json")} (keep secret)`);
}

main();

/**
 * Benchmark harness — five execution strategies for structured knowledge analysis.
 *
 * REFERENCE IMPLEMENTATION COPY.
 * This file is a read-only reproduction artifact accompanying the paper
 * "Structured Task Decomposition Improves Reliability of LLM-Based Knowledge
 * Analysis." It is the benchmark harness at the original project's commit
 * 9301168 (the baseline at which all five modes were functionally complete).
 *
 * This copy is NOT self-runnable as-is: it drives the original project's
 * Mixture-of-Agents engine (runMoaSynthesis / streamChat / parseJudgeResponse)
 * via the relative imports below (../src/services/...). Those engine modules
 * and their transitive dependencies are NOT shipped with this copy. To execute,
 * obtain the reference implementation at commit 9301168 and run this script in
 * its original location. See ../README.md for details.
 *
 * Compares five execution modes against a fixed case corpus to quantify the
 * relative contributions of retry, task decomposition, multi-model fan-out,
 * and self-critique to reliability and quality of structured output:
 *
 *   M1   single-shot                  — one streamChat call, doc + query in prompt  (1× cost)
 *   M1R  single + retry               — M1 with retry on empty/bad output (≤4)      (1–4× cost)
 *   M2   single-model pipeline        — extract → analyze → judge, one model        (3× cost)
 *   M3   multi-model Panel + Judge    — runMoaSynthesis with panelIds = [p1, p2]    (4× cost)
 *   M4   single-model self-critique   — answer → critique → revise, one model      (3× cost)
 *
 * This script drives the REAL engine — not a re-implemented fetch — so the
 * pipeline under test is exactly what the application runs. Full-fidelity trace
 * dumps are captured from the engine callbacks (un-truncated).
 *
 * Usage:
 *   npm run bench                # run all cases × all queries × all modes
 *   npx tsx scripts/benchmark.ts # equivalent
 *
 * Outputs land in bench-results/<timestamp>-{trace.json,report.md}.
 * Config comes from .env (VITE_VERDEX_PROVIDER_* / PROVIDER2_*). The VITE_VERDEX_*
 * environment variable names are historical and retained verbatim for
 * reproducibility — do not rename them.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { runMoaSynthesis, parseJudgeResponse, DEFAULT_JUDGE_PROMPTS } from "../src/services/moaEngine.js";
import { streamChat } from "../src/services/httpClient.js";
import "../src/i18n/index.js"; // initialize i18n (moaEngine depends on it for error strings)
import type { AIProvider, SynthesisResponse } from "../src/types/moa.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SAMPLES_DIR = join(ROOT, "bench-samples");
const RESULTS_DIR = join(ROOT, "bench-results");

/* ------------------------------------------------------------------ *
 * Config: build two providers from .env (same as the app's seed).
 * ------------------------------------------------------------------ */

function parseEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(join(ROOT, ".env"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

function buildProvider(env: Record<string, string>, suffix: string, id: string): AIProvider | null {
  const baseUrl = env[`VITE_VERDEX_PROVIDER${suffix}_BASE_URL`];
  const apiKey = env[`VITE_VERDEX_PROVIDER${suffix}_API_KEY`];
  const model = env[`VITE_VERDEX_PROVIDER${suffix}_MODEL`];
  if (!baseUrl || !apiKey || !model) return null;
  const name = env[`VITE_VERDEX_PROVIDER${suffix}_NAME`] ?? model;
  const protocolRaw = env[`VITE_VERDEX_PROVIDER${suffix}_PROTOCOL`] ?? "openai";
  return {
    id,
    name,
    modelString: model,
    baseUrl,
    apiKey,
    protocol: protocolRaw === "anthropic" ? "anthropic" : "openai",
  };
}

/* ------------------------------------------------------------------ *
 * Sample loading.
 * ------------------------------------------------------------------ */

interface SampleQuery { id: string; text: string; }
interface SampleCase {
  id: string;
  doc: string;
  /** Optional additional docs to combine into one corpus (multi-doc case). */
  multiDocs?: string[];
  queries: SampleQuery[];
}

function loadSamples(): { cases: SampleCase[]; docs: Map<string, string> } {
  const manifest = JSON.parse(readFileSync(join(SAMPLES_DIR, "samples.json"), "utf8")) as
    { cases: SampleCase[] };
  const docs = new Map<string, string>();
  // Collect every filename referenced by any case (primary + multiDocs).
  for (const c of manifest.cases) {
    const names = [c.doc, ...(c.multiDocs ?? [])];
    for (const n of names) {
      if (!docs.has(n)) {
        docs.set(n, readFileSync(join(SAMPLES_DIR, n), "utf8"));
      }
    }
  }
  return { cases: manifest.cases, docs };
}

/** Build the combined corpus text for a case (single doc, or multi-doc joined). */
function caseCorpus(c: SampleCase, docs: Map<string, string>): { text: string; sourceNames: string[] } {
  const names = [c.doc, ...(c.multiDocs ?? [])];
  const parts = names.map((n) => {
    const body = docs.get(n)!;
    // Prefix each doc with a header so the model can tell them apart.
    return `=== ${n} ===\n${body}`;
  });
  return { text: parts.join("\n\n"), sourceNames: names };
}

/* ------------------------------------------------------------------ *
 * Timing + metric helpers.
 * ------------------------------------------------------------------ */

function nowMs(): number { return Date.now(); }

/** Pull the four verdict fields out of a parsed response (verdict or extract kind). */
function verdictFields(resp: SynthesisResponse | null): {
  consensus: string; divergences: string; blindspots: string; verdict: string;
} {
  if (!resp) return { consensus: "", divergences: "", blindspots: "", verdict: "" };
  if (resp.kind === "verdict") {
    return {
      consensus: resp.consensus, divergences: resp.divergence,
      blindspots: resp.blindspots, verdict: resp.verdict,
    };
  }
  // extract kind: data may itself be a four-field shape
  const d = resp.data as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    consensus: s(d.consensus),
    divergences: s(d.divergences ?? d.divergence),
    blindspots: s(d.blindspots),
    verdict: s(d.verdict),
  };
}

function countNonEmpty(fields: Record<string, string>): number {
  return Object.values(fields).filter((v) => v.trim().length > 0).length;
}

/** Does a field value represent REAL content (not a parse fallback placeholder)?
 *  parseJudgeResponse emits placeholders like "(could not parse...)" /
 *  "(judge returned no content)" when parsing fails — those are non-empty
 *  strings but must NOT count as success for reliability stats. */
function isPlaceholder(v: string): boolean {
  const t = v.trim();
  if (!t) return true;
  // Placeholders are wrapped in parentheses and match known fallback phrases.
  // Also catch any short "(...)" paren-wrapped string as a safety net.
  if (/^\(.*\)$/.test(t) && t.length < 60) return true;
  return /^(could not parse|judge returned no content|未能解析|裁判未返回|no content)/i.test(t);
}

/** Count fields with REAL content (excludes placeholders). Used for reliability. */
function countReal(fields: Record<string, string>): number {
  return Object.values(fields).filter((v) => !isPlaceholder(v)).length;
}

/* ------------------------------------------------------------------ *
 * M1 — single-model single-shot.
 * One streamChat call; the doc + query go straight into the user prompt.
 * ------------------------------------------------------------------ */

interface ModeResult {
  mode: string;
  ok: boolean;
  latencyMs: number;
  apiCalls: number;
  rawOutput: string;
  parsed: SynthesisResponse | null;
  validJson: boolean;
  fields: ReturnType<typeof verdictFields>;
  trace: unknown;
  error?: string;
}

async function runMode1(
  provider: AIProvider, docText: string, query: string, timeoutMs: number
): Promise<ModeResult> {
  const start = nowMs();
  const prompt = [
    "You are an expert analyst. Read the document below and answer the question.",
    "Output ONLY a JSON object with exactly these four fields:",
    '"consensus", "divergence", "blindspots", "verdict" (each a non-empty string).',
    "No markdown fences, no extra prose.",
    "",
    "Question: " + query,
    "",
    "Document:",
    docText,
  ].join("\n");
  try {
    const raw = await streamChat(
      {
        baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.modelString,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7, maxTokens: 2048, timeoutMs, protocol: provider.protocol,
      },
      () => { /* swallow deltas for headless run */ }
    );
    const parsed = parseJudgeResponse(raw, "verdict");
    const fields = verdictFields(parsed);
    return {
      mode: "M1-single-shot", ok: true, latencyMs: nowMs() - start, apiCalls: 1,
      rawOutput: raw, parsed, validJson: parsed.kind === "verdict", fields,
      trace: { prompt, rawOutput: raw },
    };
  } catch (err) {
    return {
      mode: "M1-single-shot", ok: false, latencyMs: nowMs() - start, apiCalls: 1,
      rawOutput: "", parsed: null, validJson: false,
      fields: { consensus: "", divergences: "", blindspots: "", verdict: "" },
      trace: { prompt, error: String(err) }, error: String(err),
    };
  }
}

/* ------------------------------------------------------------------ *
 * M1R — single-model single-shot WITH retry.
 *
 * Same prompt as M1, but if the call returns an empty body OR fails to parse
 * into a complete four-field verdict, it retries (mirroring the engine's
 * PANEL_MAX_ATTEMPTS=2 + PANEL_RETRY_BACKOFF_MS=800 from moaEngine runPanel,
 * the v0.2.2 BUG #2 fix). This isolates the contribution of retry alone:
 * M1 vs M1R = how much reliability does retry buy, with NO pipeline structure?
 * ------------------------------------------------------------------ */

const M1R_MAX_ATTEMPTS = 2;
const M1R_RETRY_BACKOFF_MS = 800;

/** Is a raw response "good enough" (non-empty + parses to 4 verdict fields)? */
function isUsableVerdict(raw: string, fields: ReturnType<typeof verdictFields>): boolean {
  if (!raw.trim()) return false;
  return countNonEmpty(fields) === 4;
}

/**
 * Run streamChat with a retry on empty/transient failures (mirrors moaEngine
 * runPanel + M1R logic). Used by M2/M3 extract pre-stages so an empty extract
 * response doesn't silently poison the whole pipeline.
 * Returns { text, attempts }. attempts = number of API calls actually made.
 *
 * Note: extract prompts hit a higher empty-response rate than the engine's
 * panel calls, so we default to 4 attempts (vs the engine's 2) with a longer
 * backoff — empirically needed to get usable extract outputs.
 */
async function streamChatWithRetry(
  opts: Parameters<typeof streamChat>[0],
  maxAttempts = 4,
  backoffMs = 1200
): Promise<{ text: string; attempts: number }> {
  let lastText = "";
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts++;
    try {
      const text = await streamChat(opts, () => {});
      lastText = text;
      if (text.trim()) return { text, attempts };
      // empty body → retry (if attempts remain)
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    } catch (err) {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, backoffMs));
      } else {
        throw err;
      }
    }
  }
  return { text: lastText, attempts };
}

async function runMode1R(
  provider: AIProvider, docText: string, query: string, timeoutMs: number
): Promise<ModeResult> {
  const start = nowMs();
  const prompt = [
    "You are an expert analyst. Read the document below and answer the question.",
    "Output ONLY a JSON object with exactly these four fields:",
    '"consensus", "divergence", "blindspots", "verdict" (each a non-empty string).',
    "No markdown fences, no extra prose.",
    "",
    "Question: " + query,
    "",
    "Document:",
    docText,
  ].join("\n");
  const attempts: { raw: string; ok: boolean }[] = [];
  let lastRaw = "";
  let lastParsed: SynthesisResponse | null = null;
  let lastFields = { consensus: "", divergences: "", blindspots: "", verdict: "" };
  let totalCalls = 0;
  let lastError: string | undefined;
  try {
    for (let attempt = 1; attempt <= M1R_MAX_ATTEMPTS; attempt++) {
      totalCalls++;
      try {
        const raw = await streamChat(
          {
            baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.modelString,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7, maxTokens: 2048, timeoutMs, protocol: provider.protocol,
          },
          () => {}
        );
        lastRaw = raw;
        lastParsed = parseJudgeResponse(raw, "verdict");
        lastFields = verdictFields(lastParsed);
        const usable = isUsableVerdict(raw, lastFields);
        attempts.push({ raw, ok: usable });
        if (usable) break;
        // Not usable yet → backoff and retry (if attempts remain).
        if (attempt < M1R_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, M1R_RETRY_BACKOFF_MS));
        }
      } catch (err) {
        attempts.push({ raw: "", ok: false });
        lastError = String(err);
        if (attempt < M1R_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, M1R_RETRY_BACKOFF_MS));
        }
      }
    }
    const ok = isUsableVerdict(lastRaw, lastFields);
    return {
      mode: "M1R-single-retry", ok, latencyMs: nowMs() - start, apiCalls: totalCalls,
      rawOutput: lastRaw, parsed: lastParsed, validJson: lastParsed?.kind === "verdict",
      fields: lastFields,
      trace: { prompt, attempts, retriesUsed: totalCalls - 1 },
      error: ok ? undefined : lastError,
    };
  } catch (err) {
    return {
      mode: "M1R-single-retry", ok: false, latencyMs: nowMs() - start, apiCalls: totalCalls,
      rawOutput: lastRaw, parsed: null, validJson: false,
      fields: { consensus: "", divergences: "", blindspots: "", verdict: "" },
      trace: { prompt, attempts }, error: String(err),
    };
  }
}

/* ------------------------------------------------------------------ *
 * M4 — single-model self-critique (answer → critique → revise).
 *
 * All three steps use the SAME model. Answers the question: can a single
 * model reach multi-model quality by critiquing and revising its own output?
 * If M4 ≈ M3, multi-model fan-out may be unnecessary; self-reflection suffices.
 * ------------------------------------------------------------------ */

async function runMode4(
  provider: AIProvider, docText: string, query: string, timeoutMs: number
): Promise<ModeResult> {
  const start = nowMs();
  const trace: Record<string, unknown> = {};
  const call = (systemPrompt: string, userPrompt: string, temperature: number) =>
    streamChat(
      {
        baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.modelString,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature, maxTokens: 2048, timeoutMs, protocol: provider.protocol,
      },
      () => {}
    );
  try {
    // Step 1: answer — produce a first-draft four-field verdict.
    const answerSys = [
      "You are an expert analyst. Read the document and answer the user's question.",
      "Output ONLY a JSON object with exactly these four fields:",
      '"consensus", "divergence", "blindspots", "verdict" (each a non-empty string).',
      "No markdown fences, no extra prose.",
    ].join("\n");
    const answerUser = "Question: " + query + "\n\nDocument:\n" + docText;
    const answerRaw = await call(answerSys, answerUser, 0.7);
    trace.answerPrompt = { system: answerSys, user: answerUser };
    trace.answerRaw = answerRaw;

    // Step 2: critique — find weaknesses in the draft (do NOT re-answer).
    const critiqueSys = [
      "You are a strict reviewer. You are given a draft analysis (JSON with four",
      "fields) and the original question + document. Your job is to find the draft's",
      "weaknesses: factual errors, missing perspectives, unsupported claims, shallow",
      "analysis, and any field that is weak or empty. Do NOT re-answer the question;",
      "only critique. Output a concise bullet list of weaknesses (plain text).",
    ].join("\n");
    const critiqueUser = "Question: " + query + "\n\nDraft analysis:\n" + answerRaw;
    const critiqueRaw = await call(critiqueSys, critiqueUser, 0.5);
    trace.critiquePrompt = { system: critiqueSys, user: critiqueUser };
    trace.critiqueRaw = critiqueRaw;

    // Step 3: revise — improve the draft using the critique.
    const reviseSys = [
      "You are an expert analyst. You previously drafted an analysis and received",
      "critique. Now produce the FINAL, improved version that addresses the critique.",
      "Output ONLY a JSON object with exactly these four fields:",
      '"consensus", "divergence", "blindspots", "verdict" (each a non-empty string).',
      "No markdown fences, no extra prose.",
    ].join("\n");
    const reviseUser = "Question: " + query + "\n\nDraft analysis:\n" + answerRaw +
      "\n\nCritique:\n" + critiqueRaw;
    const reviseRaw = await call(reviseSys, reviseUser, 0.7);
    trace.revisePrompt = { system: reviseSys, user: reviseUser };
    trace.reviseRaw = reviseRaw;

    const parsed = parseJudgeResponse(reviseRaw, "verdict");
    const fields = verdictFields(parsed);
    return {
      mode: "M4-single-self-critique", ok: isUsableVerdict(reviseRaw, fields),
      latencyMs: nowMs() - start, apiCalls: 3,
      rawOutput: reviseRaw, parsed, validJson: parsed.kind === "verdict",
      fields, trace,
    };
  } catch (err) {
    return {
      mode: "M4-single-self-critique", ok: false, latencyMs: nowMs() - start, apiCalls: 3,
      rawOutput: "", parsed: null, validJson: false,
      fields: { consensus: "", divergences: "", blindspots: "", verdict: "" },
      trace, error: String(err),
    };
  }
}

/* ------------------------------------------------------------------ *
 * M2 — single-model multi-step (extract → analyze → judge, same model).
 * Replicates the document_analysis pre-stage the hook does inline, then feeds
 * the extracted knowledge into a Panel+Judge run with panelIds=[same model].
 * ------------------------------------------------------------------ */

async function runMode2(
  provider: AIProvider, docText: string, query: string, timeoutMs: number
): Promise<ModeResult> {
  const start = nowMs();
  const trace: Record<string, unknown> = {};
  try {
    // Step 1: extract — one call that turns the doc into structured knowledge.
    const extractPrompt = [
      "Read the document and extract its core structured knowledge as concise notes.",
      "Focus on: key events, core arguments, named entities, and stated lessons.",
      "Output plain text notes, not JSON.",
      "",
      "Document:",
      docText,
    ].join("\n");
    const extractResult = await streamChatWithRetry({
      baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.modelString,
      messages: [{ role: "user", content: extractPrompt }],
      temperature: 0.5, maxTokens: 2048, timeoutMs, protocol: provider.protocol,
    });
    const extracted = extractResult.text;
    trace.extractPrompt = extractPrompt;
    trace.extracted = extracted;
    trace.extractAttempts = extractResult.attempts;

    // Step 2+3: analyze + judge via the real engine, panelIds = [this model].
    // The "panel" analyzes the extracted knowledge; the judge synthesizes.
    const analysisPrompt = [
      "Based on the following extracted knowledge, answer the question.",
      "Output ONLY a JSON object with exactly these four fields:",
      '"consensus", "divergence", "blindspots", "verdict" (each a non-empty string).',
      "No markdown fences, no extra prose.",
      "",
      "Question: " + query,
      "",
      "Extracted knowledge:",
      extracted,
    ].join("\n");
    const judgeSpec = {
      providerId: provider.id,
      systemPrompt: DEFAULT_JUDGE_PROMPTS[0].systemPrompt,
      outputKind: "verdict" as const,
    };
    let panelRaw = "";
    let judgeRaw = "";
    let judgeResp: SynthesisResponse | null = null;
    await runMoaSynthesis(
      {
        prompt: analysisPrompt,
        panelIds: [provider.id],
        panelRoles: {},
        judges: [judgeSpec],
        taskType: "document_analysis",
        temperature: 0.7, maxTokens: 2048, timeoutMs,
      },
      [provider],
      {
        onPanelDone: (_id, text) => { panelRaw = text; },
        onJudgeDone: (_id, resp, raw) => { judgeResp = resp; judgeRaw = raw; },
      }
    );
    trace.panelRaw = panelRaw;
    trace.judgeRaw = judgeRaw;
    const fields = verdictFields(judgeResp);
    return {
      mode: "M2-single-multi-step", ok: true, latencyMs: nowMs() - start, apiCalls: 3,
      rawOutput: judgeRaw, parsed: judgeResp, validJson: judgeResp?.kind === "verdict",
      fields, trace,
    };
  } catch (err) {
    return {
      mode: "M2-single-multi-step", ok: false, latencyMs: nowMs() - start, apiCalls: 3,
      rawOutput: "", parsed: null, validJson: false,
      fields: { consensus: "", divergences: "", blindspots: "", verdict: "" },
      trace, error: String(err),
    };
  }
}

/* ------------------------------------------------------------------ *
 * M3 — multi-model Panel + Judge (the full multi-model pipeline).
 * ------------------------------------------------------------------ */

async function runMode3(
  providers: AIProvider[], panelIds: string[], judgeId: string,
  docText: string, query: string, timeoutMs: number
): Promise<ModeResult> {
  const start = nowMs();
  const trace: Record<string, unknown> = { panelRaw: {} as Record<string, string> };
  try {
    // M3 includes the extract pre-stage too (document_analysis), so the
    // comparison vs M2 is about multi-model panel, not about skipping extract.
    const extractPrompt = [
      "Read the document and extract its core structured knowledge as concise notes.",
      "Focus on: key events, core arguments, named entities, and stated lessons.",
      "Output plain text notes, not JSON.",
      "",
      "Document:",
      docText,
    ].join("\n");
    const firstProvider = providers[0];
    const extractResult = await streamChatWithRetry({
      baseUrl: firstProvider.baseUrl, apiKey: firstProvider.apiKey, model: firstProvider.modelString,
      messages: [{ role: "user", content: extractPrompt }],
      temperature: 0.5, maxTokens: 2048, timeoutMs, protocol: firstProvider.protocol,
    });
    const extracted = extractResult.text;
    trace.extractPrompt = extractPrompt;
    trace.extracted = extracted;
    trace.extractAttempts = extractResult.attempts;

    const analysisPrompt = [
      "Based on the following extracted knowledge, answer the question.",
      "",
      "Question: " + query,
      "",
      "Extracted knowledge:",
      extracted,
    ].join("\n");
    const judgeSpec = {
      providerId: judgeId,
      systemPrompt: DEFAULT_JUDGE_PROMPTS[0].systemPrompt,
      outputKind: "verdict" as const,
    };
    let judgeRaw = "";
    let judgeResp: SynthesisResponse | null = null;
    await runMoaSynthesis(
      {
        prompt: analysisPrompt,
        panelIds,
        panelRoles: {},
        judges: [judgeSpec],
        taskType: "document_analysis",
        temperature: 0.7, maxTokens: 2048, timeoutMs,
      },
      providers,
      {
        onPanelDone: (id, text) => { (trace.panelRaw as Record<string, string>)[id] = text; },
        onJudgeDone: (_id, resp, raw) => { judgeResp = resp; judgeRaw = raw; },
      }
    );
    const fields = verdictFields(judgeResp);
    return {
      mode: "M3-multi-model", ok: true, latencyMs: nowMs() - start,
      apiCalls: 1 + panelIds.length + 1, // extract + panels + judge
      rawOutput: judgeRaw, parsed: judgeResp, validJson: judgeResp?.kind === "verdict",
      fields, trace,
    };
  } catch (err) {
    return {
      mode: "M3-multi-model", ok: false, latencyMs: nowMs() - start,
      apiCalls: 1 + panelIds.length + 1, rawOutput: "", parsed: null, validJson: false,
      fields: { consensus: "", divergences: "", blindspots: "", verdict: "" },
      trace, error: String(err),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Report generation.
 * ------------------------------------------------------------------ */

function writeReport(
  runId: string, caseId: string, docChars: number, sourceNames: string[],
  queryId: string, query: string, results: ModeResult[]
): void {
  // trace.json — full fidelity dump
  writeFileSync(
    join(RESULTS_DIR, `${runId}-${caseId}-${queryId}-trace.json`),
    JSON.stringify({
      runId, caseId, queryId, query, docChars, sourceNames,
      generatedAt: new Date().toISOString(),
      results: results.map((r) => ({
        mode: r.mode, ok: r.ok, latencyMs: r.latencyMs, apiCalls: r.apiCalls,
        validJson: r.validJson, error: r.error,
        fields: r.fields, nonEmptyFields: countNonEmpty(r.fields),
        trace: r.trace,
      })),
    }, null, 2),
    "utf8"
  );

  // report.md — human-readable comparison table
  const lines: string[] = [];
  lines.push(`# Benchmark: ${caseId} / ${queryId}`, "");
  lines.push(`- **Generated**: ${new Date().toISOString()}`);
  lines.push(`- **Sources**: ${sourceNames.join(", ")}`);
  lines.push(`- **Corpus chars**: ${docChars.toLocaleString()}${sourceNames.length > 1 ? ` (multi-doc)` : ""}`);
  lines.push(`- **Query**: ${query}`, "");
  lines.push("## Comparison", "");
  lines.push("| Mode | OK | Latency (s) | API calls | Valid JSON | Fields (0-4) |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      `| ${r.mode} | ${r.ok ? "✅" : "❌"} | ${(r.latencyMs / 1000).toFixed(1)} | ${r.apiCalls} | ${r.validJson ? "✅" : "❌"} | ${countNonEmpty(r.fields)}/4 |`
    );
  }
  lines.push("");
  lines.push("## Field character counts (non-zero = populated)", "");
  lines.push("| Mode | consensus | divergences | blindspots | verdict |");
  lines.push("|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      `| ${r.mode} | ${r.fields.consensus.length} | ${r.fields.divergences.length} | ${r.fields.blindspots.length} | ${r.fields.verdict.length} |`
    );
  }
  lines.push("");
  if (results.some((r) => r.error)) {
    lines.push("## Errors", "");
    for (const r of results) {
      if (r.error) lines.push(`- **${r.mode}**: ${r.error}`, "");
    }
  }
  lines.push("---");
  lines.push(`*Full trace: \`${runId}-${caseId}-${queryId}-trace.json\`*`);
  writeFileSync(
    join(RESULTS_DIR, `${runId}-${caseId}-${queryId}-report.md`),
    lines.join("\n"),
    "utf8"
  );
}

/* ------------------------------------------------------------------ *
 * Summary — aggregate across all cases + answer the 3 key questions.
 * ------------------------------------------------------------------ */

interface CaseResultBundle {
  caseId: string; queryId: string; query: string;
  docChars: number; sourceNames: string[]; results: ModeResult[];
}

function writeSummary(runId: string, bundles: CaseResultBundle[]): void {
  const MODE_ORDER = ["M1-single-shot", "M1R-single-retry", "M2-single-multi-step", "M3-multi-model", "M4-single-self-critique"];
  const present = MODE_ORDER.filter((m) => bundles.some((b) => b.results.some((r) => r.mode === m)));
  const totalCases = bundles.length;

  // Aggregate per mode.
  const agg: Record<string, { lat: number[]; chars: number[]; ok: number; n: number; calls: number }> = {};
  for (const m of present) agg[m] = { lat: [], chars: [], ok: 0, n: 0, calls: 0 };
  for (const b of bundles) {
    for (const r of b.results) {
      if (!agg[r.mode]) continue;
      agg[r.mode].n++;
      agg[r.mode].lat.push(r.latencyMs / 1000);
      // Output chars: only count REAL content (placeholders excluded) so a
      // fallback blob doesn't inflate the richness metric.
      const c = (isPlaceholder(r.fields.consensus) ? 0 : r.fields.consensus.length)
        + (isPlaceholder(r.fields.divergences) ? 0 : r.fields.divergences.length)
        + (isPlaceholder(r.fields.blindspots) ? 0 : r.fields.blindspots.length)
        + (isPlaceholder(r.fields.verdict) ? 0 : r.fields.verdict.length);
      agg[r.mode].chars.push(c);
      // "ok" for reliability = produced a usable verdict (4 real fields,
      // excluding parse placeholders).
      if (countReal(r.fields) === 4) agg[r.mode].ok++;
      agg[r.mode].calls += r.apiCalls;
    }
  }
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  const lines: string[] = [];
  lines.push(`# Benchmark v2 Summary — ${runId}`, "");
  lines.push(`- **Cases**: ${totalCases}`);
  lines.push(`- **Modes present**: ${present.join(", ")}`);
  lines.push(`- **Reliability definition**: a mode "succeeds" on a case if it returns all 4 verdict fields non-empty.`, "");
  lines.push("## Aggregate comparison", "");
  lines.push("| Mode | Success rate | Avg latency (s) | Avg output chars | Total API calls |");
  lines.push("|---|---|---|---|---|");
  for (const m of present) {
    const a = agg[m];
    lines.push(`| ${m} | ${a.ok}/${a.n} (${a.n ? Math.round(a.ok / a.n * 100) : 0}%) | ${avg(a.lat).toFixed(1)} | ${Math.round(avg(a.chars))} | ${a.calls} |`);
  }
  lines.push("");

  // Answer the 3 key questions.
  lines.push("## Key questions", "");
  const successRate = (m: string) => agg[m]?.n ? agg[m].ok / agg[m].n : 0;
  const fmt = (x: number) => `${Math.round(x * 100)}%`;

  // Q1: M1 vs M1R — retry's contribution
  if (agg["M1-single-shot"] && agg["M1R-single-retry"]) {
    const m1 = successRate("M1-single-shot"), m1r = successRate("M1R-single-retry");
    lines.push(`### Q1: How much reliability does retry alone buy? (M1 → M1R)`);
    lines.push(`- M1 (no retry): **${fmt(m1)}** success`);
    lines.push(`- M1R (with retry): **${fmt(m1r)}** success`);
    lines.push(`- Retry's contribution: **+${Math.round((m1r - m1) * 100)} percentage points**.`);
    if (m1r - m1 >= 0.3) {
      lines.push(`- Verdict: retry is a **major** contributor to reliability.`);
    } else {
      lines.push(`- Verdict: retry alone is **insufficient** — pipeline structure contributes more.`);
    }
    lines.push("");
  }
  // Q2: M1R vs M2 — pipeline's marginal contribution
  if (agg["M1R-single-retry"] && agg["M2-single-multi-step"]) {
    const m1r = successRate("M1R-single-retry"), m2 = successRate("M2-single-multi-step");
    lines.push(`### Q2: Does pipeline structure add reliability beyond retry? (M1R → M2)`);
    lines.push(`- M1R (retry, no pipeline): **${fmt(m1r)}**`);
    lines.push(`- M2 (extract→analyze→judge pipeline): **${fmt(m2)}**`);
    lines.push(`- Pipeline's marginal contribution: **+${Math.round((m2 - m1r) * 100)} percentage points**.`);
    lines.push("");
  }
  // Q3: M4 vs M3 — self-critique vs multi-model
  if (agg["M4-single-self-critique"] && agg["M3-multi-model"]) {
    const m3 = successRate("M3-multi-model"), m4 = successRate("M4-single-self-critique");
    const m3chars = avg(agg["M3-multi-model"].chars), m4chars = avg(agg["M4-single-self-critique"].chars);
    lines.push(`### Q3: Does single-model self-critique match multi-model? (M4 vs M3)`);
    lines.push(`- M3 (multi-model Panel+Judge): **${fmt(m3)}** success, avg ${Math.round(m3chars)} chars`);
    lines.push(`- M4 (single-model self-critique): **${fmt(m4)}** success, avg ${Math.round(m4chars)} chars`);
    const charRatio = m3chars > 0 ? m4chars / m3chars : 0;
    if (Math.abs(m3 - m4) < 0.15 && charRatio > 0.8) {
      lines.push(`- Verdict: M4 ≈ M3 — **single-model self-critique may suffice**; multi-model fan-out's marginal value is questionable.`);
    } else if (m3 > m4 + 0.15) {
      lines.push(`- Verdict: M3 > M4 — **multi-model still meaningfully better** than self-critique.`);
    } else {
      lines.push(`- Verdict: mixed — reliability comparable but output richness differs (M3/M4 char ratio ${charRatio.toFixed(2)}).`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Per-case reports: \`${runId}-<case>-<query>-report.md\` and \`*-trace.json\`*`);
  writeFileSync(join(RESULTS_DIR, `${runId}-SUMMARY.md`), lines.join("\n"), "utf8");
}

/* ------------------------------------------------------------------ *
 * Main.
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  // Modes:
  //   (default)  INCREMENTAL — run M1R+M4, merge prior M1/M2/M3
  //   --full     re-run all five modes in one batch
  //   --remediate — re-run ONLY M2+M3 (e.g. after fixing an extract-retry bug),
  //                overwriting their traces in place. Used to regenerate usable
  //                M2/M3 outputs for quality grading without touching M1/M1R/M4.
  const fullRun = process.argv.includes("--full");
  const remediate = process.argv.includes("--remediate");

  const env = parseEnv();
  const p1 = buildProvider(env, "", "bench-provider-1");
  const p2 = buildProvider(env, "2", "bench-provider-2");
  if (!p1) {
    console.error("✗ VITE_VERDEX_PROVIDER_* not set in .env — cannot run benchmark.");
    process.exit(1);
  }
  const providers = p2 ? [p1, p2] : [p1];
  console.log(`▶ Loaded ${providers.length} provider(s): ${providers.map((p) => p.name).join(", ")}`);
  const modeLabel = fullRun ? "FULL (all 5 modes)"
    : remediate ? "REMEDIATE (M2+M3 only, overwrite prior traces)"
    : "INCREMENTAL (M1R+M4 only, merge prior M1/M2/M3)";
  console.log(`▶ Mode: ${modeLabel}`);

  const { cases, docs } = loadSamples();
  console.log(`▶ Loaded ${cases.length} case(s) from bench-samples/`);

  const timeoutMs = Number(env.VITE_VERDEX_REQUEST_TIMEOUT_MS) || 360000;
  // In remediate mode, write into the SAME run id as the v1 baseline so the
  // updated M2/M3 traces replace the broken ones in place.
  const runId = remediate
    ? "2026-08-01T19-50-03"
    : new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // In incremental mode, locate the most recent prior run that has M1/M2/M3
  // traces, so we can merge its results into the 5-mode report.
  const priorRunId = (!fullRun && !remediate) ? findPriorRunId(cases) : null;
  if (!fullRun && !remediate && priorRunId) {
    console.log(`▶ Merging prior M1/M2/M3 data from run ${priorRunId}`);
  } else if (!fullRun) {
    console.log("⚠ No prior M1/M2/M3 trace found — report will only show M1R/M4.");
  }

  const allCaseResults: { caseId: string; queryId: string; query: string; docChars: number; sourceNames: string[]; results: ModeResult[] }[] = [];

  for (const c of cases) {
    const { text: corpusText, sourceNames } = caseCorpus(c, docs);
    const multiLabel = sourceNames.length > 1 ? ` [multi-doc ×${sourceNames.length}]` : "";
    for (const q of c.queries) {
      console.log(`\n=== Case "${c.id}" / query "${q.id}"${multiLabel} ===`);
      console.log(`  Corpus: ${corpusText.length.toLocaleString()} chars from ${sourceNames.join(", ")}`);
      console.log(`  Q: ${q.text.slice(0, 80)}...`);

      const results: ModeResult[] = [];

      if (remediate) {
        // Re-run only M2 and M3 (with the fixed extract-retry), overwriting
        // their entries in this case's trace. M1/M1R/M4 are left untouched.
        console.log("  ▷ M2 single-model multi-step (extract-retry fix)...");
        results.push(await runMode2(p1, corpusText, q.text, timeoutMs));
        console.log(`    ✓ ${results.at(-1)!.ok ? "ok" : "FAILED"} in ${(results.at(-1)!.latencyMs / 1000).toFixed(1)}s`);

        if (p2) {
          console.log("  ▷ M3 multi-model Panel+Judge (extract-retry fix)...");
          results.push(await runMode3(providers, [p1.id, p2.id], p1.id, corpusText, q.text, timeoutMs));
          console.log(`    ✓ ${results.at(-1)!.ok ? "ok" : "FAILED"} in ${(results.at(-1)!.latencyMs / 1000).toFixed(1)}s`);
        }
        // Merge: load M1 from prior trace, keep fresh M2/M3 (skip M1R/M4).
        const prior = loadPriorResults(runId, c.id, q.id).filter((r) => r.mode === "M1-single-shot");
        writeReport(runId, c.id, corpusText.length, sourceNames, q.id, q.text, [...prior, ...results]);
        console.log(`  ▶ Remediated trace written: bench-results/${runId}-${c.id}-${q.id}-trace.json`);
        continue;
      }

      if (fullRun) {
        console.log("  ▷ M1 single-model single-shot...");
        results.push(await runMode1(p1, corpusText, q.text, timeoutMs));
        console.log(`    ✓ ${results.at(-1)!.ok ? "ok" : "FAILED"} in ${(results.at(-1)!.latencyMs / 1000).toFixed(1)}s`);

        console.log("  ▷ M2 single-model multi-step...");
        results.push(await runMode2(p1, corpusText, q.text, timeoutMs));
        console.log(`    ✓ ${results.at(-1)!.ok ? "ok" : "FAILED"} in ${(results.at(-1)!.latencyMs / 1000).toFixed(1)}s`);

        if (p2) {
          console.log("  ▷ M3 multi-model Panel+Judge...");
          results.push(await runMode3(providers, [p1.id, p2.id], p1.id, corpusText, q.text, timeoutMs));
          console.log(`    ✓ ${results.at(-1)!.ok ? "ok" : "FAILED"} in ${(results.at(-1)!.latencyMs / 1000).toFixed(1)}s`);
        }
      } else if (priorRunId) {
        // Merge prior M1/M2/M3 results for this case/query.
        const prior = loadPriorResults(priorRunId, c.id, q.id);
        if (prior.length > 0) {
          console.log(`  ▷ Loaded ${prior.length} prior mode(s) from ${priorRunId}`);
          results.push(...prior);
        }
      }

      console.log("  ▷ M1R single-model single-shot + retry...");
      results.push(await runMode1R(p1, corpusText, q.text, timeoutMs));
      console.log(`    ✓ ${results.at(-1)!.ok ? "ok" : "FAILED"} in ${(results.at(-1)!.latencyMs / 1000).toFixed(1)}s (${results.at(-1)!.apiCalls} call(s))`);

      console.log("  ▷ M4 single-model self-critique...");
      results.push(await runMode4(p1, corpusText, q.text, timeoutMs));
      console.log(`    ✓ ${results.at(-1)!.ok ? "ok" : "FAILED"} in ${(results.at(-1)!.latencyMs / 1000).toFixed(1)}s`);

      writeReport(runId, c.id, corpusText.length, sourceNames, q.id, q.text, results);
      console.log(`  ▶ Report written to bench-results/${runId}-${c.id}-${q.id}-report.md`);
      allCaseResults.push({ caseId: c.id, queryId: q.id, query: q.text, docChars: corpusText.length, sourceNames, results });
    }
  }

  if (remediate) {
    console.log(`\n✓ Remediation complete. M2/M3 traces overwritten in run ${runId}.`);
    console.log(`  Re-run grading-pack generation to use the fresh outputs.`);
    return;
  }

  writeSummary(runId, allCaseResults);
  console.log(`\n✓ Benchmark complete. Summary: bench-results/${runId}-SUMMARY.md`);
}

/** Find the most recent prior run id (by scanning trace filenames). */
function findPriorRunId(cases: SampleCase[]): string | null {
  try {
    const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith("-trace.json"));
    // Need a run that has at least M1 (single-shot) traces for our cases.
    const runIds = new Set<string>();
    for (const f of files) {
      // filename: <runId>-<case>-<query>-trace.json
      const rest = f.slice(0, -"-trace.json".length);
      // runId is the leading timestamp (ends before the first case id).
      for (const c of cases) {
        const marker = `-${c.id}-`;
        const idx = rest.indexOf(marker);
        if (idx > 0) {
          runIds.add(rest.slice(0, idx));
          break;
        }
      }
    }
    // Pick the lexicographically largest (most recent) run that contains
    // an M1-single-shot result (the v1 baseline).
    const sorted = [...runIds].sort().reverse();
    for (const rid of sorted) {
      for (const c of cases) {
        const t = loadPriorResults(rid, c.id, c.queries[0]?.id ?? "");
        if (t.some((r) => r.mode === "M1-single-shot")) return rid;
      }
    }
    return sorted[0] ?? null;
  } catch {
    return null;
  }
}

/** Load prior mode results (M1/M2/M3) for one case/query from a prior trace.json. */
function loadPriorResults(priorRunId: string, caseId: string, queryId: string): ModeResult[] {
  const path = join(RESULTS_DIR, `${priorRunId}-${caseId}-${queryId}-trace.json`);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { results: unknown[] };
    const out: ModeResult[] = [];
    for (const r of raw.results) {
      const item = r as Record<string, unknown>;
      const mode = String(item.mode ?? "");
      // Only carry forward the original three modes (skip any M1R/M4 from a
      // prior incremental run to avoid duplicates).
      if (mode === "M1-single-shot" || mode === "M2-single-multi-step" || mode === "M3-multi-model") {
        out.push(modeResultFromTrace(item));
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Reconstruct a ModeResult from a serialized trace object. */
function modeResultFromTrace(item: Record<string, unknown>): ModeResult {
  const f = (item.fields ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    mode: String(item.mode ?? ""),
    ok: Boolean(item.ok),
    latencyMs: Number(item.latencyMs ?? 0),
    apiCalls: Number(item.apiCalls ?? 0),
    rawOutput: str(item.rawOutput),
    parsed: null,
    validJson: Boolean(item.validJson),
    fields: {
      consensus: str(f.consensus),
      divergences: str(f.divergences),
      blindspots: str(f.blindspots),
      verdict: str(f.verdict),
    },
    trace: item.trace ?? {},
    error: typeof item.error === "string" ? item.error : undefined,
  };
}

main().catch((err) => {
  console.error("✗ Benchmark failed:", err);
  process.exit(1);
});

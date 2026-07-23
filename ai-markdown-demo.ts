// AI-to-Markdown pricing prototype (chunking direction #4 — "expensive but effective").
//
// NOT production code. The goal is a REAL NUMBER for Doug: how long does an LLM
// document-cleanup pass take, what would it cost per document on a paid API, and is
// the resulting structure actually better than our current heuristic PDF parse?
//
// Pipeline compared:
//   messy PDF  ──▶  raw text extract (no layout)  ──▶  Ollama qwen2.5:7b-instruct
//                                                        "rewrite as clean markdown"
//                                                          ──▶ parse ──▶ chunk        (AI path)
//   messy PDF  ──▶  parsePdf() [layout-aware, uses font sizes]  ──▶ chunk             (heuristic path, "before")
//
// The heuristic gets font metadata the LLM never sees; if the LLM still matches or
// beats it from raw text alone, that's the interesting result.
//
// Run:  node --import tsx ai-markdown-demo.ts ["<pdf filename in content/>" | all]
import * as fs from 'fs';
import * as path from 'path';
import { parsePdf } from './src/parser/pdf.js';
import { parseMarkdown } from './src/parser/markdown.js';
import { chunkDocument, estimateTokens, type Chunk } from './src/chunker/chunker.js';

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[0m';
const G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', M = '\x1b[35m';
const p = (s = '') => console.log(s);
const rule = () => p(D + '─'.repeat(66) + R);

const CONTENT_DIR = path.resolve('content');
const OLLAMA = 'http://localhost:11434/api/generate';
const MODEL = 'qwen2.5:7b-instruct';
const CHUNK_CFG = { maxTokens: 512, overlap: 64 };

// Representative public API prices ($/1M tokens), input/output. Sourced from the
// claude-api skill (2026-07). Ollama is self-hosted → $0 marginal; these price what
// the SAME token volume WOULD cost if the cleanup ran on a hosted small/mid model.
const PRICES: Record<string, { in: number; out: number }> = {
  'Claude Haiku 4.5': { in: 1.0, out: 5.0 },
  'Claude Sonnet 5': { in: 3.0, out: 15.0 },
};

/** Naive text extraction — concatenate every text item, no layout reconstruction.
 *  This is the "messy" input: reading order is roughly preserved, structure is not. */
async function extractRawText(buffer: Buffer): Promise<{ text: string; pages: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer), useWorkerFetch: false, isEvalSupported: false, disableFontFace: true,
  }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const { items } = await page.getTextContent({ includeMarkedContent: false });
    out += items.map((it: any) => ('str' in it ? it.str : '')).join(' ') + '\n';
  }
  return { text: out.replace(/[ \t]{2,}/g, ' ').trim(), pages: doc.numPages };
}

const CLEANUP_PROMPT = (raw: string) =>
`You are a document-cleaning tool. The text below was extracted from a PDF, so its structure (headings, lists, paragraph breaks) has been flattened or garbled. Rewrite it as clean, well-structured GitHub-Flavored Markdown.

Rules:
- Infer the heading hierarchy (#, ##, ###) from the document's structure.
- Use bullet or numbered lists where the text is clearly a list.
- Rejoin lines that were split mid-sentence; separate real paragraphs with a blank line.
- Preserve ALL of the original wording and facts. Do NOT summarize, add, or omit content.
- Output ONLY the Markdown. Do not wrap the whole document in a code fence and do not add commentary.

--- RAW EXTRACTED TEXT ---
${raw}`;

interface OllamaResult {
  markdown: string;
  promptTok: number;   // input tokens (model's own tokenizer)
  genTok: number;      // output tokens
  totalS: number;      // wall-clock incl. model load (cold)
  loadS: number;       // model load portion
  evalS: number;       // generation portion (the marginal cost, warm)
  promptEvalS: number; // prompt ingest portion
}

async function ollamaCleanup(raw: string, numCtx: number): Promise<OllamaResult> {
  // Stream the response. With stream:false, Ollama sends no HTTP headers until the
  // whole generation finishes, so a multi-minute doc trips Node's ~300s fetch headers
  // timeout (UND_ERR_HEADERS_TIMEOUT). Streaming makes bytes flow continuously, and the
  // final NDJSON line carries the timing/token counts.
  const body = {
    model: MODEL,
    prompt: CLEANUP_PROMPT(raw),
    stream: true,
    options: { num_ctx: numCtx, temperature: 0.2 },
  };
  const res = await fetch(OLLAMA, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok || !res.body) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);

  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let final: any = {};
  for await (const chunk of res.body as any) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const obj = JSON.parse(line);
      if (obj.response) text += obj.response;
      if (obj.done) final = obj;
    }
  }
  const ns = 1e9;
  let md = text.trim();
  md = md.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  return {
    markdown: md,
    promptTok: final.prompt_eval_count ?? 0,
    genTok: final.eval_count ?? 0,
    totalS: (final.total_duration ?? 0) / ns,
    loadS: (final.load_duration ?? 0) / ns,
    evalS: (final.eval_duration ?? 0) / ns,
    promptEvalS: (final.prompt_eval_duration ?? 0) / ns,
  };
}

interface Structure { headings: number; h1: number; chunks: number; avgTok: number; sampleHeadings: string[]; }

function analyze(sections: Array<{ headingPath: string[]; content: string }>, chunks: Chunk[]): Structure {
  const headingSet = new Set<string>();
  let h1 = 0;
  for (const s of sections) {
    for (let i = 0; i < s.headingPath.length; i++) {
      const h = s.headingPath[i];
      if (h) { headingSet.add(h); if (i === 0) h1++; }
    }
  }
  const uniqH1 = new Set(sections.map(s => s.headingPath[0]).filter(Boolean));
  const avg = chunks.length ? Math.round(chunks.reduce((a, c) => a + c.tokenCount, 0) / chunks.length) : 0;
  const sample = [...headingSet].slice(0, 6);
  return { headings: headingSet.size, h1: uniqH1.size, chunks: chunks.length, avgTok: avg, sampleHeadings: sample };
}

function money(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
}

async function runOne(file: string) {
  const full = path.join(CONTENT_DIR, file);
  const buffer = fs.readFileSync(full);
  const title = path.basename(file, path.extname(file));

  p();
  rule();
  p('  ' + C + B + 'AI-TO-MARKDOWN — cost & quality vs the heuristic PDF parse' + R);
  p('  ' + D + file + R);
  rule();

  // --- messy input ---
  const { text: raw, pages } = await extractRawText(buffer);
  const rawWords = raw.split(/\s+/).filter(Boolean).length;
  p();
  p(`  ${B}Messy input${R}  ${D}(raw text extraction, no layout)${R}`);
  p(`    pages ${B}${pages}${R}   words ${B}${rawWords}${R}`);
  p(`    ${D}"${raw.replace(/\n/g, ' ').slice(0, 120)}…"${R}`);

  // --- heuristic path (current pipeline) ---
  const heur = await parsePdf(buffer);
  const heurChunks = chunkDocument(heur.sections, CHUNK_CFG, title);
  const hs = analyze(heur.sections, heurChunks);

  // --- AI path ---
  const estInputTok = Math.ceil(rawWords * 1.4);
  const numCtx = Math.min(32768, Math.max(4096, Math.ceil((estInputTok * 2.5 + 512) / 2048) * 2048));
  p();
  p(`  ${M}Calling ${MODEL} (num_ctx=${numCtx})… generating, please wait${R}`);
  const ai = await ollamaCleanup(raw, numCtx);
  const aiParsed = parseMarkdown(ai.markdown);
  const aiChunks = chunkDocument(aiParsed.sections, CHUNK_CFG, title);
  const as = analyze(aiParsed.sections, aiChunks);

  // --- structure comparison ---
  p();
  p(`  ${B}Structure  (before → after)${R}`);
  p(`    ${'headings detected'.padEnd(22)} ${Y}${String(hs.headings).padStart(4)}${R}  →  ${G}${String(as.headings).padStart(4)}${R}`);
  p(`    ${'top-level sections'.padEnd(22)} ${Y}${String(hs.h1).padStart(4)}${R}  →  ${G}${String(as.h1).padStart(4)}${R}`);
  p(`    ${'chunks produced'.padEnd(22)} ${Y}${String(hs.chunks).padStart(4)}${R}  →  ${G}${String(as.chunks).padStart(4)}${R}`);
  p(`    ${'avg tokens / chunk'.padEnd(22)} ${Y}${String(hs.avgTok).padStart(4)}${R}  →  ${G}${String(as.avgTok).padStart(4)}${R}`);
  p();
  p(`    ${D}heuristic headings:${R} ${hs.sampleHeadings.map(h => Y + h + R).join(D + ' · ' + R) || D + '(none)' + R}`);
  p(`    ${D}AI headings:       ${R} ${as.sampleHeadings.map(h => G + h + R).join(D + ' · ' + R) || D + '(none)' + R}`);

  // --- before/after snippet ---
  p();
  p(`  ${B}What the LLM did  (first ~380 chars)${R}`);
  p(`    ${Y}RAW  ▸${R} ${D}${raw.replace(/\n/g, ' ').slice(0, 380)}…${R}`);
  p(`    ${G}MD   ▸${R} ${ai.markdown.slice(0, 380).replace(/\n/g, '\n            ')}…`);

  // --- the numbers Doug asked for ---
  const perKWordS = ai.evalS / (rawWords / 1000);
  p();
  p(`  ${B}⏱  Latency  (local, on this Mac)${R}`);
  p(`    total (cold, incl. model load) ${B}${ai.totalS.toFixed(1)}s${R}   ${D}load ${ai.loadS.toFixed(1)}s${R}`);
  p(`    generation (warm, marginal)    ${B}${ai.evalS.toFixed(1)}s${R}   ${D}(${(ai.genTok / ai.evalS).toFixed(1)} tok/s)${R}`);
  p(`    normalized                     ${B}${perKWordS.toFixed(1)}s${R} ${D}per 1,000 input words${R}`);

  p();
  p(`  ${B}🧾  Tokens & cost  (per document)${R}`);
  p(`    input ${B}${ai.promptTok}${R} tok   output ${B}${ai.genTok}${R} tok`);
  p(`    local Ollama:  ${G}$0.00${R} ${D}(self-hosted — you pay compute/time, not per token)${R}`);
  for (const [name, pr] of Object.entries(PRICES)) {
    const cost = (ai.promptTok / 1e6) * pr.in + (ai.genTok / 1e6) * pr.out;
    p(`    if on ${name.padEnd(16)} ${B}${money(cost)}${R} ${D}/doc   (${money(cost / (rawWords / 1000))}/1k words)${R}`);
  }
  rule();

  return { file, pages, rawWords, ai, hs, as, perKWordS };
}

async function main() {
  // Reachability check.
  try {
    await fetch('http://localhost:11434/api/tags');
  } catch {
    p(`${B}Ollama not reachable at localhost:11434.${R} Start it with:  ${C}ollama serve${R}`);
    process.exit(1);
  }

  const arg = process.argv[2];
  const allPdfs = fs.readdirSync(CONTENT_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
  let files: string[];
  if (arg === 'all') {
    // Smallest first, so we still get data if a large doc runs long.
    files = allPdfs.sort((a, b) =>
      fs.statSync(path.join(CONTENT_DIR, a)).size - fs.statSync(path.join(CONTENT_DIR, b)).size);
  } else if (arg) files = [arg];
  else files = ['IOMSC-WG-Mental Health-V3 4.29.26.pdf']; // default: one representative WG doc

  const results = [];
  for (const f of files) {
    try {
      results.push(await runOne(f));
    } catch (e) {
      p(`  ${D}skipped ${f}: ${(e as Error).message}${R}`);
    }
  }

  if (results.length > 1) {
    p();
    p('  ' + C + B + 'SUMMARY — per-document cost/latency (extrapolate from here)' + R);
    rule();
    p(`    ${'document'.padEnd(30)} ${'words'.padStart(6)} ${'warm s'.padStart(7)} ${'in tok'.padStart(7)} ${'out tok'.padStart(7)} ${'Haiku'.padStart(8)}`);
    for (const r of results) {
      const cost = (r.ai.promptTok / 1e6) * PRICES['Claude Haiku 4.5'].in + (r.ai.genTok / 1e6) * PRICES['Claude Haiku 4.5'].out;
      p(`    ${r.file.slice(0, 30).padEnd(30)} ${String(r.rawWords).padStart(6)} ${r.ai.evalS.toFixed(0).padStart(7)} ${String(r.ai.promptTok).padStart(7)} ${String(r.ai.genTok).padStart(7)} ${money(cost).padStart(8)}`);
    }
    const avgPerK = results.reduce((a, r) => a + r.perKWordS, 0) / results.length;
    p();
    p(`    ${D}avg generation: ${B}${avgPerK.toFixed(1)}s${R}${D} per 1,000 input words (local, warm)${R}`);
    rule();
  }
}

main().catch(e => { console.error(e); process.exit(1); });

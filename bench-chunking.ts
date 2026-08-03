// Chunking benchmark v2 — whole-corpus retrieval, several configs as rows (directional).
//
// Answers two questions with numbers:
//   (a) did our shipped #1 (filename-in-chunk) actually help retrieval?
//   (b) does prompt-engineering rescue the AI-to-markdown path (which lost naively)?
//
// Realistic setup: pool EVERY doc's chunks into one index and retrieve across the
// whole corpus (so a question can pull the wrong doc — which is exactly where the
// filename signal earns its keep). Everything constant except the config under test;
// same fixed question set for all. Fully offline (qwen2.5:7b + nomic-embed).
// Small-N, local 7B judge → DIRECTIONAL, not publication-grade.
//
// Run:  node --import tsx bench-chunking.ts
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { parsePdf } from './src/parser/pdf.js';
import { parseMarkdown } from './src/parser/markdown.js';
import { chunkDocument, type Chunk } from './src/chunker/chunker.js';

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[0m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', M = '\x1b[35m', RED_C = '\x1b[31m';
const p = (s = '') => console.log(s);
const rule = () => p(D + '─'.repeat(74) + R);

const CONTENT = path.resolve('content');
const SCRATCH = '/private/tmp/claude-501/-Users-jonathanlocala-ozwell/b9317cf8-a496-43c1-b54f-5bf4de9b7650/scratchpad';
const GEN = 'http://localhost:11434/api/generate';
const EMB = 'http://localhost:11434/api/embeddings';
const GEN_MODEL = 'qwen2.5:7b-instruct';
const EMB_MODEL = 'nomic-embed-text';
const CHUNK_CFG = { maxTokens: 512, overlap: 64 };
const TOPK = 4;
const QPER = 4;

const DOCS = [
  'IOMSC-WG-Climate Change-V2 4.29.26.pdf',
  'IOMSC-WG-Mental Health-V3 4.29.26.pdf',
  'IOMSC-WG-Business Plan-V4 4.29.26.pdf',
];

// Pre-computed Unlimited-OCR output (crop mode, Colab T4 — validated ≈ HF Space quality).
const OCR_DIR = path.resolve('ocr-gundam-results');

/**
 * Shim: Unlimited-OCR emits layout-text with NO markdown headings — its section titles
 * are ALL-CAPS lines. Promote runs of ALL-CAPS lines to `##` headings so the chunker can
 * build sections; drop <PAGE> markers, image refs, and standalone page numbers. This
 * heading-inference step IS a real integration cost of adopting this model (logged for Doug).
 */
function ocrToMarkdown(raw: string): string {
  const out: string[] = [];
  let head: string[] = [];
  const flush = () => { if (head.length) { out.push('## ' + head.join(' '), ''); head = []; } };
  const isHeadingLine = (t: string): boolean => {
    const letters = t.replace(/[^A-Za-z]/g, '');
    return letters.length >= 2 && t.length <= 70 && letters === letters.toUpperCase();
  };
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t === '<PAGE>' || /^!\[\]/.test(t) || /^\d{1,3}$/.test(t)) { flush(); continue; }
    if (isHeadingLine(t)) { head.push(t); continue; }
    flush();
    out.push(t, ''); // blank line after each body line preserves OCR's paragraph-per-line
  }
  flush();
  return out.join('\n');
}

function ocrMarkdown(title: string): string {
  const folder = 'gundam_' + title.slice(0, 24).replace(/ /g, '_');
  return ocrToMarkdown(fs.readFileSync(path.join(OCR_DIR, folder, 'FULL.md'), 'utf8'));
}

// The configs (rows). All with #1 filename on = the fair head-to-head of PARSERS:
// current heuristic vs cheap-LLM rewrite vs specialized OCR (Unlimited-OCR, crop mode).
// 'claude' == Haiku 4.5 (kept as-is so existing rewrite cache keys stay valid).
type Cfg = { id: string; parser: 'heuristic' | 'ai' | 'ocr'; prompt?: 'naive' | 'constrained'; rewriteModel?: 'qwen' | 'claude' | 'sonnet'; filename: boolean };
const CONFIGS: Cfg[] = [
  { id: 'heuristic (current)', parser: 'heuristic', filename: true },
  { id: 'ai-md qwen7b (naive)', parser: 'ai', prompt: 'naive', rewriteModel: 'qwen', filename: true },
  { id: 'ai-md haiku4.5 (naive)', parser: 'ai', prompt: 'naive', rewriteModel: 'claude', filename: true },
  { id: 'ai-md sonnet5 (naive)', parser: 'ai', prompt: 'naive', rewriteModel: 'sonnet', filename: true },
  { id: 'unlimited-ocr (crop)', parser: 'ocr', filename: true },
];

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
function loadJson<T>(f: string, dflt: T): T { try { return JSON.parse(fs.readFileSync(path.join(SCRATCH, f), 'utf8')); } catch { return dflt; } }
function saveJson(f: string, v: unknown) { fs.writeFileSync(path.join(SCRATCH, f), JSON.stringify(v)); }
const rewriteCache = loadJson<Record<string, string>>('bench-rewrites.json', {});
const qCache = loadJson<Record<string, Q[]>>('bench-questions.json', {});
const embCache = loadJson<Record<string, number[]>>('bench-emb.json', {});
const genCache = loadJson<Record<string, string>>('bench-gen.json', {});

async function gen(prompt: string, opts: { temperature?: number; numPredict?: number; numCtx?: number } = {}): Promise<string> {
  const temp = opts.temperature ?? 0;
  // Deterministic calls (temp 0: answers, judging, question-gen) are cached so a re-run —
  // or a crash after scoring — costs nothing. Rewrites (temp>0) have their own cache.
  const key = sha(`${GEN_MODEL}|${temp}|${opts.numPredict ?? 200}|${prompt}`);
  if (temp === 0 && genCache[key] !== undefined) return genCache[key];
  const body = { model: GEN_MODEL, prompt, stream: true, options: { temperature: temp, num_predict: opts.numPredict ?? 200, num_ctx: opts.numCtx ?? 8192 } };
  const res = await fetch(GEN, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok || !res.body) throw new Error(`gen HTTP ${res.status}`);
  const dec = new TextDecoder(); let buf = '', text = '';
  for await (const chunk of res.body as any) {
    buf += dec.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) { const o = JSON.parse(line); if (o.response) text += o.response; } }
  }
  const result = text.trim();
  if (temp === 0) { genCache[key] = result; saveJson('bench-gen.json', genCache); }
  return result;
}
async function embed(text: string): Promise<number[]> {
  const key = sha(EMB_MODEL + '::' + text);
  if (embCache[key]) return embCache[key];
  const res = await fetch(EMB, { method: 'POST', body: JSON.stringify({ model: EMB_MODEL, prompt: text }) });
  embCache[key] = (await res.json() as any).embedding;
  return embCache[key];
}
function cosine(a: number[], b: number[]): number { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9); }

async function extractRawText(buffer: Buffer): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) { const { items } = await (await doc.getPage(i)).getTextContent({ includeMarkedContent: false }); out += items.map((it: any) => ('str' in it ? it.str : '')).join(' ') + '\n'; }
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

const NAIVE_PROMPT = (raw: string) => `Rewrite the raw PDF-extracted text below as clean GitHub-Flavored Markdown: infer #/##/### headings, use lists where appropriate, rejoin split lines, separate paragraphs. Preserve ALL wording and facts — do not summarize, add, or omit. Output ONLY the markdown, no surrounding code fence.\n\n${raw}`;
const CONSTRAINED_PROMPT = (raw: string) => `Rewrite the raw PDF-extracted text below as clean GitHub-Flavored Markdown. STRICT rules:
- Use ONLY two heading levels: # for the document title, ## for major sections. Never use ### or deeper.
- A heading is a SHORT label of 2–6 words. NEVER turn a sentence into a heading. If a line reads like a sentence, it is body text, not a heading.
- Preserve EVERY sentence of the original. Do not drop, shorten, paraphrase away, or summarize any content — keep the wording.
- Rejoin lines split mid-sentence; separate real paragraphs with a blank line; use "- " bullets only for genuine lists.
Output ONLY the markdown, no surrounding code fence.\n\n${raw}`;

async function aiMarkdown(file: string, raw: string, variant: 'naive' | 'constrained', model: 'qwen' | 'claude' | 'sonnet' = 'qwen'): Promise<string> {
  const key = `${file}::${variant}::${model}`;
  if (rewriteCache[key]) return rewriteCache[key];
  const words = raw.split(/\s+/).length;
  const numCtx = Math.min(32768, Math.max(4096, Math.ceil((words * 1.4 * 2.5 + 512) / 2048) * 2048));
  const prompt = variant === 'constrained' ? CONSTRAINED_PROMPT(raw) : NAIVE_PROMPT(raw);
  let md = model === 'qwen'
    ? await gen(prompt, { temperature: 0.2, numPredict: -1, numCtx })
    : await claudeGen(prompt, 8192, model === 'sonnet' ? SONNET_MODEL : CLAUDE_MODEL);
  md = md.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  rewriteCache[key] = md; saveJson('bench-rewrites.json', rewriteCache);
  return md;
}

interface Q { question: string; answer: string; passage: string; }
function segments(raw: string, n: number): string[] {
  const w = raw.split(/\s+/).filter(Boolean); const size = Math.floor(w.length / (n + 1)); const segs: string[] = [];
  for (let i = 1; i <= n; i++) segs.push(w.slice(i * size, i * size + size).join(' '));
  return segs;
}
function extractJson(s: string): any | null { const m = s.match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }
async function makeQuestions(file: string, raw: string): Promise<Q[]> {
  if (qCache[file]) return qCache[file];
  const qs: Q[] = [];
  for (const passage of segments(raw, QPER)) {
    const out = await gen(`From the passage below, write ONE specific, factual question answerable ONLY from this passage, plus a concise answer taken from it. Return strict JSON: {"question":"...","answer":"..."}.\n\nPASSAGE:\n${passage.slice(0, 1200)}`, { numPredict: 200 });
    const j = extractJson(out); if (j?.question && j?.answer) qs.push({ question: String(j.question), answer: String(j.answer), passage });
  }
  qCache[file] = qs; saveJson('bench-questions.json', qCache);
  return qs;
}

// Referee (reader + judge): use Claude Haiku when a key is present, else local qwen.
// Only these two roles change — the question set stays the cached local one, so the
// upgrade isolates "does a stronger referee separate the parsers the 7B couldn't?".
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';  // the referee (judge + reader)
const SONNET_MODEL = 'claude-sonnet-5';            // stronger rewriter tier
const USE_CLAUDE = !!process.env.ANTHROPIC_API_KEY;

async function claudeGen(prompt: string, maxTokens: number, model: string = CLAUDE_MODEL): Promise<string> {
  const key = sha(`${model}|${maxTokens}|${prompt}`);
  if (genCache[key]) return genCache[key]; // truthy: never serve a cached empty result
  const call = async (withTemp: boolean) => {
    const body: any = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
    if (withTemp) body.temperature = 0;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json() as any;
  };
  // temperature is deprecated on newer models (e.g. Sonnet 5) — retry without it.
  let j = await call(true);
  if (j.error && /temperature/i.test(j.error.message ?? '')) j = await call(false);
  if (j.error) throw new Error(`Claude ${j.error.type}: ${j.error.message}`);
  // Newer models (Sonnet 5) prepend a `thinking` block, so content[0] is NOT the answer.
  // Collect every text block instead of assuming the first one.
  const text = (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
  if (!text) throw new Error(`Claude returned no text (stop_reason=${j.stop_reason}, blocks=${(j.content ?? []).map((b: any) => b.type).join(',')})`);
  genCache[key] = text; saveJson('bench-gen.json', genCache);
  return text;
}

async function ragAnswer(question: string, ctx: string): Promise<string> {
  const prompt = `Answer the question using ONLY the context. If the answer is not in the context, reply exactly "NOT FOUND".\n\nCONTEXT:\n${ctx}\n\nQUESTION: ${question}\nANSWER:`;
  return USE_CLAUDE ? claudeGen(prompt, 200) : gen(prompt, { numPredict: 160 });
}
async function judge(question: string, gold: string, cand: string): Promise<number> {
  const prompt = `Score how well the CANDIDATE answer matches the REFERENCE for this question, 1-5 (5 = fully correct & complete, 1 = wrong/missing). Reply with ONLY the digit.\n\nQUESTION: ${question}\nREFERENCE: ${gold}\nCANDIDATE: ${cand}\nSCORE:`;
  const out = USE_CLAUDE ? await claudeGen(prompt, 8) : await gen(prompt, { numPredict: 4 });
  const m = out.match(/[1-5]/); return m ? Number(m[0]) : 1;
}

// Build the full pooled corpus for one config: chunks from every doc + their embeddings.
async function buildCorpus(cfg: Cfg, docTexts: Array<{ file: string; title: string; buffer: Buffer; raw: string }>): Promise<{ chunks: Chunk[]; embs: number[][] }> {
  const chunks: Chunk[] = [];
  for (const d of docTexts) {
    const title = cfg.filename ? d.title : undefined;
    let sections;
    if (cfg.parser === 'heuristic') sections = (await parsePdf(d.buffer)).sections;
    else if (cfg.parser === 'ocr') sections = parseMarkdown(ocrMarkdown(d.title)).sections;
    else sections = parseMarkdown(await aiMarkdown(d.file, d.raw, cfg.prompt!, cfg.rewriteModel ?? 'qwen')).sections;
    chunks.push(...chunkDocument(sections, CHUNK_CFG, title));
  }
  if (chunks.length === 0) throw new Error(`config "${cfg.id}" produced ZERO chunks — parser/rewrite output was empty or unparseable`);
  const embs: number[][] = [];
  for (const c of chunks) embs.push(await embed(c.embeddingText));
  saveJson('bench-emb.json', embCache);
  return { chunks, embs };
}

interface Score { answer: number; answerable: number; retrieval: number; chunks: number }
async function scoreCorpus(cfg: Cfg, corpus: { chunks: Chunk[]; embs: number[][] }, questions: Array<Q & { qEmb: number[]; passEmb: number[] }>): Promise<Score> {
  let sum = 0, answerable = 0, hits = 0;
  for (const q of questions) {
    const ranked = corpus.embs.map((e, i) => ({ i, s: cosine(q.qEmb, e) })).sort((a, b) => b.s - a.s);
    const top = ranked.slice(0, TOPK).map(x => x.i);
    const home = corpus.embs.map((e, i) => ({ i, s: cosine(q.passEmb, e) })).sort((a, b) => b.s - a.s)[0].i;
    if (top.includes(home)) hits++;
    const ans = await ragAnswer(q.question, top.map(i => corpus.chunks[i].content).join('\n---\n'));
    if (!/NOT FOUND/i.test(ans)) answerable++;
    sum += await judge(q.question, q.answer, ans);
    process.stdout.write(D + '.' + R);
  }
  p(D + ` ${cfg.id}` + R);
  const n = questions.length;
  return { answer: sum / n, answerable: answerable / n, retrieval: hits / n, chunks: corpus.chunks.length };
}

async function main() {
  try { await fetch('http://localhost:11434/api/tags'); } catch { p('Ollama not reachable'); process.exit(1); }
  p(); rule();
  p('  ' + C + B + 'CHUNKING BENCHMARK v2 — whole-corpus retrieval' + R);
  p('  ' + D + `${DOCS.length} docs · ${QPER} Q/doc · top-${TOPK} · referee: ${USE_CLAUDE ? CLAUDE_MODEL : GEN_MODEL} · embed ${EMB_MODEL}` + R);
  rule();

  // Load docs + fixed question set (cached).
  const docTexts = [];
  const questions: Array<Q & { qEmb: number[]; passEmb: number[] }> = [];
  for (const file of DOCS) {
    const buffer = fs.readFileSync(path.join(CONTENT, file));
    const raw = await extractRawText(buffer);
    docTexts.push({ file, title: path.basename(file, path.extname(file)), buffer, raw });
    for (const q of await makeQuestions(file, raw)) questions.push({ ...q, qEmb: await embed(q.question), passEmb: await embed(q.passage) });
  }
  saveJson('bench-emb.json', embCache);
  p(`  ${D}${questions.length} questions loaded${R}\n`);

  const results: Array<{ cfg: Cfg; s: Score }> = [];
  for (const cfg of CONFIGS) {
    p(`  ${B}${cfg.id}${R} ${D}— building corpus…${R}`);
    const corpus = await buildCorpus(cfg, docTexts);
    const s = await scoreCorpus(cfg, corpus, questions);
    results.push({ cfg, s });
  }

  p(); rule();
  p('  ' + C + B + `LEADERBOARD  (${questions.length} questions, whole-corpus retrieval)` + R);
  rule();
  p(`    ${'config'.padEnd(28)} ${'answer/5'.padStart(9)} ${'answerable'.padStart(11)} ${'retr@' + TOPK} ${'chunks'.padStart(7)}`);
  for (const { cfg, s } of results) {
    const col = cfg.parser === 'ocr' ? G : cfg.parser === 'ai' ? M : Y;
    p(`    ${col}${cfg.id.padEnd(24)}${R} ${s.answer.toFixed(2).padStart(9)} ${(s.answerable * 100).toFixed(0).padStart(10)}% ${(s.retrieval * 100).toFixed(0).padStart(6)}% ${String(s.chunks).padStart(7)}`);
  }
  rule();
  const get = (id: string) => results.find(r => r.cfg.id.startsWith(id))?.s.answer ?? NaN;
  const heur = get('heuristic');
  const d2 = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
  p('    ' + D + 'vs the current heuristic parser:' + R);
  for (const [label, id] of [
    ['qwen-7B rewrite', 'ai-md qwen7b'],
    ['Haiku 4.5 rewrite', 'ai-md haiku4.5'],
    ['Sonnet 5 rewrite', 'ai-md sonnet5'],
    ['Unlimited-OCR', 'unlimited-ocr'],
  ] as const) {
    const v = get(id);
    if (!Number.isNaN(v)) {
      const d = v - heur;
      p(`      ${(label + ':').padEnd(20)} ${d > 0 ? G : d < 0 ? RED_C : D}${B}${d2(d)}${R} answer/5`);
    }
  }
  rule();
}

main().catch(e => { console.error(e); process.exit(1); });

/**
 * Cross-corpus evaluation against the E3C corpus (issue #15).
 *
 * eval-negex.ts validates negation on Chapman's NegEx set. This runs the SAME engine
 * over a DIFFERENT corpus — the English portion of E3C (Magnini et al.), 84 hand-
 * annotated clinical documents — for two reasons:
 *
 *   1. Cross-corpus negation check — E3C labels ~456 negated events, independent of
 *      NegEx. If our F1 holds here too, the NegEx number wasn't overfit to one corpus.
 *   2. Hypothetical validation — E3C is the one accessible English corpus that labels
 *      the hypothetical axis (contextualModality = HYPOTHETICAL-*), which NegEx doesn't.
 *      This is the first real check of our temporality engine's hypothetical detection.
 *
 * E3C events carry char offsets (begin/end) into the document text plus `polarity`
 * (POS/NEG) and `contextualModality` (ACTUAL / HEDGED / HYPOTHETICAL-IF / -OTHER /
 * GENERIC). We feed each event span straight into the engine — no concept-locating.
 *
 * Data (CC BY-NC, NOT vendored) — fetch once:
 *   mkdir -p data/e3c_en && for f in $(curl -s \
 *     "https://api.github.com/repos/hltfbk/E3C-Corpus/git/trees/main?recursive=1" \
 *     | grep -oE 'data_annotation/English/layer1/[^"]*\.xml'); do \
 *     curl -sL "https://raw.githubusercontent.com/hltfbk/E3C-Corpus/main/$f" \
 *       -o "data/e3c_en/$(basename $f)"; done
 *
 * Run:  node --import tsx src/assertion/eval-e3c.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { applyContext } from './context.js';
import { applyTemporality } from './temporality.js';

const DATA_DIR = new URL('../../data/e3c_en/', import.meta.url);

interface E3CEvent {
  text: string;
  begin: number;
  end: number;
  polarity: string; // POS | NEG
  modality: string; // ACTUAL | HEDGED | HYPOTHETICAL-IF | HYPOTHETICAL-OTHER | GENERIC
  sofa: string; // the full document text this event indexes into
}

/** Undo XML entity escaping so offsets line up with UIMA's character counting. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&'); // last, so we don't double-unescape
}

function parseFile(xml: string): E3CEvent[] {
  const sofaMatch = xml.match(/sofaString="([^"]*)"/);
  if (!sofaMatch) return [];
  const sofa = unescapeXml(sofaMatch[1]);

  const events: E3CEvent[] = [];
  for (const m of xml.matchAll(/<custom:EVENT\b[^>]*>/g)) {
    const tag = m[0];
    const begin = Number(tag.match(/\bbegin="(\d+)"/)?.[1]);
    const end = Number(tag.match(/\bend="(\d+)"/)?.[1]);
    const polarity = tag.match(/\bpolarity="([^"]*)"/)?.[1] ?? '';
    const modality = tag.match(/\bcontextualModality="([^"]*)"/)?.[1] ?? '';
    if (Number.isNaN(begin) || Number.isNaN(end)) continue;
    events.push({ text: sofa.slice(begin, end), begin, end, polarity, modality, sofa });
  }
  return events;
}

function loadEvents(): E3CEvent[] {
  let files: string[];
  try {
    files = readdirSync(DATA_DIR).filter(f => f.endsWith('.xml'));
  } catch {
    console.error('\n  E3C not found at data/e3c_en/. See fetch command in the file header.\n');
    process.exit(1);
  }
  const all: E3CEvent[] = [];
  for (const f of files) all.push(...parseFile(readFileSync(new URL(f, DATA_DIR), 'utf8')));
  return all;
}

const p2 = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);

// --- run ---
const events = loadEvents();

// Self-check: confirm offsets align (spans should be real words, not mid-token garbage).
console.log(`\nE3C English — ${events.length} annotated events across 84 documents\n`);
console.log('  Offset self-check (5 negated events — span text should read cleanly):');
for (const e of events.filter(e => e.polarity === 'NEG').slice(0, 5)) {
  const ctx = e.sofa.slice(Math.max(0, e.begin - 22), e.end + 8).replace(/\s+/g, ' ');
  console.log(`    "${e.text}"  in  …${ctx}…`);
}

// === NEGATION axis (cross-corpus) ===
let tp = 0, fp = 0, fn = 0, correct = 0;
for (const e of events) {
  const gold = e.polarity === 'NEG';
  const pred = applyContext(e.sofa, e.begin, e.end)?.status === 'absent';
  if (pred === gold) correct++;
  if (pred && gold) tp++;
  if (pred && !gold) fp++;
  if (!pred && gold) fn++;
}
const prec = tp + fp === 0 ? 0 : tp / (tp + fp);
const rec = tp + fn === 0 ? 0 : tp / (tp + fn);
const f1 = prec + rec === 0 ? 0 : (2 * prec * rec) / (prec + rec);
const negTotal = events.filter(e => e.polarity === 'NEG').length;

console.log('\n  === NEGATION axis — cross-corpus check ===\n');
console.log(`  ${events.length} events, ${negTotal} negated (vs NegEx: 491)`);
console.log(`  accuracy : ${p2(correct, events.length)}   precision: ${p2(tp, tp + fp)}   recall: ${p2(tp, tp + fn)}   F1: ${p2(2 * tp, 2 * tp + fp + fn)}`);
console.log(`  (NegEx was P 95.1 / R 98.0 / F1 96.5 — does it hold on a different corpus?)`);
void f1;

// === HYPOTHETICAL axis (first real validation) ===
const hypRows = events.filter(e => e.modality.startsWith('HYPOTHETICAL'));
let hypHit = 0;
for (const e of hypRows) {
  if (applyTemporality([], e.sofa, e.begin, e.end).temporality === 'hypothetical') hypHit++;
}
let hypFP = 0;
const nonHyp = events.filter(e => !e.modality.startsWith('HYPOTHETICAL'));
for (const e of nonHyp) {
  if (applyTemporality([], e.sofa, e.begin, e.end).temporality === 'hypothetical') hypFP++;
}
console.log('\n  === HYPOTHETICAL axis — first English validation ===\n');
console.log(`  Hypothetical recall : ${p2(hypHit, hypRows.length)} (${hypHit}/${hypRows.length})`);
console.log(`  False-hypothetical  : ${p2(hypFP, nonHyp.length)} (${hypFP}/${nonHyp.length})`);
console.log('  (small sample — a first signal, not a definitive number)\n');

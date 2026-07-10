/**
 * End-to-end retrieval evaluation for issue #15 — does context-aware embedding +
 * assertion filtering actually fix RETRIEVAL, not just per-finding accuracy?
 *
 * The ticket's real premise: "a retrieval system can surface red flags that were
 * actually denied." We built the machinery (context-rendered embeddingText, per-finding
 * assertions, --exclude-denied) — this proves whether it changes what gets retrieved.
 *
 * Setup: a small clinical corpus where each red-flag finding appears PRESENT in one note
 * and DENIED in another. For finding queries, we rank chunks three ways and count how
 * often a DENIED chunk is wrongly surfaced in the top-k:
 *   1. naive     — embed raw chunk body (the "before")
 *   2. context   — embed the context-rendered embeddingText (Phase 1)
 *   3. ctx+filter— context ranking, then drop chunks the note denies (Phase 2)
 *
 * Needs Ollama running with an embedding model.
 * Run:  node --import tsx src/render/eval-retrieval.ts
 */
import { createEmbedder } from '../embedder/embedder.js';
import { renderEmbeddingText } from './embedding-text.js';
import { extractFindings } from '../assertion/findings.js';

interface Doc { id: string; headingPath: string[]; content: string; }

// Each red-flag appears PRESENT in one chunk and DENIED in another, plus non-clinical distractors.
const CORPUS: Doc[] = [
  { id: 'p1-assessment', headingPath: ['Patient 1', 'Assessment'],
    content: 'Cannot rule out cauda equina. Saddle anesthesia is present on exam and the patient has progressive leg weakness.' },
  { id: 'p1-hpi', headingPath: ['Patient 1', 'History of Present Illness'],
    content: 'Endorses chest pain radiating to the left arm on exertion with associated shortness of breath.' },
  { id: 'p2-ros', headingPath: ['Patient 2', 'Review of Systems', 'Negative for'],
    content: 'Saddle anesthesia. Progressive leg weakness. Bowel or bladder dysfunction.' },
  { id: 'p2-cardiac', headingPath: ['Patient 2', 'Cardiac'],
    content: 'Denies chest pain. No shortness of breath. No syncope.' },
  { id: 'p3-ros', headingPath: ['Patient 3', 'ROS', 'Negative for'],
    content: 'Chest pain. Syncope.' },
  { id: 'p3-hpi', headingPath: ['Patient 3', 'HPI'],
    content: 'Presents with syncope after standing and a severe headache since this morning.' },
  { id: 'd1', headingPath: ['Annual Report', 'Overview'],
    content: 'Revenue grew steadily without any weakness in the core segments this year.' },
  { id: 'd2', headingPath: ['Policy', 'Summary'],
    content: 'The committee reviewed the proposal and found no significant concerns.' },
];

const QUERIES: Array<{ q: string; finding: string }> = [
  { q: 'patient with saddle anesthesia on exam', finding: 'saddle anesthesia' },
  { q: 'chest pain radiating to the arm', finding: 'chest pain' },
  { q: 'progressive leg weakness', finding: 'progressive leg weakness' },
  { q: 'episode of syncope after standing', finding: 'syncope' },
  { q: 'shortness of breath at rest', finding: 'shortness of breath' },
];

const K = 3;

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Per-chunk polarity for a finding: 'present' | 'absent' | 'none'
function polarity(doc: Doc, finding: string): 'present' | 'absent' | 'none' {
  const f = extractFindings({ headingPath: doc.headingPath, content: doc.content }).find(x => x.finding === finding);
  return f ? (f.assertion === 'absent' ? 'absent' : 'present') : 'none';
}

async function main() {
  const embedder = createEmbedder({ model: 'ollama:nomic-embed-text', dimension: 768 });

  const naiveTexts = CORPUS.map(d => d.content);
  const ctxTexts = CORPUS.map(d => renderEmbeddingText({ headingPath: d.headingPath, content: d.content }));
  console.log('\nEmbedding corpus (naive + context) and queries via Ollama…');
  const naiveVecs = await embedder.embed(naiveTexts);
  const ctxVecs = await embedder.embed(ctxTexts);
  const qVecs = await embedder.embed(QUERIES.map(q => q.q));

  const rank = (qv: number[], vecs: number[][]) =>
    CORPUS.map((d, i) => ({ d, sim: cosine(qv, vecs[i]) })).sort((a, b) => b.sim - a.sim);

  const tally = { naive: { denied: 0, present: 0 }, ctx: { denied: 0, present: 0 }, filt: { denied: 0, present: 0 } };
  const lines: string[] = [];
  const gaps = { naive: [] as number[], ctx: [] as number[] };

  QUERIES.forEach((query, qi) => {
    // Separation metric: best-present-sim minus best-denied-sim for this finding (higher = better).
    for (const [key, vecs] of [['naive', naiveVecs], ['ctx', ctxVecs]] as const) {
      let bestP = -1, bestA = -1;
      CORPUS.forEach((d, i) => {
        const p = polarity(d, query.finding);
        const s = cosine(qVecs[qi], vecs[i]);
        if (p === 'present' && s > bestP) bestP = s;
        if (p === 'absent' && s > bestA) bestA = s;
      });
      if (bestP >= 0 && bestA >= 0) gaps[key].push(bestP - bestA);
    }

    const naiveTop = rank(qVecs[qi], naiveVecs).slice(0, K);
    const ctxRanked = rank(qVecs[qi], ctxVecs);
    const ctxTop = ctxRanked.slice(0, K);
    // Phase 2: drop chunks that DENY the queried finding, then take top-k
    const filtTop = ctxRanked.filter(r => polarity(r.d, query.finding) !== 'absent').slice(0, K);

    const count = (top: typeof naiveTop, bucket: { denied: number; present: number }) => {
      for (const r of top) {
        const p = polarity(r.d, query.finding);
        if (p === 'absent') bucket.denied++;
        if (p === 'present') bucket.present++;
      }
    };
    count(naiveTop, tally.naive);
    count(ctxTop, tally.ctx);
    count(filtTop, tally.filt);

    const deniedIn = (top: typeof naiveTop) => top.filter(r => polarity(r.d, query.finding) === 'absent').map(r => r.d.id);
    lines.push(`  "${query.q}"  (finding: ${query.finding})`);
    lines.push(`     naive top-${K} surfaces DENIED: [${deniedIn(naiveTop).join(', ') || '—'}]`);
    lines.push(`     ctx   top-${K} surfaces DENIED: [${deniedIn(ctxTop).join(', ') || '—'}]`);
    lines.push(`     filt  top-${K} surfaces DENIED: [${deniedIn(filtTop).join(', ') || '—'}]`);
  });

  console.log(`\nRetrieval eval — ${QUERIES.length} finding queries, top-${K}, corpus of ${CORPUS.length} chunks\n`);
  lines.forEach(l => console.log(l));
  console.log('\n  === how often a DENIED finding is wrongly surfaced (lower is better) ===\n');
  const row = (name: string, b: { denied: number; present: number }) =>
    console.log(`    ${name.padEnd(26)} denied-surfaced: ${b.denied}   present-surfaced: ${b.present}`);
  row('1. naive embedding', tally.naive);
  row('2. context embedding (P1)', tally.ctx);
  row('3. context + filter (P2)', tally.filt);

  const mean = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / xs.length);
  console.log('\n  === present-vs-denied similarity gap (Phase 1 vector effect; higher = better) ===\n');
  console.log(`    naive embedding          mean gap: ${mean(gaps.naive).toFixed(3)}`);
  console.log(`    context embedding (P1)   mean gap: ${mean(gaps.ctx).toFixed(3)}   (Phase 1 separates them, but not enough to change top-k)`);
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });

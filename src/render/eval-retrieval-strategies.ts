/**
 * Experiment (issue #15): can a stronger, assertion-AWARE embedding-text rendering make
 * Phase 1 sufficient on its own — i.e. push denied red-flags OUT of the top-k without
 * needing the Phase 2 filter?
 *
 * Baseline rendering prepends one polarity line. Here we use the per-finding assertion
 * (from the engine) to rewrite the embedding text more aggressively, and measure whether
 * any strategy fixes retrieval geometry. Uses the same corpus/queries as eval-retrieval.ts.
 *
 * Needs Ollama. Run:  node --import tsx src/render/eval-retrieval-strategies.ts
 */
import { createEmbedder } from '../embedder/embedder.js';
import { renderEmbeddingText } from './embedding-text.js';
import { extractFindings } from '../assertion/findings.js';

interface Doc { id: string; headingPath: string[]; content: string; }

const CORPUS: Doc[] = [
  { id: 'p1-assessment', headingPath: ['Patient 1', 'Assessment'], content: 'Cannot rule out cauda equina. Saddle anesthesia is present on exam and the patient has progressive leg weakness.' },
  { id: 'p1-hpi', headingPath: ['Patient 1', 'History of Present Illness'], content: 'Endorses chest pain radiating to the left arm on exertion with associated shortness of breath.' },
  { id: 'p2-ros', headingPath: ['Patient 2', 'Review of Systems', 'Negative for'], content: 'Saddle anesthesia. Progressive leg weakness. Bowel or bladder dysfunction.' },
  { id: 'p2-cardiac', headingPath: ['Patient 2', 'Cardiac'], content: 'Denies chest pain. No shortness of breath. No syncope.' },
  { id: 'p3-ros', headingPath: ['Patient 3', 'ROS', 'Negative for'], content: 'Chest pain. Syncope.' },
  { id: 'p3-hpi', headingPath: ['Patient 3', 'HPI'], content: 'Presents with syncope after standing and a severe headache since this morning.' },
  { id: 'd1', headingPath: ['Annual Report', 'Overview'], content: 'Revenue grew steadily without any weakness in the core segments this year.' },
  { id: 'd2', headingPath: ['Policy', 'Summary'], content: 'The committee reviewed the proposal and found no significant concerns.' },
];
const QUERIES = [
  { q: 'patient with saddle anesthesia on exam', finding: 'saddle anesthesia' },
  { q: 'chest pain radiating to the arm', finding: 'chest pain' },
  { q: 'progressive leg weakness', finding: 'progressive leg weakness' },
  { q: 'episode of syncope after standing', finding: 'syncope' },
  { q: 'shortness of breath at rest', finding: 'shortness of breath' },
];
const K = 3;

const cosine = (a: number[], b: number[]) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / (Math.sqrt(x) * Math.sqrt(y) || 1);
};
const heading = (d: Doc) => `Section: ${d.headingPath.join(' > ')}.`;
const finds = (d: Doc) => extractFindings({ headingPath: d.headingPath, content: d.content });
const polarity = (d: Doc, f: string) => {
  const x = finds(d).find(y => y.finding === f);
  return x ? (x.assertion === 'absent' ? 'absent' : 'present') : 'none';
};

// --- rendering strategies (doc -> embedding text) ---
const STRATEGIES: Record<string, (d: Doc) => string> = {
  'A baseline (current)': d => renderEmbeddingText({ headingPath: d.headingPath, content: d.content }),

  'B assertion-tagged': d => {
    const tags = finds(d).map(f => `${f.finding} is ${f.assertion === 'absent' ? 'absent' : 'present'}.`).join(' ');
    return `${heading(d)}\n${d.content}\n${tags}`;
  },

  'C rewritten as no-X': d => {
    const fs = finds(d);
    if (!fs.length) return `${heading(d)}\n${d.content}`;
    const phrases = fs.map(f => (f.assertion === 'absent' ? `no ${f.finding}` : `${f.finding} present`)).join(', ');
    return `${heading(d)}\nClinical findings: ${phrases}.`;
  },

  'D strong segregation': d => {
    const fs = finds(d);
    const absent = fs.filter(f => f.assertion === 'absent').map(f => f.finding);
    const present = fs.filter(f => f.assertion !== 'absent').map(f => f.finding);
    let s = `${heading(d)}\n${d.content}`;
    if (present.length) s += `\nPresent findings: ${present.join(', ')}.`;
    if (absent.length) s += `\nThe patient does NOT have: ${absent.join(', ')}. Absent: ${absent.join(', ')}.`;
    return s;
  },
};

async function main() {
  const embedder = createEmbedder({ model: 'ollama:nomic-embed-text', dimension: 768 });
  const qVecs = await embedder.embed(QUERIES.map(q => q.q));

  console.log(`\nRendering-strategy experiment — top-${K}, ${QUERIES.length} queries, ${CORPUS.length} chunks\n`);
  console.log('  strategy                     denied-surfaced   present-surfaced   sep-gap');
  console.log('  ' + '-'.repeat(74));

  for (const [name, render] of Object.entries(STRATEGIES)) {
    const vecs = await embedder.embed(CORPUS.map(render));
    let denied = 0, present = 0;
    const gaps: number[] = [];
    QUERIES.forEach((query, qi) => {
      const ranked = CORPUS.map((d, i) => ({ d, sim: cosine(qVecs[qi], vecs[i]) })).sort((a, b) => b.sim - a.sim);
      for (const r of ranked.slice(0, K)) {
        const p = polarity(r.d, query.finding);
        if (p === 'absent') denied++;
        if (p === 'present') present++;
      }
      let bp = -1, ba = -1;
      ranked.forEach(r => {
        const p = polarity(r.d, query.finding);
        if (p === 'present' && r.sim > bp) bp = r.sim;
        if (p === 'absent' && r.sim > ba) ba = r.sim;
      });
      if (bp >= 0 && ba >= 0) gaps.push(bp - ba);
    });
    const gap = (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(3);
    console.log(`  ${name.padEnd(28)} ${String(denied).padStart(9)}${String(present).padStart(18)}${gap.padStart(11)}`);
  }
  console.log('\n  denied-surfaced: lower is better (0 = Phase 1 alone fixed it) · sep-gap: higher is better\n');
}
main().catch(e => { console.error(e); process.exit(1); });

/**
 * Did the dictionary expansion actually improve retrieval? (issue #15)
 *
 * Queries use findings that were NOT in the old 11-finding list. We compare the Phase 2
 * filter under the OLD dictionary (simulated: only the original 11 are known) vs the NEW
 * expanded dictionary — measuring how often a DENIED finding is wrongly surfaced.
 *
 * Needs Ollama. Run:  node --import tsx src/render/eval-retrieval-expansion.ts
 */
import { createEmbedder } from '../embedder/embedder.js';
import { extractFindings } from '../assertion/findings.js';

interface Doc { id: string; headingPath: string[]; content: string; }

const CORPUS: Doc[] = [
  { id: 'pA-hpi', headingPath: ['Patient A', 'History of Present Illness'], content: 'The patient presents with acute pancreatitis, melena, and a high fever.' },
  { id: 'pA-gu', headingPath: ['Patient A', 'Genitourinary'], content: 'The patient reports gross hematuria for two days.' },
  { id: 'pB-ros', headingPath: ['Patient B', 'Review of Systems', 'Negative for'], content: 'Pancreatitis. Melena. Fever. Hematuria.' },
  { id: 'pB-note', headingPath: ['Patient B', 'Note'], content: 'The patient denies pancreatitis and denies any melena or hematuria.' },
  { id: 'd1', headingPath: ['Annual Report', 'Overview'], content: 'The quarter ran a high fever of activity with no weakness in revenue.' },
  { id: 'd2', headingPath: ['Policy'], content: 'The committee found no cause for concern.' },
];
const QUERIES = [
  { q: 'patient with acute pancreatitis', finding: 'pancreatitis' },
  { q: 'melena / dark stools', finding: 'melena' },
  { q: 'high fever', finding: 'fever' },
  { q: 'gross hematuria', finding: 'hematuria' },
];
const K = 3;
// The original 11-finding list (what the filter "knew" before the expansion).
const OLD_11 = new Set(['saddle anesthesia', 'bowel or bladder dysfunction', 'progressive leg weakness',
  'chest pain', 'shortness of breath', 'suicidal ideation', 'hemoptysis', 'syncope',
  'severe headache', 'vision loss', 'focal neurological deficit']);

const cosine = (a: number[], b: number[]) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / (Math.sqrt(x) * Math.sqrt(y) || 1);
};
// polarity of a finding in a chunk; `known` limits which findings the dictionary can see.
function polarity(doc: Doc, finding: string, known?: Set<string>): 'present' | 'absent' | 'none' {
  if (known && !known.has(finding)) return 'none'; // old dictionary was blind to it
  const f = extractFindings({ headingPath: doc.headingPath, content: doc.content }).find(x => x.finding === finding);
  return f ? (f.assertion === 'absent' ? 'absent' : 'present') : 'none';
}

async function main() {
  const embedder = createEmbedder({ model: 'ollama:nomic-embed-text', dimension: 768 });
  const vecs = await embedder.embed(CORPUS.map(d => d.content));
  const qVecs = await embedder.embed(QUERIES.map(q => q.q));

  const counts = { naive: 0, oldFilter: 0, newFilter: 0 };
  QUERIES.forEach((query, qi) => {
    const ranked = CORPUS.map((d, i) => ({ d, sim: cosine(qVecs[qi], vecs[i]) })).sort((a, b) => b.sim - a.sim);
    const deniedInTop = (known?: Set<string>) =>
      ranked.filter(r => polarity(r.d, query.finding, known) !== 'absent').slice(0, K)
        .filter(r => polarity(r.d, query.finding) === 'absent').length;
    counts.naive += ranked.slice(0, K).filter(r => polarity(r.d, query.finding) === 'absent').length;
    counts.oldFilter += deniedInTop(OLD_11);   // filter with only the original 11
    counts.newFilter += deniedInTop();          // filter with the full expanded dictionary
  });

  console.log(`\nDictionary-expansion retrieval retest — ${QUERIES.length} queries for PREVIOUSLY-UNKNOWN findings, top-${K}\n`);
  console.log('  (queries: pancreatitis, melena, fever, hematuria — none were in the old 11)\n');
  console.log(`    1. naive (no filter)                denied-surfaced: ${counts.naive}`);
  console.log(`    2. filter, OLD 11-finding dict      denied-surfaced: ${counts.oldFilter}   (blind to these findings)`);
  console.log(`    3. filter, NEW expanded dict        denied-surfaced: ${counts.newFilter}`);
  console.log('\n  lower is better; the OLD dict can\'t protect findings it never knew about.\n');
}
main().catch(e => { console.error(e); process.exit(1); });

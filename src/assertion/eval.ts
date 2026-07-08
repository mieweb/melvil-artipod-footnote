/**
 * Assertion evaluation harness (issue #15).
 *
 * Runs the per-finding extraction over a labeled set of clinical sentences and reports
 * accuracy, so "does it work?" becomes a number instead of a spot check. It also runs a
 * deliberately NAIVE baseline (a bare negation-word scan with no direction, scope, or
 * pseudo-negation handling) to show what the ConText-style engine buys us.
 *
 * Run:  node --import tsx src/assertion/eval.ts
 *
 * NOTE: this labeled set is small and hand-written — a real evaluation needs a licensed
 * clinical corpus (i2b2 / MIMIC). This establishes the harness and a baseline number.
 */
import { extractFindings } from './findings.js';
import type { AssertionStatus } from './assertion.js';

interface Case {
  content: string;
  finding: string;
  expected: AssertionStatus;
  headingPath?: string[];
  note?: string;
}

// Labeled cases. `finding` must be a curated high-risk finding (canonical name).
const CASES: Case[] = [
  // --- present ---
  { content: 'Patient complains of chest pain radiating to the arm.', finding: 'chest pain', expected: 'present' },
  { content: 'She reports progressive leg weakness over two weeks.', finding: 'progressive leg weakness', expected: 'present' },
  { content: 'Positive for hemoptysis this morning.', finding: 'hemoptysis', expected: 'present' },
  { content: 'The patient presents with syncope after standing.', finding: 'syncope', expected: 'present' },
  { content: 'Endorses a severe headache since yesterday.', finding: 'severe headache', expected: 'present' },
  { content: 'Chest pain is severe and ongoing.', finding: 'chest pain', expected: 'present' },

  // --- absent (forward negation) ---
  { content: 'Patient denies chest pain.', finding: 'chest pain', expected: 'absent' },
  { content: 'There is no saddle anesthesia on exam.', finding: 'saddle anesthesia', expected: 'absent' },
  { content: 'Negative for hemoptysis.', finding: 'hemoptysis', expected: 'absent' },
  { content: 'No evidence of focal neurological deficit.', finding: 'focal neurological deficit', expected: 'absent' },
  { content: 'The patient is without shortness of breath at rest.', finding: 'shortness of breath', expected: 'absent' },
  { content: 'Denies suicidal ideation.', finding: 'suicidal ideation', expected: 'absent' },

  // --- absent (backward / post-position) ---
  { content: 'Chest pain, now resolved.', finding: 'chest pain', expected: 'absent' },
  { content: 'Saddle anesthesia was denied by the patient.', finding: 'saddle anesthesia', expected: 'absent' },

  // --- possible (uncertainty) ---
  { content: 'Cannot rule out chest pain of cardiac origin.', finding: 'chest pain', expected: 'possible' },
  { content: 'r/o hemoptysis; will get imaging.', finding: 'hemoptysis', expected: 'possible' },
  { content: 'Possible focal neurological deficit noted.', finding: 'focal neurological deficit', expected: 'possible' },
  { content: 'Likely syncope versus seizure.', finding: 'syncope', expected: 'possible' },

  // --- historical ---
  { content: 'History of syncope, none recently.', finding: 'syncope', expected: 'historical' },
  { content: 'h/o chest pain on exertion.', finding: 'chest pain', expected: 'historical' },
  { content: 'Prior vision loss in the left eye.', finding: 'vision loss', expected: 'historical' },

  // --- cross-sentence / mixed (direction + scope matter) ---
  { content: 'Denies chest pain. Reports new hemoptysis.', finding: 'hemoptysis', expected: 'present', note: 'cross-sentence' },
  { content: 'Denies chest pain. Reports new hemoptysis.', finding: 'chest pain', expected: 'absent', note: 'cross-sentence' },
  { content: 'Denies chest pain but reports progressive leg weakness.', finding: 'progressive leg weakness', expected: 'present', note: 'mixed' },
  { content: 'Denies chest pain but reports progressive leg weakness.', finding: 'chest pain', expected: 'absent', note: 'mixed' },

  // --- pseudo-negation (contains a negation word, but not a negation) ---
  { content: 'There is no increase in chest pain.', finding: 'chest pain', expected: 'present', note: 'pseudo-negation' },
  { content: 'No change in her chronic severe headache.', finding: 'severe headache', expected: 'present', note: 'pseudo-negation' },
  { content: 'Not only chest pain but also hemoptysis.', finding: 'chest pain', expected: 'present', note: 'pseudo-negation' },

  // --- heading-driven (bare mention under a Negative-for section) ---
  { content: 'Saddle anesthesia', finding: 'saddle anesthesia', expected: 'absent', headingPath: ['Review of Systems', 'Negative for'], note: 'heading' },
  { content: 'Progressive leg weakness', finding: 'progressive leg weakness', expected: 'absent', headingPath: ['Review of Systems', 'Negative for'], note: 'heading' },

  // --- adversarial / known-hard: cases we EXPECT the lightweight engine to struggle
  //     with. These are what would motivate a fuller ConText/medspaCy implementation. ---
  { content: 'There is no evidence to suggest absence of chest pain.', finding: 'chest pain', expected: 'present', note: 'HARD: double negation' },
  { content: 'Chest pain cannot be excluded.', finding: 'chest pain', expected: 'possible', note: 'HARD: unlisted uncertainty phrase' },
  { content: 'This is unlikely to be chest pain.', finding: 'chest pain', expected: 'possible', note: 'HARD: "unlikely" not a cue' },
  { content: 'Mother has a history of syncope; the patient does not.', finding: 'syncope', expected: 'absent', note: 'HARD: experiencer (family, not patient)' },
  { content: 'Chest pain was noted early in the visit, and after an extended and rather meandering discussion, it was ultimately ruled out.', finding: 'chest pain', expected: 'absent', note: 'HARD: negation beyond the scope window' },
];

// Deliberately naive baseline: any negation word anywhere → absent (no direction, no
// scope, no pseudo-negation, can't express possible/historical). Represents the "before".
const NAIVE_NEG = /\b(no|not|denies|denied|negative|without|resolved|ruled out|absent)\b/i;
function naivePredict(c: Case): AssertionStatus {
  return NAIVE_NEG.test(c.content) ? 'absent' : 'present';
}

function enginePredict(c: Case): AssertionStatus {
  const found = extractFindings({ headingPath: c.headingPath ?? ['Assessment'], content: c.content })
    .find(f => f.finding === c.finding);
  return found?.assertion ?? 'present';
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}% (${n}/${d})`;
}

// --- run ---
let naiveCorrect = 0;
let engineCorrect = 0;
const byExpected = new Map<AssertionStatus, { correct: number; total: number }>();
const misses: string[] = [];
const engineWins: string[] = [];

for (const c of CASES) {
  const naive = naivePredict(c);
  const engine = enginePredict(c);
  if (naive === c.expected) naiveCorrect++;
  if (engine === c.expected) engineCorrect++;

  const bucket = byExpected.get(c.expected) ?? { correct: 0, total: 0 };
  bucket.total++;
  if (engine === c.expected) bucket.correct++;
  byExpected.set(c.expected, bucket);

  if (engine !== c.expected) {
    misses.push(`   ✗ [${c.expected} → got ${engine}] "${c.content}" (${c.finding})`);
  } else if (naive !== c.expected) {
    engineWins.push(`   ✓ engine right, naive wrong [${c.expected}] "${c.content}"${c.note ? ` — ${c.note}` : ''}`);
  }
}

console.log(`\nAssertion eval — ${CASES.length} labeled per-finding cases\n`);
console.log(`  Naive baseline accuracy : ${pct(naiveCorrect, CASES.length)}`);
console.log(`  ConText engine accuracy : ${pct(engineCorrect, CASES.length)}\n`);

console.log('  Engine accuracy by expected status:');
for (const status of ['present', 'absent', 'possible', 'historical'] as AssertionStatus[]) {
  const b = byExpected.get(status);
  if (b) console.log(`    ${status.padEnd(11)} ${pct(b.correct, b.total)}`);
}

if (engineWins.length) {
  console.log(`\n  Where the engine beats the naive baseline (${engineWins.length}):`);
  engineWins.forEach(w => console.log(w));
}
if (misses.length) {
  console.log(`\n  Remaining engine misses (${misses.length}):`);
  misses.forEach(m => console.log(m));
} else {
  console.log('\n  No engine misses on this set.');
}
console.log('');

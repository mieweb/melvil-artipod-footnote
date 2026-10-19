/**
 * Synthetic temporality + experiencer evaluation (issue #15, Phase 2).
 *
 * WHY THIS EXISTS. The negation axis has a real external benchmark (Chapman's NegEx, see
 * eval-negex.ts). Temporality and experiencer do not: the gold-standard corpora that carry
 * those labels (i2b2 2012, ShARe/CLEF) are credentialed and offline, so we can't quote an
 * honest held-out F1 the way we can for negation.
 *
 * This harness is the honest substitute. It slots findings into CONTROLLED, unambiguous
 * temporal / experiencer frames (frames a clinician would label the same way every time)
 * and checks the engine's output. It measures ONE thing: does the engine do what it claims
 * on clear cases? It does NOT measure open-text generalization, messy real notes, or cues
 * we didn't think to template — a passing score here is necessary, not sufficient.
 *
 *   Tier of evidence:  gold (NegEx, negation)  >  THIS (controlled, silver)  >  nothing.
 *
 * It also doubles as a regression guard: if a cue-list edit breaks a frame, the number drops.
 *
 * Run:  node --import tsx src/assertion/eval-temporality.ts
 */
import { applyTemporality, type Temporality } from './temporality.js';
import { applyContext } from './context.js';

// Findings are just anchors — temporality/experiencer operate on character offsets, so the
// phrase need not be a known clinical term. Kept short and unambiguous.
const FINDINGS = ['chest pain', 'pneumonia', 'a seizure', 'headache', 'the rash', 'syncope'];

// ---- Temporality frames (each is unambiguous to a human) ----------------------------
interface TCase { heading: string[]; template: string; expected: Temporality; via: string; }
const TEMPORAL: TCase[] = [
  // recent (no temporal cue → current)
  { heading: [], template: 'The patient presents with FIND today.', expected: 'recent', via: 'no cue' },
  { heading: [], template: 'FIND is noted on exam.', expected: 'recent', via: 'no cue' },
  { heading: [], template: 'Currently reports FIND.', expected: 'recent', via: 'no cue' },
  // historical (in-sentence cue)
  { heading: [], template: 'History of FIND.', expected: 'historical', via: 'cue' },
  { heading: [], template: 'Status post FIND.', expected: 'historical', via: 'cue' },
  { heading: [], template: 'Chronic FIND for years.', expected: 'historical', via: 'cue' },
  { heading: [], template: 'FIND three years ago.', expected: 'historical', via: 'cue' },
  { heading: [], template: 'Prior episode of FIND.', expected: 'historical', via: 'cue' },
  // historical (section prior)
  { heading: ['Past Medical History'], template: 'FIND.', expected: 'historical', via: 'section' },
  // hypothetical (conditional / instructional cue)
  { heading: [], template: 'Return to the ER if you develop FIND.', expected: 'hypothetical', via: 'cue' },
  { heading: [], template: 'Monitor for FIND at home.', expected: 'hypothetical', via: 'cue' },
  { heading: [], template: 'Call your doctor if FIND occurs.', expected: 'hypothetical', via: 'cue' },
  { heading: [], template: 'Watch for FIND over the next week.', expected: 'hypothetical', via: 'cue' },
  { heading: [], template: 'The patient is at risk for FIND.', expected: 'hypothetical', via: 'cue' },
  // hypothetical (section prior)
  { heading: ['Discharge Instructions'], template: 'FIND.', expected: 'hypothetical', via: 'section' },
];

// ---- Experiencer frames (engine folds "family" → absent for the patient) -------------
interface ECase { template: string; expectAbsent: boolean; }
const EXPERIENCER: ECase[] = [
  { template: 'Family history of FIND.', expectAbsent: true },
  { template: 'Her mother had FIND.', expectAbsent: true },
  { template: 'His father was treated for FIND.', expectAbsent: true },
  { template: 'Brother with FIND.', expectAbsent: true },
  { template: 'Maternal history of FIND.', expectAbsent: true },
  // controls: the patient's own finding must NOT be folded to absent
  { template: 'The patient has FIND.', expectAbsent: false },
  { template: 'She reports FIND.', expectAbsent: false },
  { template: 'FIND on exam today.', expectAbsent: false },
];

// ---- Generalization probe: human-obvious frames that AVOID the cue lists on purpose.
// These reveal recall on unseen phrasings — the number here is expected to be LOWER, and
// that gap is the honest signal (a synthetic eval built from the cue lists alone would
// just score itself 100%). Misses here quantify where new cues / real NLP are needed.
const PROBE: TCase[] = [
  { heading: [], template: 'FIND back in 2015.', expected: 'historical', via: 'probe' },
  { heading: [], template: 'FIND when he was younger.', expected: 'historical', via: 'probe' },
  { heading: [], template: 'Recovered from FIND last winter.', expected: 'historical', via: 'probe' },
  { heading: [], template: 'FIND as a teenager.', expected: 'historical', via: 'probe' },
  { heading: [], template: 'Were FIND to occur, go to the ER.', expected: 'hypothetical', via: 'probe' },
  { heading: [], template: 'Should FIND arise, call us.', expected: 'hypothetical', via: 'probe' },
  { heading: [], template: 'In the unlikely event FIND appears, seek care.', expected: 'hypothetical', via: 'probe' },
];

function locate(template: string, find: string): { text: string; start: number; end: number } {
  const text = template.replace('FIND', find);
  const start = text.indexOf(find);
  return { text, start, end: start + find.length };
}

// ---- run temporality ----
const LABELS: Temporality[] = ['recent', 'historical', 'hypothetical'];
const confusion: Record<string, Record<string, number>> = {};
for (const a of LABELS) { confusion[a] = {}; for (const b of LABELS) confusion[a][b] = 0; }
let tCorrect = 0, tTotal = 0, baseCorrect = 0;

for (const c of TEMPORAL) {
  for (const f of FINDINGS) {
    const { text, start, end } = locate(c.template, f);
    const got = applyTemporality(c.heading, text, start, end).temporality;
    confusion[c.expected][got]++;
    if (got === c.expected) tCorrect++;
    if ('recent' === c.expected) baseCorrect++; // naive baseline = always "recent"
    tTotal++;
  }
}

// ---- run experiencer ----
let eCorrect = 0, eTotal = 0;
for (const c of EXPERIENCER) {
  for (const f of FINDINGS) {
    const { text, start, end } = locate(c.template, f);
    const isAbsent = applyContext(text, start, end)?.status === 'absent';
    if (isAbsent === c.expectAbsent) eCorrect++;
    eTotal++;
  }
}

// ---- report ----
const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`;
console.log('\n=== Temporality (recent / historical / hypothetical) ===');
console.log(`accuracy:        ${pct(tCorrect, tTotal)}  (${tCorrect}/${tTotal})`);
console.log(`naive baseline:  ${pct(baseCorrect, tTotal)}  (always "recent")`);
console.log('\nconfusion (row = expected, col = predicted):');
console.log(`${''.padEnd(14)}${LABELS.map(l => l.padStart(13)).join('')}`);
for (const a of LABELS) {
  console.log(`${a.padEnd(14)}${LABELS.map(b => String(confusion[a][b]).padStart(13)).join('')}`);
}
// per-class recall
console.log('\nper-class recall:');
for (const a of LABELS) {
  const total = LABELS.reduce((s, b) => s + confusion[a][b], 0);
  console.log(`  ${a.padEnd(13)} ${pct(confusion[a][a], total)}`);
}

// ---- run generalization probe ----
let pCorrect = 0, pTotal = 0;
for (const c of PROBE) {
  for (const f of FINDINGS) {
    const { text, start, end } = locate(c.template, f);
    if (applyTemporality(c.heading, text, start, end).temporality === c.expected) pCorrect++;
    pTotal++;
  }
}
console.log('\n=== Generalization probe (human-obvious frames NOT in the cue lists) ===');
console.log(`accuracy:        ${pct(pCorrect, pTotal)}  (${pCorrect}/${pTotal})`);
console.log('This is the honest gap: unseen phrasings the heuristic cannot catch. The lower');
console.log('this is vs. the controlled score above, the more a real model (not cue lists) buys.');

console.log('\n=== Experiencer (family finding folds to "absent" for the patient) ===');
console.log(`accuracy:        ${pct(eCorrect, eTotal)}  (${eCorrect}/${eTotal})`);
console.log('\nNote: this is a controlled/silver eval, not a gold-standard benchmark. It proves');
console.log('the engine honors clear frames; it says nothing about messy real-world notes.\n');

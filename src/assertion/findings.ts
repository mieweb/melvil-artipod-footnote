/**
 * Per-Finding Assertion Extraction (issue #15, Phase 2 — bullet 2)
 *
 * Chunk-level assertion (see assertion.ts) gives ONE label per chunk. This adds
 * concept-level extraction: it finds specific high-risk clinical findings in the text
 * and asserts EACH one independently, so a mixed sentence like
 *
 *     "Patient denies chest pain but reports progressive leg weakness."
 *
 * yields chest pain = absent AND leg weakness = present — which a single chunk label
 * cannot express.
 *
 * Why this can safely use bare negation ("no chest pain") when the chunk-level scanner
 * could not: matching is ANCHORED to a curated clinical concept. "No" immediately
 * before a known finding is unambiguously clinical negation; "no" in general prose is
 * never even looked at, because we only scan around recognized findings.
 *
 * SCOPE / honesty: this is dictionary matching over a CURATED, illustrative red-flag
 * list — NOT full clinical NER, and NOT full ConText scope parsing. The findings list
 * and trigger sets are starter sets meant to be grown from a real clinical red-flag
 * ontology and the ConText/medspaCy trigger lists cited in the ticket. Per-finding
 * retrieval (filtering search by a specific finding's polarity) is a further step;
 * this slice extracts and persists the structured assertions.
 */
import { assertionPolarity } from '../render/embedding-text.js';
import type { AssertionStatus } from './assertion.js';
import { escapeCue } from './cues.js';
import { applyContext } from './context.js';
import { applyTemporality, type Temporality } from './temporality.js';
import { isClinicalContext } from './clinical-gate.js';
import { matchGazetteer } from './gazetteer.js';

export interface FindingAssertion {
  /** Canonical finding name (from the curated list). */
  finding: string;
  /** Assertion for THIS finding occurrence (negation/certainty axis). */
  assertion: AssertionStatus;
  /** When the finding applies (orthogonal ConText axis): recent | historical | hypothetical. */
  temporality: Temporality;
  /** How we decided the assertion: the trigger phrase, the heading, or 'stated'. */
  evidence: string;
}

type Finding = { name: string; aliases?: string[] };

/**
 * UNAMBIGUOUS findings — medical jargon or clear multi-word phrases with no non-clinical
 * meaning ("pulmonary embolism" never appears in a business report). Safe to scan on ANY
 * document, so these run unconditionally.
 */
const UNAMBIGUOUS_FINDINGS: Finding[] = [
  // cardiac / vascular
  { name: 'chest pain', aliases: ['chest pressure', 'substernal chest pain'] },
  { name: 'myocardial infarction', aliases: ['heart attack'] },
  { name: 'angina' }, { name: 'palpitations' }, { name: 'atrial fibrillation' },
  { name: 'aortic dissection' }, { name: 'cardiac arrest' }, { name: 'congestive heart failure' },
  { name: 'tachycardia' }, { name: 'bradycardia' }, { name: 'claudication' },
  { name: 'deep vein thrombosis', aliases: ['dvt'] },
  // pulmonary
  { name: 'shortness of breath', aliases: ['dyspnea', 'dyspnea on exertion'] },
  { name: 'hemoptysis' }, { name: 'pulmonary embolism' }, { name: 'pneumothorax' },
  { name: 'pleural effusion' }, { name: 'pneumonia' }, { name: 'respiratory distress' },
  // neuro
  { name: 'syncope', aliases: ['loss of consciousness'] },
  { name: 'saddle anesthesia' }, { name: 'cauda equina' },
  { name: 'focal neurological deficit', aliases: ['focal neurologic deficit'] },
  { name: 'subarachnoid hemorrhage' }, { name: 'intracranial hemorrhage' },
  { name: 'altered mental status' }, { name: 'aphasia' }, { name: 'dysarthria' },
  { name: 'ataxia' }, { name: 'hemiparesis' }, { name: 'hemiplegia' },
  { name: 'transient ischemic attack', aliases: ['tia'] },
  { name: 'ischemic stroke' }, { name: 'hemorrhagic stroke' }, { name: 'cerebrovascular accident' },
  { name: 'meningitis' }, { name: 'encephalopathy' }, { name: 'paresthesia' },
  { name: 'radiculopathy' }, { name: 'vertigo' },
  { name: 'severe headache', aliases: ['thunderclap headache', 'worst headache of life'] },
  { name: 'diplopia' }, { name: 'vision loss', aliases: ['visual loss', 'loss of vision'] },
  { name: 'progressive leg weakness', aliases: ['lower extremity weakness', 'bilateral leg weakness'] },
  // GI
  { name: 'hematemesis' }, { name: 'melena' }, { name: 'hematochezia' },
  { name: 'abdominal pain' }, { name: 'appendicitis' }, { name: 'pancreatitis' },
  { name: 'bowel obstruction' }, { name: 'cholecystitis' }, { name: 'diverticulitis' },
  { name: 'gastrointestinal bleeding', aliases: ['gi bleed'] }, { name: 'peritonitis' },
  { name: 'ascites' }, { name: 'jaundice' },
  // GU / renal
  { name: 'hematuria' }, { name: 'dysuria' }, { name: 'oliguria' },
  { name: 'acute kidney injury' }, { name: 'urinary retention' },
  { name: 'urinary incontinence' }, { name: 'fecal incontinence' },
  // heme / onc / metabolic / infectious
  { name: 'anemia' }, { name: 'thrombocytopenia' }, { name: 'neutropenia' },
  { name: 'leukocytosis' }, { name: 'lymphadenopathy' }, { name: 'splenomegaly' },
  { name: 'diabetic ketoacidosis', aliases: ['dka'] }, { name: 'hypoglycemia' },
  { name: 'hyperkalemia' }, { name: 'hyponatremia' },
  { name: 'sepsis' }, { name: 'septic shock' }, { name: 'bacteremia' },
  { name: 'cellulitis' }, { name: 'osteomyelitis' }, { name: 'endocarditis' },
  { name: 'tuberculosis' }, { name: 'abscess' },
  // derm / other red flags
  { name: 'cyanosis' }, { name: 'petechiae' }, { name: 'ecchymosis' },
  { name: 'compartment syndrome' }, { name: 'night sweats' }, { name: 'unintentional weight loss' },
  // psych
  { name: 'suicidal ideation' }, { name: 'homicidal ideation' },
  { name: 'psychosis' }, { name: 'hallucinations' },
];

/**
 * AMBIGUOUS findings — common single words that ALSO have everyday meanings ("weakness",
 * "discharge", "shock"). Only scanned when the clinical-document gate says the chunk is
 * clinical, so they never fire on general prose.
 */
const AMBIGUOUS_FINDINGS: Finding[] = [
  { name: 'fever' }, { name: 'chills' }, { name: 'cough' }, { name: 'nausea' },
  { name: 'vomiting' }, { name: 'diarrhea' }, { name: 'constipation' }, { name: 'dizziness' },
  { name: 'fatigue' }, { name: 'weakness' }, { name: 'headache' }, { name: 'rash' },
  { name: 'edema', aliases: ['swelling'] }, { name: 'numbness' }, { name: 'tingling' },
  { name: 'bleeding' }, { name: 'bruising' }, { name: 'confusion' }, { name: 'tremor' },
  { name: 'seizure' }, { name: 'stroke' }, { name: 'shock' }, { name: 'discharge' },
  { name: 'wheezing' }, { name: 'malaise' }, { name: 'weight loss' }, { name: 'weight gain' },
  { name: 'depression' }, { name: 'anxiety' }, { name: 'insomnia' }, { name: 'fainting' },
  { name: 'bowel or bladder dysfunction', aliases: ['bladder dysfunction'] },
];

/**
 * Extract per-finding assertions from a chunk. Returns one entry per (finding,
 * assertion) pair found; a finding asserted twice with the same status is deduped.
 */
export function extractFindings({ headingPath, content }: { headingPath: string[]; content: string }): FindingAssertion[] {
  const headingPolarity = assertionPolarity(headingPath); // 'absent' | 'present' | null
  const out: FindingAssertion[] = [];
  const seen = new Set<string>();

  // Unambiguous findings run on any doc; ambiguous (dual-use) symptom words only when the
  // chunk is confidently clinical, so general prose never gets clinical assertions.
  const clinical = isClinicalContext(headingPath, content);
  const dictionary = clinical
    ? [...UNAMBIGUOUS_FINDINGS, ...AMBIGUOUS_FINDINGS]
    : UNAMBIGUOUS_FINDINGS;

  for (const { name, aliases } of dictionary) {
    for (const surface of [name, ...(aliases || [])]) {
      const re = new RegExp(`\\b${escapeCue(surface)}\\b`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        // ConText engine decides this occurrence from its surrounding context; fall back
        // to heading polarity, then to "present" (a bare, unmodified mention).
        const ctx = applyContext(content, m.index, m.index + m[0].length);
        const assertion: AssertionStatus = ctx?.status ?? headingPolarity ?? 'present';
        const evidence = ctx?.evidence ?? (headingPolarity ? 'heading' : 'stated');
        const { temporality } = applyTemporality(headingPath, content, m.index, m.index + m[0].length);

        // Dedup on (finding, assertion, temporality) — the same finding can legitimately
        // appear as e.g. present+historical and present+recent in one chunk.
        const key = `${name}|${assertion}|${temporality}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ finding: name, assertion, temporality, evidence });
        }
      }
    }
  }

  // Broad condition gazetteer (~2,400 common conditions) — clinical context only, so it
  // never fires on general docs. Same per-finding assertion + temporality as above.
  if (clinical) {
    for (const gm of matchGazetteer(content)) {
      const ctx = applyContext(content, gm.start, gm.end);
      const assertion: AssertionStatus = ctx?.status ?? headingPolarity ?? 'present';
      const evidence = ctx?.evidence ?? (headingPolarity ? 'heading' : 'stated');
      const { temporality } = applyTemporality(headingPath, content, gm.start, gm.end);
      const key = `${gm.finding}|${assertion}|${temporality}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ finding: gm.finding, assertion, temporality, evidence });
      }
    }
  }

  return out;
}

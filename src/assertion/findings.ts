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

export interface FindingAssertion {
  /** Canonical finding name (from the curated list). */
  finding: string;
  /** Assertion for THIS finding occurrence. */
  assertion: AssertionStatus;
  /** How we decided: the trigger phrase, the heading, or 'stated' (bare mention). */
  evidence: string;
}

/**
 * Curated high-risk clinical findings (illustrative subset — see SCOPE note).
 * Each entry is the canonical name; `aliases` are additional surface forms to match.
 * Skewed toward red-flag symptoms where present-vs-absent genuinely changes triage.
 */
const HIGH_RISK_FINDINGS: Array<{ name: string; aliases?: string[] }> = [
  { name: 'saddle anesthesia' },
  { name: 'bowel or bladder dysfunction', aliases: ['urinary retention', 'urinary incontinence', 'fecal incontinence', 'bladder dysfunction'] },
  { name: 'progressive leg weakness', aliases: ['lower extremity weakness', 'leg weakness', 'bilateral leg weakness'] },
  { name: 'chest pain', aliases: ['chest pressure'] },
  { name: 'shortness of breath', aliases: ['dyspnea'] },
  { name: 'suicidal ideation' },
  { name: 'hemoptysis' },
  { name: 'syncope', aliases: ['loss of consciousness'] },
  { name: 'severe headache', aliases: ['thunderclap headache', 'worst headache of life'] },
  { name: 'vision loss', aliases: ['visual loss', 'loss of vision'] },
  { name: 'focal neurological deficit', aliases: ['focal neurologic deficit'] },
];
// NOTE: intentionally omitting common dual-use terms (e.g. "fever", "SOB", "SI") that
// would false-fire on general documentation. A clinical-document gate would let the
// list safely include them; see the SCOPE note above.

/**
 * Extract per-finding assertions from a chunk. Returns one entry per (finding,
 * assertion) pair found; a finding asserted twice with the same status is deduped.
 */
export function extractFindings({ headingPath, content }: { headingPath: string[]; content: string }): FindingAssertion[] {
  const headingPolarity = assertionPolarity(headingPath); // 'absent' | 'present' | null
  const out: FindingAssertion[] = [];
  const seen = new Set<string>();

  for (const { name, aliases } of HIGH_RISK_FINDINGS) {
    for (const surface of [name, ...(aliases || [])]) {
      const re = new RegExp(`\\b${escapeCue(surface)}\\b`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        // ConText engine decides this occurrence from its surrounding context; fall back
        // to heading polarity, then to "present" (a bare, unmodified mention).
        const ctx = applyContext(content, m.index, m.index + m[0].length);
        const assertion: AssertionStatus = ctx?.status ?? headingPolarity ?? 'present';
        const evidence = ctx?.evidence ?? (headingPolarity ? 'heading' : 'stated');

        const key = `${name}|${assertion}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ finding: name, assertion, evidence });
        }
      }
    }
  }
  return out;
}

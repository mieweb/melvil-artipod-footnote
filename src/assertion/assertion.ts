/**
 * Assertion Detection (issue #15, Phase 2)
 *
 * Phase 1 baked heading-level polarity into the *embedding text*. Phase 2 promotes
 * assertion to a first-class, queryable *metadata* value per chunk — so retrieval can
 * filter or rerank on it (e.g. "don't surface a symptom the note explicitly denies").
 *
 * Statuses follow the issue: present | absent | possible | historical, plus
 * `unspecified` when no clinical cue is found (the common case for general docs).
 *
 * What Phase 2 adds over Phase 1:
 *   1. It reads the chunk BODY, not just the heading — so negation stated in prose
 *      ("patient denies chest pain") is caught even under a neutral heading.
 *   2. It distinguishes `possible` and `historical`, which heading polarity can't.
 *
 * SAFETY / SCOPE (same lesson as the Phase 1 self-review): FOOTNOTE indexes general
 * documentation, and this runs on every doc with no clinical gate. So the body
 * triggers are deliberately STRONG clinical idioms only — we do NOT match bare
 * "no" / "not" / "possible" / "history of" / "without", which are ubiquitous in
 * ordinary prose and would mislabel non-clinical chunks. The cost is recall: plain
 * "no chest pain" is NOT caught here. Reliable bare-negation scope detection needs a
 * clinical-document gate and/or true ConText-style scope parsing — deferred (see the
 * medspaCy/ConText references in the ticket). Default is `unspecified`, so general
 * docs get no assertion.
 */
import { assertionPolarity } from '../render/embedding-text.js';

export type AssertionStatus = 'present' | 'absent' | 'possible' | 'historical' | 'unspecified';

export interface AssertionResult {
  status: AssertionStatus;
  /** Where the decision came from — useful for debugging and for the UI/demo. */
  source: 'heading' | 'body' | 'none';
  /** The literal cue phrase(s) that fired, for transparency. */
  triggers: string[];
}

export interface AssertionInput {
  headingPath: string[];
  content: string;
}

/**
 * Body cue phrases per status. STRONG clinical idioms only — see the SAFETY note above.
 * Order of the categories here also encodes precedence (see detectAssertion).
 */
const BODY_CUES: Array<{ status: Exclude<AssertionStatus, 'unspecified'>; cues: string[] }> = [
  // Uncertainty first: "cannot rule out X" is possible, not absent, even though a
  // negation-ish phrase sits nearby.
  { status: 'possible', cues: ['cannot rule out', "can't rule out", 'rule out', 'r/o', 'differential diagnosis'] },
  { status: 'absent', cues: ['denies', 'denied', 'negative for', 'no evidence of', 'ruled out', 'pertinent negatives', 'nkda', 'nka'] },
  { status: 'historical', cues: ['h/o', 'hx of', 'past medical history', 'pmh', 'status post', 's/p'] },
  { status: 'present', cues: ['positive for', 'complains of', 'c/o', 'presents with', 'pertinent positives'] },
];

/** Escape a cue for use in a RegExp, and bound it so it matches as a phrase, not a substring. */
function cueRegex(cue: string): RegExp {
  const escaped = cue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Abbreviations containing "/" (c/o, r/o, h/o, s/p) can't use \b around the slash,
  // so bound them by a non-alphanumeric or string edge instead.
  if (cue.includes('/')) {
    return new RegExp(`(^|[^a-z0-9])${escaped}(?=[^a-z0-9]|$)`, 'i');
  }
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

/** Scan the chunk body for the first matching cue category (by precedence order). */
function scanBody(content: string): { status: Exclude<AssertionStatus, 'unspecified'>; triggers: string[] } | null {
  for (const { status, cues } of BODY_CUES) {
    const hits = cues.filter(c => cueRegex(c).test(content));
    if (hits.length > 0) return { status, triggers: hits };
  }
  return null;
}

/**
 * Determine a single assertion status for a chunk.
 *
 * Precedence: a heading that carries an explicit polarity ("Negative for" / "Positive
 * for") is a strong STRUCTURAL signal and wins. Otherwise we fall back to the body
 * scan, which can additionally yield `possible` / `historical`. Chunk-level (not
 * per-finding) — a single label per chunk is a deliberate Phase-2 simplification;
 * per-finding assertion spans are further work.
 */
export function detectAssertion({ headingPath, content }: AssertionInput): AssertionResult {
  const headingPolarity = assertionPolarity(headingPath); // 'absent' | 'present' | null
  if (headingPolarity) {
    return { status: headingPolarity, source: 'heading', triggers: [] };
  }

  const body = scanBody(content);
  if (body) {
    return { status: body.status, source: 'body', triggers: body.triggers };
  }

  return { status: 'unspecified', source: 'none', triggers: [] };
}

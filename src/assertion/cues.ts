/**
 * Canonical clinical assertion cue table (issue #15).
 *
 * Previously the same negation/uncertainty/historical/presence cue words were
 * duplicated across three files (embedding-text.ts, assertion.ts, findings.ts) with
 * lists that had quietly drifted apart. This is the single source of truth.
 *
 * Each cue carries:
 *   - category: what it signals (maps to an assertion status)
 *   - direction: which way it applies to a nearby finding — "forward" ("denies X"),
 *     "backward" ("X resolved"), or "both". Used by the per-finding scope scan.
 *   - context flags (heading / chunk / finding): the safety tiers it may be used in.
 *       heading  — safe even in a bare section heading (strong, unambiguous phrases)
 *       chunk    — safe scanning a whole chunk body (no bare common words)
 *       finding  — safe only when anchored to a KNOWN finding (bare "no"/"not" OK here)
 *     A cue can be valid in several tiers; they are independent flags, not nested.
 *
 * This table is intentionally shaped for a fuller ConText-style engine (trigger +
 * direction + termination). For now the existing consumers select the slice they need.
 */

export type CueCategory = 'negation' | 'uncertainty' | 'historical' | 'presence';
export type CueDirection = 'forward' | 'backward' | 'both';
export type CueContext = 'heading' | 'chunk' | 'finding';

interface CueSpec {
  phrase: string;
  category: CueCategory;
  direction: CueDirection;
  contexts: CueContext[];
}

export interface Cue extends CueSpec {
  /** Precompiled, case-insensitive, phrase-bounded matcher (compiled once at load). */
  re: RegExp;
}

/** Map a cue category to the assertion status it implies. */
export function categoryToStatus(category: CueCategory): 'absent' | 'possible' | 'historical' | 'present' {
  switch (category) {
    case 'negation': return 'absent';
    case 'uncertainty': return 'possible';
    case 'historical': return 'historical';
    case 'presence': return 'present';
  }
}

/** Escape a cue for use in a RegExp. */
export function escapeCue(cue: string): string {
  return cue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Phrase-bounded, case-insensitive matcher for a cue. Abbreviations containing "/"
 * (c/o, r/o, h/o, s/p) can't use \b around the slash, so they are bounded by a
 * non-alphanumeric char or string edge instead.
 */
export function cueRegex(cue: string): RegExp {
  const e = escapeCue(cue);
  if (cue.includes('/')) return new RegExp(`(^|[^a-z0-9])${e}(?=[^a-z0-9]|$)`, 'i');
  return new RegExp(`\\b${e}\\b`, 'i');
}

const H: CueContext[] = ['heading', 'chunk', 'finding'];
const HC: CueContext[] = ['heading', 'chunk'];
const CF: CueContext[] = ['chunk', 'finding'];
const F: CueContext[] = ['finding'];

// Order here mirrors the historical lists; consumers impose their own precedence.
const SPECS: CueSpec[] = [
  // ---- Negation (→ absent) ----
  { phrase: 'denies', category: 'negation', direction: 'forward', contexts: H },
  { phrase: 'denied', category: 'negation', direction: 'both', contexts: H },
  { phrase: 'negative for', category: 'negation', direction: 'forward', contexts: H },
  { phrase: 'no evidence of', category: 'negation', direction: 'forward', contexts: H },
  { phrase: 'pertinent negatives', category: 'negation', direction: 'forward', contexts: HC },
  { phrase: 'no known', category: 'negation', direction: 'forward', contexts: ['heading'] },
  { phrase: 'absence of', category: 'negation', direction: 'forward', contexts: ['heading'] },
  { phrase: 'within normal limits', category: 'negation', direction: 'forward', contexts: ['heading'] },
  { phrase: 'wnl', category: 'negation', direction: 'forward', contexts: ['heading'] },
  { phrase: 'unremarkable', category: 'negation', direction: 'forward', contexts: ['heading'] },
  { phrase: 'none reported', category: 'negation', direction: 'forward', contexts: ['heading'] },
  { phrase: 'ruled out', category: 'negation', direction: 'both', contexts: CF },
  { phrase: 'nkda', category: 'negation', direction: 'forward', contexts: CF },
  { phrase: 'nka', category: 'negation', direction: 'forward', contexts: CF },
  { phrase: 'no', category: 'negation', direction: 'forward', contexts: F },
  { phrase: 'not', category: 'negation', direction: 'forward', contexts: F },
  { phrase: 'without', category: 'negation', direction: 'forward', contexts: F },
  { phrase: 'free of', category: 'negation', direction: 'forward', contexts: F },
  // post-position negation/resolution (after the finding)
  { phrase: 'resolved', category: 'negation', direction: 'backward', contexts: F },
  { phrase: 'negative', category: 'negation', direction: 'backward', contexts: F },
  { phrase: 'no longer', category: 'negation', direction: 'backward', contexts: F },
  { phrase: 'not present', category: 'negation', direction: 'backward', contexts: F },
  { phrase: 'absent', category: 'negation', direction: 'backward', contexts: F },

  // ---- Uncertainty (→ possible) ----
  { phrase: 'cannot rule out', category: 'uncertainty', direction: 'forward', contexts: CF },
  { phrase: "can't rule out", category: 'uncertainty', direction: 'forward', contexts: CF },
  { phrase: 'rule out', category: 'uncertainty', direction: 'forward', contexts: CF },
  { phrase: 'r/o', category: 'uncertainty', direction: 'forward', contexts: CF },
  { phrase: 'differential diagnosis', category: 'uncertainty', direction: 'forward', contexts: ['chunk'] },
  { phrase: 'differential', category: 'uncertainty', direction: 'forward', contexts: F },
  { phrase: 'possible', category: 'uncertainty', direction: 'forward', contexts: F },
  { phrase: 'possibly', category: 'uncertainty', direction: 'forward', contexts: F },
  { phrase: 'probable', category: 'uncertainty', direction: 'forward', contexts: F },
  { phrase: 'likely', category: 'uncertainty', direction: 'forward', contexts: F },
  { phrase: 'suspected', category: 'uncertainty', direction: 'forward', contexts: F },
  { phrase: 'concern for', category: 'uncertainty', direction: 'forward', contexts: F },
  { phrase: 'concerning for', category: 'uncertainty', direction: 'forward', contexts: CF },
  { phrase: 'question of', category: 'uncertainty', direction: 'forward', contexts: F },
  { phrase: 'questionable', category: 'uncertainty', direction: 'forward', contexts: F },
  { phrase: 'cannot exclude', category: 'uncertainty', direction: 'forward', contexts: CF },
  { phrase: "can't exclude", category: 'uncertainty', direction: 'forward', contexts: CF },
  { phrase: 'cannot be excluded', category: 'uncertainty', direction: 'backward', contexts: CF },
  { phrase: "can't be excluded", category: 'uncertainty', direction: 'backward', contexts: CF },
  { phrase: 'unlikely', category: 'uncertainty', direction: 'both', contexts: F },

  // ---- Historical (→ historical) ----
  { phrase: 'h/o', category: 'historical', direction: 'forward', contexts: CF },
  { phrase: 'hx of', category: 'historical', direction: 'forward', contexts: CF },
  { phrase: 'past medical history', category: 'historical', direction: 'forward', contexts: CF },
  { phrase: 'pmh', category: 'historical', direction: 'forward', contexts: CF },
  { phrase: 'status post', category: 'historical', direction: 'forward', contexts: CF },
  { phrase: 's/p', category: 'historical', direction: 'forward', contexts: CF },
  { phrase: 'history of', category: 'historical', direction: 'forward', contexts: F },
  { phrase: 'prior', category: 'historical', direction: 'forward', contexts: F },
  { phrase: 'previously', category: 'historical', direction: 'forward', contexts: F },

  // ---- Presence (→ present) ----
  { phrase: 'positive for', category: 'presence', direction: 'forward', contexts: H },
  { phrase: 'complains of', category: 'presence', direction: 'forward', contexts: H },
  { phrase: 'c/o', category: 'presence', direction: 'forward', contexts: H },
  { phrase: 'presents with', category: 'presence', direction: 'forward', contexts: H },
  { phrase: 'pertinent positives', category: 'presence', direction: 'forward', contexts: HC },
  { phrase: 'reports', category: 'presence', direction: 'forward', contexts: F },
  { phrase: 'endorses', category: 'presence', direction: 'forward', contexts: F },
];

/** The canonical cue table, with matchers compiled once. */
export const CUES: Cue[] = SPECS.map(s => ({ ...s, re: cueRegex(s.phrase) }));

/**
 * Select the cues valid in a given context, optionally filtered by category and by
 * direction. Direction 'forward'/'backward' also includes 'both'-direction cues.
 */
export function selectCues(filter: {
  context: CueContext;
  category?: CueCategory;
  direction?: 'forward' | 'backward';
}): Cue[] {
  return CUES.filter(c => {
    if (!c.contexts.includes(filter.context)) return false;
    if (filter.category && c.category !== filter.category) return false;
    if (filter.direction && c.direction !== filter.direction && c.direction !== 'both') return false;
    return true;
  });
}

/**
 * Words/punctuation that terminate an assertion's scope (ConText-lite). Sentence
 * enders (. ! ? newline) and semicolons break scope so negation from one sentence
 * does not bleed into a finding in the next; conjunctions ("but") break it mid-sentence.
 */
export const SCOPE_TERMINATORS = /\b(but|however|otherwise|except|though|although|aside from|apart from)\b|[.;!?\n]/i;

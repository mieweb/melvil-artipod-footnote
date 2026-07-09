/**
 * ConText-style assertion engine (issue #15).
 *
 * A lightweight, in-stack take on the ConText algorithm (Harkema et al., 2009): given a
 * concept span in a piece of text, determine its assertion status from the surrounding
 * cues, respecting each cue's DIRECTION (does it look forward or backward from the
 * concept) and where the scope TERMINATES (sentence/clause boundaries).
 *
 * Beyond the basic version it also handles:
 *   - pseudo-negation ("no increase in pain" — a negation word that doesn't negate)
 *   - double negation ("no evidence to suggest absence of pain" → present)
 *   - backward modifiers of any category ("chest pain cannot be excluded" → possible)
 *   - experiencer ("mother has a history of X" → about family, not the patient)
 *
 * Still lightweight, not full ConText: no temporality axis, no validated trigger
 * lexicon, and scope is a bounded window rather than a parsed sentence tree.
 */
import { selectCues, SCOPE_TERMINATORS, type Cue } from './cues.js';

export type ContextStatus = 'absent' | 'possible' | 'historical' | 'present';

export interface ContextResult {
  status: ContextStatus;
  /** The cue phrase that decided it. */
  evidence: string;
}

/** How many characters on each side of a concept to consider (bounded by termination). */
const WINDOW = 160;

// Forward triggers sit BEFORE the concept ("denies chest pain"). Ordered by precedence:
// negation is the strongest local signal next to a finding.
const FORWARD: Array<{ status: ContextStatus; cues: Cue[] }> = [
  { status: 'absent', cues: selectCues({ context: 'finding', category: 'negation', direction: 'forward' }) },
  { status: 'possible', cues: selectCues({ context: 'finding', category: 'uncertainty', direction: 'forward' }) },
  { status: 'historical', cues: selectCues({ context: 'finding', category: 'historical', direction: 'forward' }) },
  { status: 'present', cues: selectCues({ context: 'finding', category: 'presence', direction: 'forward' }) },
];

// Backward triggers sit AFTER the concept ("chest pain resolved", "chest pain cannot be excluded").
const BACKWARD: Array<{ status: ContextStatus; cues: Cue[] }> = [
  { status: 'absent', cues: selectCues({ context: 'finding', category: 'negation', direction: 'backward' }) },
  { status: 'possible', cues: selectCues({ context: 'finding', category: 'uncertainty', direction: 'backward' }) },
];

/**
 * Pseudo-negations: phrases that contain a negation word but do NOT negate the concept.
 * Includes double negations ("no evidence to suggest absence of X" → present) — masking
 * them leaves the concept un-negated, so it defaults to present.
 */
const PSEUDO_NEGATION =
  /\b(no increase|no interval change|no change|no significant interval|not only|not necessarily|without difficulty|gram[- ]negative|no evidence to suggest absence of|no evidence of absence of|without evidence of absence of)\b/gi;

function maskPseudoNegation(scope: string): string {
  return scope.replace(PSEUDO_NEGATION, m => ' '.repeat(m.length));
}

/**
 * Experiencer: the finding pertains to a family member, not the patient. A standard
 * ConText axis. We fold it into the assertion (not-the-patient → not present for them).
 */
const FAMILY_CONTEXT =
  /\b(family history|fh of|fhx|father|mother|sister|brother|parent|sibling|son|daughter|aunt|uncle|grandmother|grandfather|maternal|paternal)\b/i;

/** Left context: concept back to the nearest scope terminator (pseudo-negations masked). */
function leftScope(text: string, conceptStart: number): string {
  const raw = text.slice(Math.max(0, conceptStart - WINDOW), conceptStart);
  const term = [...raw.matchAll(new RegExp(SCOPE_TERMINATORS, 'gi'))].pop();
  const scope = term && term.index !== undefined ? raw.slice(term.index + term[0].length) : raw;
  return maskPseudoNegation(scope);
}

/** Right context: concept forward to the nearest scope terminator. */
function rightScope(text: string, conceptEnd: number): string {
  const raw = text.slice(conceptEnd, conceptEnd + WINDOW);
  const term = raw.match(SCOPE_TERMINATORS);
  return term && term.index !== undefined ? raw.slice(0, term.index) : raw;
}

/**
 * Determine the assertion for a concept at [conceptStart, conceptEnd) from its context,
 * or null if no cue applies (the caller supplies a default such as heading polarity).
 *
 * Order: experiencer (family) wins — if it's not the patient's finding, nothing else
 * matters; then explicit post-position modifiers ("X resolved", "X cannot be excluded");
 * then forward modifiers by category precedence.
 */
export function applyContext(text: string, conceptStart: number, conceptEnd: number): ContextResult | null {
  const left = leftScope(text, conceptStart);

  // Experiencer: a family-history context means the finding isn't the patient's.
  if (FAMILY_CONTEXT.test(left)) {
    return { status: 'absent', evidence: 'family history (not the patient)' };
  }

  // Backward modifiers after the concept.
  const right = rightScope(text, conceptEnd);
  for (const { status, cues } of BACKWARD) {
    for (const cue of cues) {
      if (cue.re.test(right)) return { status, evidence: cue.phrase };
    }
  }

  // Forward modifiers before the concept, by precedence.
  for (const { status, cues } of FORWARD) {
    for (const cue of cues) {
      if (cue.re.test(left)) return { status, evidence: cue.phrase };
    }
  }
  return null;
}

/**
 * ConText-style assertion engine (issue #15).
 *
 * A lightweight, in-stack take on the ConText algorithm (Harkema et al., 2009): given a
 * concept span in a piece of text, determine its assertion status from the surrounding
 * cues, respecting each cue's DIRECTION (does it look forward or backward from the
 * concept) and where the scope TERMINATES (sentence/clause boundaries).
 *
 * This centralizes the per-finding scope logic that used to live inline in findings.ts,
 * drives it entirely from the canonical cue table (cues.ts), and adds pseudo-negation
 * handling — phrases like "no increase in pain" that contain a negation word but do NOT
 * actually negate the concept (a standard ConText refinement).
 *
 * Not covered (still a lightweight version, not full ConText): experiencer (family vs
 * patient), nested/scoped double negation, and a validated trigger lexicon.
 */
import { selectCues, SCOPE_TERMINATORS, type Cue } from './cues.js';

export type ContextStatus = 'absent' | 'possible' | 'historical' | 'present';

export interface ContextResult {
  status: ContextStatus;
  /** The cue phrase that decided it. */
  evidence: string;
}

/** How many characters on each side of a concept to consider (bounded by termination). */
const WINDOW = 60;

// Forward triggers sit BEFORE the concept ("denies chest pain"). Ordered by precedence:
// negation is the strongest local signal next to a finding.
const FORWARD: Array<{ status: ContextStatus; cues: Cue[] }> = [
  { status: 'absent', cues: selectCues({ context: 'finding', category: 'negation', direction: 'forward' }) },
  { status: 'possible', cues: selectCues({ context: 'finding', category: 'uncertainty', direction: 'forward' }) },
  { status: 'historical', cues: selectCues({ context: 'finding', category: 'historical', direction: 'forward' }) },
  { status: 'present', cues: selectCues({ context: 'finding', category: 'presence', direction: 'forward' }) },
];

// Backward negation sits AFTER the concept ("chest pain resolved").
const BACKWARD_NEGATION: Cue[] = selectCues({ context: 'finding', category: 'negation', direction: 'backward' });

/**
 * Pseudo-negations: phrases that contain a negation word but do NOT negate the concept.
 * "no increase in pain" means pain is present (just not worse); "not only X" affirms X.
 */
const PSEUDO_NEGATION =
  /\b(no increase|no interval change|no change|no significant interval|not only|not necessarily|without difficulty|gram[- ]negative)\b/gi;

function maskPseudoNegation(scope: string): string {
  return scope.replace(PSEUDO_NEGATION, m => ' '.repeat(m.length));
}

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
 * Precedence: explicit post-position negation ("X resolved") wins; otherwise the nearest
 * applicable forward modifier by category precedence (negation > uncertainty > historical
 * > presence).
 */
export function applyContext(text: string, conceptStart: number, conceptEnd: number): ContextResult | null {
  const right = rightScope(text, conceptEnd);
  for (const cue of BACKWARD_NEGATION) {
    if (cue.re.test(right)) return { status: 'absent', evidence: cue.phrase };
  }

  const left = leftScope(text, conceptStart);
  for (const { status, cues } of FORWARD) {
    for (const cue of cues) {
      if (cue.re.test(left)) return { status, evidence: cue.phrase };
    }
  }
  return null;
}

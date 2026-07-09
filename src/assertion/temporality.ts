/**
 * Temporality axis (issue #15, Phase 2 — the second ConText axis).
 *
 * ConText (Harkema 2009) determines three things about a clinical finding: whether it's
 * negated, WHO experienced it, and WHEN. The negation axis lives in context.ts; this is
 * the WHEN: is the finding recent (active now), historical (a past problem), or
 * hypothetical (conditional — "return if you develop X", "monitor for Y")?
 *
 * It's a SEPARATE, orthogonal axis from assertion — a finding can be present+historical
 * ("chronic CHF, stable") or absent+historical ("prior MI, now resolved"). Collapsing
 * temporality into the assertion status (as the older code did with a single 'historical'
 * value) cannot express that; keeping it separate can.
 *
 * Two signals, in the order clinicians rely on:
 *   1. SECTION — the strongest signal. A bare "Hypertension." under a "Past Medical
 *      History" heading is historical with no in-sentence cue at all. This is why the
 *      sentence-only NegEx benchmark caps out on historical recall (~47%): it strips the
 *      heading. In FOOTNOTE's pipeline the heading path IS available, so this pays off.
 *   2. IN-SENTENCE cues — "history of", "chronic", "in the past" (historical); "if you
 *      develop", "monitor for" (hypothetical).
 */
import { cueRegex, SCOPE_TERMINATORS } from './cues.js';

export type Temporality = 'recent' | 'historical' | 'hypothetical';

export interface TemporalityResult {
  temporality: Temporality;
  /** The cue phrase or structural signal that decided it. */
  evidence: string;
}

/** Characters on each side of the finding to scan (bounded by scope termination). */
const WINDOW = 160;

// --- section-level (structural) signals -------------------------------------------

/** Headings that place a finding in the past by structure alone. */
const HISTORICAL_SECTION =
  /\b(past medical history|past surgical history|medical history|surgical history|pmh|psh|problem list|past hospitalizations?|prior (medical|surgical) history|social history)\b/i;

/** Headings whose findings are conditional/instructional, not current. */
const HYPOTHETICAL_SECTION =
  /\b(discharge instructions|return precautions|patient instructions|follow[- ]?up instructions|warning signs|return to (the )?(er|ed|emergency room)|when to (seek|call|return)|home care instructions)\b/i;

// --- in-sentence cues -------------------------------------------------------------
// Whitespace-flexible (via cueRegex) to survive de-identified formatting. Chosen to be
// generalizable clinical markers, not fitted to any one corpus. "old" is deliberately
// EXCLUDED: in real notes it is overwhelmingly "60s-year-old" (age), not history.

const HISTORICAL_CUES = [
  'history of', 'h/o', 'hx of', 'past medical history', 'pmh', 'status post', 's/p',
  'prior', 'previously', 'in the past', 'years ago', 'months ago', 'yrs ago',
  'chronic', 'longstanding', 'long-standing', 'remote', 'resolved', 'no longer',
  'formerly', 'former', 'quit', 'since childhood', 'as a child', 'in childhood',
].map(cueRegex);

const HYPOTHETICAL_CUES = [
  'if you develop', 'if you experience', 'if you have', 'if symptoms', 'if there is',
  'if he develops', 'if she develops', 'should you develop', 'should you experience',
  'should he develop', 'should she develop', 'return if', 'come back if', 'call if',
  'call your doctor if', 'call the office if', 'seek care if', 'in case of',
  'in the event of', 'watch for', 'monitor for', 'look out for', 'as needed for',
  'prn for',
].map(cueRegex);

/** The clause around a finding, bounded by the nearest scope terminators. */
function windowAround(text: string, start: number, end: number): string {
  const rawL = text.slice(Math.max(0, start - WINDOW), start);
  const termL = [...rawL.matchAll(new RegExp(SCOPE_TERMINATORS, 'gi'))].pop();
  const left = termL && termL.index !== undefined ? rawL.slice(termL.index + termL[0].length) : rawL;
  const rawR = text.slice(end, end + WINDOW);
  const termR = rawR.match(SCOPE_TERMINATORS);
  const right = termR && termR.index !== undefined ? rawR.slice(0, termR.index) : rawR;
  return `${left} ${right}`;
}

function firstHit(scope: string, cues: RegExp[]): string | null {
  for (const re of cues) {
    const m = scope.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

/** Section-only temporality (no sentence context), or null if the section is neutral. */
export function sectionTemporality(headingPath: string[]): Temporality | null {
  const h = headingPath.join(' ');
  if (HYPOTHETICAL_SECTION.test(h)) return 'hypothetical';
  if (HISTORICAL_SECTION.test(h)) return 'historical';
  return null;
}

/**
 * Resolve the temporality of a finding at [start, end) from its section and its clause.
 * Precedence: a conditional frame (hypothetical) dominates a past reference; an explicit
 * in-sentence cue beats the section prior; neutral defaults to recent.
 */
export function applyTemporality(
  headingPath: string[],
  text: string,
  start: number,
  end: number,
): TemporalityResult {
  const scope = windowAround(text, start, end);
  const heading = headingPath.join(' ');

  const hyp = firstHit(scope, HYPOTHETICAL_CUES);
  if (hyp) return { temporality: 'hypothetical', evidence: `cue: "${hyp}"` };
  if (HYPOTHETICAL_SECTION.test(heading)) return { temporality: 'hypothetical', evidence: 'instructional section' };

  const hist = firstHit(scope, HISTORICAL_CUES);
  if (hist) return { temporality: 'historical', evidence: `cue: "${hist}"` };
  if (HISTORICAL_SECTION.test(heading)) return { temporality: 'historical', evidence: 'history section' };

  return { temporality: 'recent', evidence: 'no temporal cue' };
}

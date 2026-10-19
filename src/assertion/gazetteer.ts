/**
 * Condition gazetteer (issue #15 — coverage exploration, beyond the ticket).
 *
 * The hand-curated finding list (findings.ts) covers ~130 red-flags. This adds ~2,400
 * common conditions harvested once from the NLM Clinical Table Search Service (public
 * domain, no auth) and baked into conditions.json — so there is NO runtime API dependency.
 *
 * Matching is a single tokenize + greedy longest n-gram hash-lookup per chunk: its cost is
 * independent of dictionary size (one Set lookup per n-gram), so 2,400 terms is as fast as
 * 130 — unlike running one regex per term. Only invoked inside a clinical context (the
 * gate in findings.ts), so it never touches general documents.
 *
 * This is still DICTIONARY matching: it can't disambiguate ("mass" the finding vs the
 * crowd) or handle novel phrasings/inflection — that's the real-NER frontier.
 */
import { readFileSync } from 'node:fs';

/** Normalize a term to the matcher's phrase shape: lowercase, [a-z0-9]+ tokens, single-spaced. */
function normalizeTerm(s: string): string {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(' ');
}

/**
 * Build the lookup set from the raw NLM list.
 *
 * NLM ships terms in an inverted, punctuated form ("acidosis - lactic",
 * "adenocarcinoma in-situ") that can never equal a token-joined phrase from prose — so
 * ~22% of the raw list (432 inverted + others) was previously unmatchable dead weight.
 * For every raw term we store its normalized token-join form, and — for inverted
 * "main - modifier" entries — additionally the de-inverted natural-order form
 * ("acidosis - lactic" -> "lactic acidosis"), which is what actually appears in prose.
 */
function buildTerms(raw: string[]): Set<string> {
  const set = new Set<string>();
  for (const term of raw) {
    const straight = normalizeTerm(term);
    if (straight) set.add(straight);
    if (term.includes(' - ')) {
      const deInverted = normalizeTerm(term.split(' - ').reverse().join(' '));
      if (deInverted) set.add(deInverted);
    }
  }
  return set;
}

const TERMS: Set<string> = buildTerms(
  JSON.parse(readFileSync(new URL('./conditions.json', import.meta.url), 'utf8')) as string[],
);

/**
 * Cap n-gram length at the longest stored term. Data-driven (not a hard-coded 5) because
 * normalizing punctuation can lengthen a term (e.g. "…s/p tpa" -> "…s p tpa"); bounded at 8
 * so a pathological entry can't blow up per-token cost.
 */
const MAX_N = Math.min(8, Math.max(1, ...Array.from(TERMS, t => t.split(' ').length)));

export interface GazetteerMatch {
  finding: string;
  start: number;
  end: number;
}

interface Tok { w: string; start: number; end: number; }

function tokenize(lower: string): Tok[] {
  const toks: Tok[] = [];
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    if (m.index !== undefined) toks.push({ w: m[0], start: m.index, end: m.index + m[0].length });
  }
  return toks;
}

/**
 * Find all gazetteer terms in the text. Greedy longest-match from each position, then skip
 * the covered tokens — so "abdominal pain" wins over a separate "pain", no double-count.
 */
export function matchGazetteer(text: string): GazetteerMatch[] {
  const toks = tokenize(text.toLowerCase());
  const out: GazetteerMatch[] = [];
  let i = 0;
  while (i < toks.length) {
    let matched = false;
    for (let n = Math.min(MAX_N, toks.length - i); n >= 1; n--) {
      const phrase = toks.slice(i, i + n).map(t => t.w).join(' ');
      if (TERMS.has(phrase)) {
        out.push({ finding: phrase, start: toks[i].start, end: toks[i + n - 1].end });
        i += n;
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }
  return out;
}

/** Number of terms loaded (for diagnostics). */
export const GAZETTEER_SIZE = TERMS.size;

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

const TERMS: Set<string> = new Set(
  JSON.parse(readFileSync(new URL('./conditions.json', import.meta.url), 'utf8')) as string[],
);

/** Longest term is 5 words; cap n-gram length there. */
const MAX_N = 5;

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

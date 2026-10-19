/**
 * Context-Aware Embedding Text Rendering
 *
 * The vector text for a chunk is NOT the raw body. We prepend the chunk's heading
 * ancestry and, when a heading carries an assertion cue (e.g. "Negative for",
 * "Denies"), a short polarity preamble. This keeps the *meaning* of section scope
 * in the embedding so that a denied finding under `### Negative for:` does not embed
 * as a free-floating positive concept.
 *
 * Raw chunk content is left untouched — it is what gets stored, displayed, cited,
 * and indexed for FTS/literal search. Only the embedding input is rendered.
 *
 * This is a heuristic, heading-derived first pass (issue #15, Phase 1). It is NOT a
 * negation parser: it infers polarity from section titles only. Richer assertion
 * extraction (per-finding present/absent/possible/historical) is deferred to Phase 2.
 *
 * RENDER_VERSION is folded into the embedding hash so that changing the rendering
 * algorithm invalidates cached vectors. Note: build.ts skips files whose whole-file
 * hash is unchanged, so a render-algorithm change still requires a `--clean` rebuild
 * to re-embed already-indexed files; bumping this only protects against silently
 * reusing a stale vector for a chunk that does get reprocessed.
 */
import { selectCues } from '../assertion/cues.js';

/** Bump when the rendering output for the same input changes. */
export const RENDER_VERSION = 2;

export interface RenderInput {
  headingPath: string[];
  content: string;
}

// Heading-level cues come from the canonical cue table (src/assertion/cues.ts),
// filtered to the "heading" tier: deliberately STRONG, multi-word (or unambiguous)
// clinical phrases only. FOOTNOTE indexes general documentation, so single common
// words ("no", "without", "present", "reports") are NOT heading-safe there — they'd
// mislabel everyday headings ("Without Loss of Generality", "Positive Feedback").
// "rule out" / "r/o" are also excluded from the heading tier: clinically they mean the
// finding is being *considered* (a differential), not denied — they map to "possible"
// at the body level instead.
const HEADING_NEGATION = selectCues({ context: 'heading', category: 'negation' });
const HEADING_PRESENCE = selectCues({ context: 'heading', category: 'presence' });

export type AssertionPolarity = 'absent' | 'present' | null;

/**
 * Infer an assertion polarity from the heading path, or null if no cue matches.
 * Negation wins ties (a "Negative for" heading is the dangerous case we must catch).
 */
export function assertionPolarity(headingPath: string[]): AssertionPolarity {
  const joined = headingPath.join(' ');
  if (HEADING_NEGATION.some(c => c.re.test(joined))) return 'absent';
  if (HEADING_PRESENCE.some(c => c.re.test(joined))) return 'present';
  return null;
}

const PREAMBLE: Record<'absent' | 'present', string> = {
  absent: 'The following findings are denied or absent:',
  present: 'The following findings are present or reported:',
};

/**
 * Render the embedding input for a chunk: heading ancestry + optional polarity
 * preamble + the raw body. Deterministic and human-readable.
 */
export function renderEmbeddingText({ headingPath, content }: RenderInput): string {
  const path = headingPath.filter(Boolean);
  const lines: string[] = [];

  if (path.length > 0) {
    lines.push(`Section: ${path.join(' > ')}.`);
  }

  const polarity = assertionPolarity(path);
  if (polarity) {
    lines.push(PREAMBLE[polarity]);
  }

  lines.push(content);
  return lines.join('\n');
}

/**
 * The exact string that should be hashed to key the embedding cache. Folding in
 * RENDER_VERSION ensures a rendering change produces a different cache key even when
 * the rendered text would otherwise collide across versions.
 */
export function embeddingHashInput(embeddingText: string): string {
  return `v${RENDER_VERSION}\n${embeddingText}`;
}

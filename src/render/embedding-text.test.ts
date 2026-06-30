/**
 * Regression tests for context-aware embedding text (issue #15, Phase 1).
 *
 * The dangerous failure mode: a bullet list under `### Negative for:` embedding as
 * free-floating positive concepts, so a denied red flag looks like a present finding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderEmbeddingText,
  assertionPolarity,
  embeddingHashInput,
  RENDER_VERSION,
} from './embedding-text.js';
import { chunkSection } from '../chunker/chunker.js';

const NEGATIVE_ROS = `- Bowel or bladder dysfunction
- Saddle anesthesia
- Progressive leg weakness`;

const POSITIVE_SYMPTOMS = `- Saddle anesthesia
- Progressive leg weakness`;

test('assertionPolarity reads negation cues from the heading path', () => {
  assert.equal(assertionPolarity(['Review of Systems', 'Negative for']), 'absent');
  assert.equal(assertionPolarity(['Neuro', 'Denies']), 'absent');
  assert.equal(assertionPolarity(['ROS', 'Positive for']), 'present');
  assert.equal(assertionPolarity(['Assessment', 'Plan']), null);
});

test('negative section preserves the denied/absent context in embedding text', () => {
  const text = renderEmbeddingText({
    headingPath: ['Review of Systems', 'Negative for'],
    content: NEGATIVE_ROS,
  });

  // Heading ancestry is present...
  assert.match(text, /Section: Review of Systems > Negative for\./);
  // ...and the polarity is made explicit...
  assert.match(text, /denied or absent/i);
  // ...without losing the original findings.
  assert.match(text, /Saddle anesthesia/);
});

test('positive section asserts presence and is distinct from the negative rendering', () => {
  const negative = renderEmbeddingText({
    headingPath: ['Review of Systems', 'Negative for'],
    content: POSITIVE_SYMPTOMS,
  });
  const positive = renderEmbeddingText({
    headingPath: ['History of Present Illness', 'Positive for'],
    content: POSITIVE_SYMPTOMS,
  });

  assert.match(positive, /present or reported/i);
  // Same body, opposite polarity → the embedding inputs must differ.
  assert.notEqual(negative, positive);
});

test('neutral heading gets a section label but no polarity claim', () => {
  const text = renderEmbeddingText({ headingPath: ['Plan'], content: 'Order MRI.' });
  assert.match(text, /Section: Plan\./);
  assert.doesNotMatch(text, /denied or absent|present or reported/i);
});

test('embedding hash input is versioned', () => {
  // Guards the cache-invalidation contract: the hashed string carries the version.
  assert.match(embeddingHashInput('hello'), new RegExp(`^v${RENDER_VERSION}\\n`));
});

test('identical bodies under different headings do NOT share an embedding cache key', () => {
  const cfg = { maxTokens: 512, overlap: 0 };

  const [denied] = chunkSection(NEGATIVE_ROS, ['Review of Systems', 'Negative for'], cfg);
  const [reported] = chunkSection(NEGATIVE_ROS, ['History of Present Illness', 'Positive for'], cfg);

  // Raw body identity is preserved (same content → same contentHash).
  assert.equal(denied.content, reported.content);
  assert.equal(denied.contentHash, reported.contentHash);

  // But the embedding input — and therefore the cache key — must diverge.
  assert.notEqual(denied.embeddingText, reported.embeddingText);
  assert.notEqual(denied.embeddingHash, reported.embeddingHash);
});

test('raw chunk content is never polluted with synthetic heading lines', () => {
  const cfg = { maxTokens: 512, overlap: 0 };
  const [chunk] = chunkSection(NEGATIVE_ROS, ['ROS', 'Negative for'], cfg);

  assert.equal(chunk.content, NEGATIVE_ROS);
  assert.doesNotMatch(chunk.content, /^Section:/m);
  assert.doesNotMatch(chunk.content, /denied or absent/i);
});

test('the embedding cache lookup pattern gives no false hit across headings', () => {
  // Mirrors build.ts: a Map keyed by embeddingHash. Caching the denied chunk must
  // not satisfy a lookup for the reported chunk with the same body.
  const cfg = { maxTokens: 512, overlap: 0 };
  const [denied] = chunkSection(NEGATIVE_ROS, ['ROS', 'Negative for'], cfg);
  const [reported] = chunkSection(NEGATIVE_ROS, ['HPI', 'Positive for'], cfg);

  const cache = new Map<string, number[]>();
  cache.set(denied.embeddingHash, [0.1, 0.2, 0.3]);

  assert.equal(cache.has(denied.embeddingHash), true);
  assert.equal(cache.has(reported.embeddingHash), false);
});

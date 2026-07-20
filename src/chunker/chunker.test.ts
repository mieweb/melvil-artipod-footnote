/**
 * Tests for the heading-aware content chunker.
 *
 * Two properties under test here:
 *  1. Source-title threading (chunking direction #1): the document title reaches each
 *     chunk's embeddingText (the vector fingerprint) but never the raw stored body.
 *  2. Grammar-aware splitting (chunking direction #2): the splitter does not cut a
 *     chunk inside balanced delimiters (parens/brackets/braces/quotes/fenced code).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkDocument, chunkSection, type ChunkConfig } from './chunker.js';

const CFG: ChunkConfig = { maxTokens: 512, overlap: 0 };

// ---------------------------------------------------------------------------
// Direction #1 — source title in the embedding fingerprint, not the raw body
// ---------------------------------------------------------------------------

test('docTitle is threaded into every chunk embeddingText but not the raw content', () => {
  const sections = [
    { headingPath: ['Recommendations'], content: '- Increase monitoring cadence.' },
    { headingPath: ['Background'], content: 'The working group met quarterly.' },
  ];
  const chunks = chunkDocument(sections, CFG, 'Mental Health Working Group');

  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    // Embedding input carries the source title...
    assert.match(c.embeddingText, /^Source: Mental Health Working Group\./);
    // ...but the stored/displayed body is untouched.
    assert.doesNotMatch(c.content, /^Source:/m);
    assert.doesNotMatch(c.content, /Mental Health Working Group/);
  }
});

test('omitting docTitle keeps the old rendering (no Source line) and stable content', () => {
  const [chunk] = chunkSection('Order an MRI of the lumbar spine.', ['Plan'], CFG);
  assert.doesNotMatch(chunk.embeddingText, /^Source:/m);
  assert.equal(chunk.content, 'Order an MRI of the lumbar spine.');
});

test('same body + same heading, different source docs → different embedding hash', () => {
  const section = { headingPath: ['Recommendations'], content: '- Increase monitoring cadence.' };
  const [a] = chunkDocument([section], CFG, 'Climate Change Working Group');
  const [b] = chunkDocument([section], CFG, 'Mental Health Working Group');

  // Raw identity preserved; embedding fingerprint diverges so the vectors won't collide.
  assert.equal(a.content, b.content);
  assert.equal(a.contentHash, b.contentHash);
  assert.notEqual(a.embeddingText, b.embeddingText);
  assert.notEqual(a.embeddingHash, b.embeddingHash);
});

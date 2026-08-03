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

import {
  chunkDocument,
  chunkSection,
  splitIntoSentences,
  splitIntoParagraphs,
  type ChunkConfig,
} from './chunker.js';

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

// ---------------------------------------------------------------------------
// Direction #2 — grammar-aware splitting (never cut inside a balanced span)
// ---------------------------------------------------------------------------

test('does not split on a period inside parentheses', () => {
  const units = splitIntoSentences('A holds (see fig. 2 and eq. 3) always. B follows.');
  assert.deepEqual(units, ['A holds (see fig. 2 and eq. 3) always.', 'B follows.']);
});

test('does not split inside brackets or braces', () => {
  assert.deepEqual(
    splitIntoSentences('Cite [Smith et al. 2020] here. Next.'),
    ['Cite [Smith et al. 2020] here.', 'Next.']
  );
  assert.deepEqual(
    splitIntoSentences('Config {a. b. c} loaded. Done.'),
    ['Config {a. b. c} loaded.', 'Done.']
  );
});

test('does not split inside double quotes', () => {
  const units = splitIntoSentences('He said "Go home. Rest now." to me. Done.');
  assert.deepEqual(units, ['He said "Go home. Rest now." to me.', 'Done.']);
});

test('a fenced code block stays a single unit — internal periods/newlines/blank lines kept', () => {
  const text = 'Intro sentence.\n```\ncode. with. periods.\n\nand newlines.\n```\nOutro sentence.';
  const units = splitIntoSentences(text);
  assert.equal(units.length, 3);
  assert.equal(units[0], 'Intro sentence.');
  assert.ok(units[1].startsWith('```') && units[1].endsWith('```'));
  assert.ok(units[1].includes('code. with. periods.') && units[1].includes('and newlines.'));
  assert.equal(units[2], 'Outro sentence.');
});

test('decimals and abbreviations mid-token are not cut (terminator must be followed by space/end)', () => {
  assert.deepEqual(
    splitIntoSentences('Give 1.5 mg now. Then rest.'),
    ['Give 1.5 mg now.', 'Then rest.']
  );
});

test('ordinary depth-0 sentences still split as before', () => {
  assert.deepEqual(splitIntoSentences('One. Two. Three.'), ['One.', 'Two.', 'Three.']);
});

test('fallback: an oversized balanced span is force-split at whitespace (never one unbounded unit)', () => {
  const big = '(' + 'word '.repeat(200).trim() + ')'; // one huge parenthetical, ~1000 chars
  const units = splitIntoSentences(big, 100);          // 100-char budget
  assert.ok(units.length > 1, 'expected the oversized span to be force-split');
  for (const u of units) assert.ok(u.length > 0);
  // No word is lost across the forced boundaries.
  const words = units.join(' ').replace(/[()]/g, '').split(/\s+/).filter(Boolean);
  assert.equal(words.length, 200);
});

test('an unbalanced quote degrades to the size-budget fallback, it does not swallow everything', () => {
  const text = 'The gauge read 5" of rain ' + 'and more '.repeat(50);
  const units = splitIntoSentences(text, 120);
  assert.ok(units.length > 1, 'unbalanced quote should still yield bounded units via fallback');
});

test('splitIntoParagraphs keeps a fenced code block (with a blank line) as one paragraph', () => {
  const md = 'Intro paragraph.\n\n```\ncode line 1\n\ncode line 2\n```\n\nOutro paragraph.';
  const paras = splitIntoParagraphs(md);
  assert.equal(paras.length, 3);
  assert.ok(paras[1].includes('code line 1') && paras[1].includes('code line 2'));
});

test('splitIntoParagraphs still splits ordinary blank-line-separated prose', () => {
  assert.deepEqual(splitIntoParagraphs('Para one.\n\nPara two.\n\nPara three.'), [
    'Para one.',
    'Para two.',
    'Para three.',
  ]);
});

test('end-to-end: a parenthetical with internal periods survives intact in exactly one chunk', () => {
  const parenthetical = '(dosing: 1.5 mg then 2.5 mg per protocol A.B.C.)';
  const sentence = `The regimen requires careful titration ${parenthetical} before discharge.`;
  const filler = 'The patient remained stable overnight with no acute events. ';
  const big = filler.repeat(8) + sentence + ' ' + filler.repeat(8);

  // maxTokens 40 -> ~160-char fallback budget, comfortably larger than the parenthetical
  // sentence (~104 chars), so the ONLY reason it could be cut is a mid-paren split.
  // The overall content (~260 tokens) still forces several chunks.
  const chunks = chunkSection(big, ['Plan'], { maxTokens: 40, overlap: 0 });
  assert.ok(chunks.length > 1, 'content should have been split into multiple chunks');
  const hits = chunks.filter(c => c.content.includes(parenthetical));
  assert.equal(hits.length, 1);
});

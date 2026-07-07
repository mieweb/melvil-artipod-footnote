/**
 * Tests for chunk-level assertion detection (issue #15, Phase 2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectAssertion } from './assertion.js';

test('heading polarity wins and is the source', () => {
  const r = detectAssertion({ headingPath: ['ROS', 'Negative for'], content: '- chest pain' });
  assert.equal(r.status, 'absent');
  assert.equal(r.source, 'heading');
});

test('body-level negation is caught under a neutral heading (the Phase-2 delta)', () => {
  const r = detectAssertion({ headingPath: ['Assessment'], content: 'Patient denies chest pain or shortness of breath.' });
  assert.equal(r.status, 'absent');
  assert.equal(r.source, 'body');
  assert.ok(r.triggers.includes('denies'));
});

test('uncertainty is distinguished as possible (heading polarity cannot express this)', () => {
  const r = detectAssertion({ headingPath: ['Assessment'], content: 'r/o pneumonia; differential diagnosis includes CHF.' });
  assert.equal(r.status, 'possible');
  assert.equal(r.source, 'body');
});

test('historical cues yield historical', () => {
  const r = detectAssertion({ headingPath: ['HPI'], content: 'Status post CABG in 2019; h/o diabetes.' });
  assert.equal(r.status, 'historical');
});

test('presence idioms yield present', () => {
  const r = detectAssertion({ headingPath: ['HPI'], content: 'Complains of severe headache; positive for photophobia.' });
  assert.equal(r.status, 'present');
});

test('uncertainty takes precedence over a nearby negation cue', () => {
  // "rule out" (possible) is checked before "denies" (absent).
  const r = detectAssertion({ headingPath: ['Assessment'], content: 'Denies trauma. Rule out fracture.' });
  assert.equal(r.status, 'possible');
});

test('general-doc prose stays unspecified — no clinical mislabeling', () => {
  // These contain common words (no, not, possible, history, without) that a naive
  // scanner would trip on. Strong-idiom-only triggers must leave them alone.
  const docs = [
    'There is no simple answer, and the history of the company is long.',
    'This is possibly the best option, without any doubt.',
    'The annual report presents strong growth and positive feedback.',
    'No known limitations were documented in the prior release notes.',
  ];
  for (const content of docs) {
    const r = detectAssertion({ headingPath: ['Overview'], content });
    assert.equal(r.status, 'unspecified', `expected unspecified for: ${content}`);
    assert.equal(r.source, 'none');
  }
});

test('slash abbreviations match as phrases, not substrings', () => {
  // "r/o" must match, but "hero" or "info" must not trip the r/o / c/o patterns.
  assert.equal(detectAssertion({ headingPath: ['A'], content: 'r/o sepsis' }).status, 'possible');
  assert.equal(detectAssertion({ headingPath: ['A'], content: 'The hero saved the day.' }).status, 'unspecified');
  assert.equal(detectAssertion({ headingPath: ['A'], content: 'See the info section.' }).status, 'unspecified');
});

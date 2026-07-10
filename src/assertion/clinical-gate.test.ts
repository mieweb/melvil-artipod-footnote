/**
 * Tests for the clinical-document gate (issue #15).
 * It must say "clinical" for real clinical chunks and "not clinical" for general docs,
 * so ambiguous symptom words are only applied where they're safe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isClinicalContext } from './clinical-gate.js';

test('clinical section headings gate as clinical', () => {
  assert.equal(isClinicalContext(['Review of Systems', 'Negative for'], 'Fever. Cough.'), true);
  assert.equal(isClinicalContext(['History of Present Illness'], 'Onset yesterday.'), true);
  assert.equal(isClinicalContext(['Past Medical History'], 'Diabetes.'), true);
});

test('clinical prose markers gate as clinical even under a neutral heading', () => {
  assert.equal(isClinicalContext(['Note'], 'The patient denies fever and weakness.'), true);
  assert.equal(isClinicalContext(['Note'], 'Presents with acute onset dizziness.'), true);
  assert.equal(isClinicalContext(['Note'], 'h/o hypertension, no acute distress.'), true);
});

test('general / business documents do NOT gate as clinical', () => {
  assert.equal(isClinicalContext(['Annual Report'], 'Revenue grew without any weakness in the core segments.'), false);
  assert.equal(isClinicalContext(['Quarterly Business Plan'], 'The committee found no cause for concern.'), false);
  assert.equal(isClinicalContext(['Overview'], 'The economy showed signs of depression and shock.'), false);
});

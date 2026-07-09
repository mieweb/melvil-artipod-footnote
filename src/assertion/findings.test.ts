/**
 * Tests for per-finding assertion extraction (issue #15, Phase 2 — bullet 2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractFindings } from './findings.js';

/** Helper: map finding name -> assertion for easy assertions. */
function byName(content: string, headingPath: string[] = ['Assessment']) {
  const map = new Map<string, string>();
  for (const f of extractFindings({ headingPath, content })) map.set(f.finding, f.assertion);
  return map;
}

test('mixed sentence: each finding is asserted independently (the bullet-2 payoff)', () => {
  const m = byName('Patient denies chest pain but reports progressive leg weakness.');
  assert.equal(m.get('chest pain'), 'absent');
  assert.equal(m.get('progressive leg weakness'), 'present');
});

test('bare negation next to a known finding is safe (anchored to the concept)', () => {
  assert.equal(byName('There is no saddle anesthesia on exam.').get('saddle anesthesia'), 'absent');
  assert.equal(byName('Patient is not having chest pain.').get('chest pain'), 'absent');
});

test('uncertainty and historical are distinguished per finding', () => {
  assert.equal(byName('Cannot rule out chest pain; will trend troponins.').get('chest pain'), 'possible');
  assert.equal(byName('History of syncope, none recently.').get('syncope'), 'historical');
});

test('bare mention defaults to present; heading polarity fills in when no local cue', () => {
  assert.equal(byName('Complains of chest pain radiating to the arm.').get('chest pain'), 'present');
  // No local cue, but the chunk lives under a "Negative for" heading.
  assert.equal(
    byName('Chest pain.', ['Review of Systems', 'Negative for']).get('chest pain'),
    'absent',
  );
});

test('aliases resolve to the canonical finding name', () => {
  const m = byName('Patient reports dyspnea on exertion.');
  assert.equal(m.get('shortness of breath'), 'present');
});

test('general-doc text produces no findings', () => {
  const findings = extractFindings({
    headingPath: ['Annual Report'],
    content: 'Revenue grew without any weakness; there is no cause for concern about growth.',
  });
  // "no", "without", "weakness", "concern" all appear — but none anchor a curated
  // clinical finding, so nothing is extracted.
  assert.deepEqual(findings, []);
});

test('scope terminator stops negation from leaking to the next finding', () => {
  // "denies" must NOT reach "hemoptysis" past the semicolon.
  const m = byName('Denies chest pain; has new hemoptysis.');
  assert.equal(m.get('chest pain'), 'absent');
  assert.equal(m.get('hemoptysis'), 'present');
});

test('negation does not leak across a sentence boundary (period)', () => {
  // Regression: a period must break scope, or "denies" flips the next sentence's finding.
  const m = byName('Denies chest pain. Reports new hemoptysis.');
  assert.equal(m.get('chest pain'), 'absent');
  assert.equal(m.get('hemoptysis'), 'present'); // NOT absent
});

test('negation/resolution stated AFTER the finding is caught', () => {
  assert.equal(byName('Chest pain, now resolved.').get('chest pain'), 'absent');
  assert.equal(byName('Chest pain was denied by the patient.').get('chest pain'), 'absent');
});

test('pseudo-negations do not negate the finding (ConText refinement)', () => {
  // "no increase in X" means X is present (just not worse); "not only X" affirms X.
  // A naive "no"/"not" scanner would wrongly mark these absent.
  assert.equal(byName('There is no increase in chest pain.').get('chest pain'), 'present');
  assert.equal(byName('Not only chest pain but also new hemoptysis.').get('chest pain'), 'present');
});

test('double negation resolves to present', () => {
  assert.equal(byName('There is no evidence to suggest absence of chest pain.').get('chest pain'), 'present');
});

test('backward-direction uncertainty is caught ("X cannot be excluded")', () => {
  assert.equal(byName('Chest pain cannot be excluded.').get('chest pain'), 'possible');
  assert.equal(byName('This is unlikely to be chest pain.').get('chest pain'), 'possible');
});

test('experiencer: a family-history finding is not attributed to the patient', () => {
  // "mother has a history of X" is about family — not present for the patient.
  assert.equal(byName('Her mother has a history of syncope.').get('syncope'), 'absent');
});

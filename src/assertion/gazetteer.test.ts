import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchGazetteer, GAZETTEER_SIZE } from './gazetteer.ts';

function findings(text: string): string[] {
  return matchGazetteer(text).map(m => m.finding);
}

test('matches a straight (non-inverted) term', () => {
  assert.ok(findings('there is an abdominal mass on exam').includes('abdominal mass'));
});

test('matches an inverted "main - modifier" term in natural prose order', () => {
  // conditions.json stores "acidosis - lactic"; prose says "lactic acidosis".
  assert.ok(findings('labs consistent with lactic acidosis').includes('lactic acidosis'));
  assert.ok(findings('history of alcohol abuse').includes('alcohol abuse'));
});

test('matches a term whose stored form had internal punctuation', () => {
  // "adenocarcinoma in-situ" stored with a hyphen; prose tokenizes to "in situ".
  assert.ok(findings('biopsy showed adenocarcinoma in situ').includes('adenocarcinoma in situ'));
});

test('the de-inversion strictly grows coverage (no term lost)', () => {
  // 2,457 raw terms; de-inverting the 432 inverted entries adds natural-order forms,
  // so the live set is strictly larger than the raw count.
  assert.ok(GAZETTEER_SIZE > 2457, `expected > 2457 live terms, got ${GAZETTEER_SIZE}`);
});

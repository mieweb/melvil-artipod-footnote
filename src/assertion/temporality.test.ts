/**
 * Tests for the temporality axis (issue #15, Phase 2 — ConText WHEN axis).
 *
 * The NegEx benchmark only exercises the in-sentence half (bare sentences, no heading).
 * These cover the part that pays off in FOOTNOTE's real pipeline: SECTION-driven
 * temporality, plus the new hypothetical status — neither expressible on the old
 * single-status assertion axis.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyTemporality, sectionTemporality } from './temporality.js';
import { extractFindings } from './findings.js';

/** Resolve temporality for a concept located by substring in the text. */
function temp(text: string, concept: string, headingPath: string[] = []) {
  const i = text.toLowerCase().indexOf(concept.toLowerCase());
  return applyTemporality(headingPath, text, i, i + concept.length).temporality;
}

test('SECTION drives historical for a bare mention with no in-sentence cue', () => {
  // "Hypertension." alone is historical ONLY because of where it sits. This is the
  // ~135 NegEx cases the sentence-only benchmark cannot reach.
  assert.equal(temp('Hypertension.', 'Hypertension', ['Past Medical History']), 'historical');
  assert.equal(temp('Atrial fibrillation.', 'Atrial fibrillation', ['PMH']), 'historical');
  assert.equal(temp('Appendectomy.', 'Appendectomy', ['Past Surgical History']), 'historical');
});

test('SECTION drives hypothetical for discharge / return-precaution instructions', () => {
  assert.equal(temp('Chest pain.', 'Chest pain', ['Discharge Instructions']), 'hypothetical');
  assert.equal(temp('Fever or chills.', 'Fever', ['Return Precautions']), 'hypothetical');
});

test('in-sentence historical cues fire without any heading', () => {
  assert.equal(temp('Patient has a history of chest pain.', 'chest pain'), 'historical');
  assert.equal(temp('Chronic low back pain, stable.', 'low back pain'), 'historical');
  assert.equal(temp('Status post CABG in 2015.', 'CABG'), 'historical');
  assert.equal(temp('She had appendicitis as a child.', 'appendicitis'), 'historical');
});

test('in-sentence hypothetical cues fire without any heading', () => {
  assert.equal(temp('Return to the ER if you develop chest pain.', 'chest pain'), 'hypothetical');
  assert.equal(temp('Will continue to monitor for hemoptysis.', 'hemoptysis'), 'hypothetical');
  assert.equal(temp('Call your doctor if you experience syncope.', 'syncope'), 'hypothetical');
});

test('a conditional frame dominates a past reference (hypothetical wins)', () => {
  // Precedence: "if you develop" outranks "history of" in the same clause.
  assert.equal(temp('Given his history, return if you develop chest pain.', 'chest pain'), 'hypothetical');
});

test('an explicit in-sentence cue overrides a neutral section; neutral defaults to recent', () => {
  assert.equal(temp('Acute onset chest pain this morning.', 'chest pain', ['HPI']), 'recent');
  assert.equal(temp('New chest pain.', 'chest pain'), 'recent');
});

test('sectionTemporality reports the structural signal directly', () => {
  assert.equal(sectionTemporality(['Past Medical History']), 'historical');
  assert.equal(sectionTemporality(['Discharge Instructions']), 'hypothetical');
  assert.equal(sectionTemporality(['Assessment']), null);
});

test('temporality is orthogonal to assertion: present+historical is expressible', () => {
  // "chronic chest pain" — the finding is PRESENT (no negation) AND historical.
  const f = extractFindings({ headingPath: ['Assessment'], content: 'Chronic chest pain, stable on medication.' })
    .find(x => x.finding === 'chest pain');
  assert.equal(f?.assertion, 'present');
  assert.equal(f?.temporality, 'historical');
});

test('absent+historical is expressible: "prior chest pain, now resolved"', () => {
  const f = extractFindings({ headingPath: ['Assessment'], content: 'Prior chest pain, now resolved.' })
    .find(x => x.finding === 'chest pain');
  assert.equal(f?.assertion, 'absent'); // "resolved" → not present now
  assert.equal(f?.temporality, 'historical'); // but it WAS a past problem
});

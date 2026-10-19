/**
 * Clinical-document gate (issue #15, Phase 2).
 *
 * FOOTNOTE indexes general documentation too, and the assertion pass runs on every chunk
 * with no clinical context. So common DUAL-USE symptom words — "fever", "weakness",
 * "discharge", "shock", "depression" — cannot be scanned everywhere without stapling
 * clinical assertions onto business/policy prose ("no weakness in the core segments").
 *
 * This decides whether a chunk is CLINICAL, so the ambiguous-symptom dictionary is only
 * applied where it is safe. Unambiguous findings (e.g. "pulmonary embolism") never need
 * the gate — they have no non-clinical meaning — so they are scanned unconditionally.
 *
 * Deliberately CONSERVATIVE: it favors precision (say "clinical" only when confident) so a
 * general document is never mistakenly treated as clinical. False negatives just fall back
 * to the unambiguous list; false positives would pollute general docs, which is worse.
 */

/** Distinctive clinical section headings (never appear as business headings). */
export const CLINICAL_SECTION =
  /\b(review of systems|ros|history of present illness|hpi|chief complaint|past medical history|pmh|past surgical history|physical exam(?:ination)?|vital signs|vitals|social history|family history|hospital course|discharge summary|progress note|differential diagnosis|history and physical|medications on admission|nkda)\b/i;

/** Distinctive clinical prose markers / abbreviations. */
export const CLINICAL_MARKER =
  /\b(h\/o|s\/p|c\/o|r\/o|nkda|wnl|the patient|denies|complains of|complaining of|presents with|on exam|physical exam|no acute distress|blood pressure|heart rate|prescribed|mg\/dl|mmhg|bpm)\b/i;

/**
 * True when the chunk is confidently clinical (safe to apply ambiguous symptom terms).
 * Signals: a distinctive clinical section heading, or clinical prose markers in the body.
 */
export function isClinicalContext(headingPath: string[], content: string): boolean {
  return CLINICAL_SECTION.test(headingPath.join(' ')) || CLINICAL_MARKER.test(content);
}

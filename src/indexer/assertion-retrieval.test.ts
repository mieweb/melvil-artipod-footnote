/**
 * Integration test (issue #15, Phase 2): build a real index from a clinical fixture
 * with the mock embedder, then prove (a) the assertion column is populated end-to-end
 * and (b) retrieval can filter it out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { buildIndex } from './build.js';
import { queryIndex } from './query.js';
import { DEFAULT_CONFIG } from '../config/schema.js';

const FIXTURE = `# Spine Consult

## Review of Systems

### Negative for:
- Saddle anesthesia
- Progressive leg weakness

## History of Present Illness

### Positive for:
- Low back pain radiating down the leg
`;

test('assertion is persisted and retrieval can exclude it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-assertion-'));
  const out = path.join(dir, '.footnote');
  try {
    fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'content', 'spine.md'), FIXTURE);

    await buildIndex({
      root: dir, content: 'content', out,
      clean: true, includeDrafts: true, filters: {},
      embeddingModel: 'mock', embeddingDim: 1536,
      maxTokens: 256, overlap: 0, compress: false, copyContent: false,
      config: DEFAULT_CONFIG,
    });

    // (a) The "Negative for" bullets must have been stored with assertion = absent.
    const all = await queryIndex({ dbPath: out, query: 'saddle anesthesia leg weakness', k: 10 });
    const denied = all.find(r => /saddle anesthesia/i.test(r.content));
    assert.ok(denied, 'expected to retrieve the saddle-anesthesia chunk');
    assert.equal(denied!.assertion, 'absent', 'negated-section chunk should be stored as absent');

    // (b) Excluding "absent" must drop it from the results.
    const filtered = await queryIndex({
      dbPath: out, query: 'saddle anesthesia leg weakness', k: 10,
      excludeAssertions: ['absent'],
    });
    assert.ok(
      !filtered.some(r => /saddle anesthesia/i.test(r.content)),
      'excludeAssertions=[absent] should drop the denied chunk',
    );
    assert.ok(
      !filtered.some(r => r.assertion === 'absent'),
      'no result should carry an excluded assertion',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('per-finding assertions persist through a real build (mixed sentence)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-findings-'));
  const out = path.join(dir, '.footnote');
  try {
    fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'content', 'ed.md'),
      '# ED Note\n\n## Assessment\n\nPatient denies chest pain but reports progressive leg weakness.\n',
    );

    await buildIndex({
      root: dir, content: 'content', out,
      clean: true, includeDrafts: true, filters: {},
      embeddingModel: 'mock', embeddingDim: 1536,
      maxTokens: 256, overlap: 0, compress: false, copyContent: false,
      config: DEFAULT_CONFIG,
    });

    // Read the persisted findings JSON straight from the DB.
    const db = new Database(path.join(out, 'index.sqlite'), { readonly: true });
    const row = db.prepare(
      `SELECT findings FROM chunks WHERE content LIKE '%chest pain%' LIMIT 1`,
    ).get() as { findings: string } | undefined;
    db.close();

    assert.ok(row, 'expected a chunk mentioning chest pain');
    const findings = JSON.parse(row!.findings) as Array<{ finding: string; assertion: string }>;
    const byName = new Map(findings.map(f => [f.finding, f.assertion]));

    assert.equal(byName.get('chest pain'), 'absent', 'denied finding stored as absent');
    assert.equal(byName.get('progressive leg weakness'), 'present', 'reported finding stored as present');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

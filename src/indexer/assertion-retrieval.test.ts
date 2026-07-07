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

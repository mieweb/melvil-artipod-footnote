/**
 * Proves the @mieweb/cloud driver glue works end-to-end: called with cloud's exact
 * `{ cfg, resolvePath }` factory shape, it yields a working CloudVectorIndex.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { footnoteVectorDriver } from './cloud-driver.js';

test('footnoteVectorDriver builds a working index from a cloud binding config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fn-driver-'));
  // Mimic @mieweb/cloud-local invoking registerDriver's factory.
  const idx = footnoteVectorDriver({
    cfg: { path: 'vec.sqlite', dim: 4, metric: 'cosine' },
    resolvePath: p => join(dir, p),
  });

  await idx.upsert([
    { id: 'a', values: [1, 0, 0, 0], metadata: { tag: 'x' } },
    { id: 'b', values: [0, 1, 0, 0], metadata: { tag: 'y' } },
  ]);

  const matches = await idx.query([1, 0, 0, 0], { topK: 1, returnMetadata: 'all' });
  assert.equal(matches.matches[0].id, 'a');
  assert.ok(matches.matches[0].score > 0.9);

  const got = await idx.getByIds(['b']);
  assert.equal(got[0].id, 'b');

  idx.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the binding config path is resolved through cloud\'s resolvePath', () => {
  let resolvedWith = '';
  const idx = footnoteVectorDriver({
    cfg: { path: 'sub/vec.sqlite', dim: 4 },
    resolvePath: p => { resolvedWith = p; return join(mkdtempSync(join(tmpdir(), 'fn-')), 'vec.sqlite'); },
  });
  assert.equal(resolvedWith, 'sub/vec.sqlite'); // driver hands the raw cfg.path to cloud's resolver
  idx.close();
});

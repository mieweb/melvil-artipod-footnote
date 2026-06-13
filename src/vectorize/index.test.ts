import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLocalIndex, LocalVectorizeIndex } from './local-index.js';
import { MockEmbedder } from '../embedder/embedder.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'footnote-vec-'));
}

function newIndex(opts: Partial<Parameters<typeof createLocalIndex>[0]> = {}): {
  idx: LocalVectorizeIndex;
  dir: string;
} {
  const dir = tmpDir();
  const idx = createLocalIndex({
    name: 'test',
    dimensions: 4,
    metric: 'cosine',
    dbDir: dir,
    ...opts,
  });
  return { idx, dir };
}

test('insert + describe + getByIds + query (round-trip)', async () => {
  const { idx } = newIndex();
  const m = await idx.insert([
    { id: 'a', values: [1, 0, 0, 0], metadata: { tag: 'x' } },
    { id: 'b', values: [0, 1, 0, 0], metadata: { tag: 'y' } },
    { id: 'c', values: [0, 0, 1, 0], metadata: { tag: 'x' } },
  ]);
  assert.equal(m.count, 3);
  assert.ok(m.mutationId);

  const desc = await idx.describe();
  assert.equal(desc.vectorsCount, 3);
  assert.equal(desc.dimensions, 4);
  assert.equal(desc.metric, 'cosine');

  const got = await idx.getByIds(['a', 'c']);
  assert.equal(got.length, 2);
  assert.deepEqual(got.find((v) => v.id === 'a')!.metadata, { tag: 'x' });

  const matches = await idx.query([1, 0, 0, 0], { topK: 2, returnMetadata: 'all' });
  assert.equal(matches.count, 2);
  assert.equal(matches.matches[0].id, 'a');
  assert.ok(matches.matches[0].score > 0.9);
  idx.close();
});

test('insert is non-overwriting on duplicate ID', async () => {
  const { idx } = newIndex();
  await idx.insert([{ id: 'a', values: [1, 0, 0, 0] }]);
  const r = await idx.insert([
    { id: 'a', values: [0, 1, 0, 0] }, // skipped
    { id: 'b', values: [0, 0, 1, 0] }, // inserted
  ]);
  assert.equal(r.count, 1);
  assert.deepEqual(r.ids, ['b']);
  const a = (await idx.getByIds(['a']))[0];
  assert.deepEqual(Array.from(a.values as number[]), [1, 0, 0, 0]);
  idx.close();
});

test('upsert replaces existing vector in full', async () => {
  const { idx } = newIndex();
  await idx.insert([{ id: 'a', values: [1, 0, 0, 0], metadata: { old: true } }]);
  await idx.upsert([{ id: 'a', values: [0, 1, 0, 0], metadata: { new: true } }]);
  const a = (await idx.getByIds(['a']))[0];
  assert.deepEqual(a.metadata, { new: true });
  assert.deepEqual(Array.from(a.values as number[]), [0, 1, 0, 0]);
  idx.close();
});

test('deleteByIds removes vector + reports count', async () => {
  const { idx } = newIndex();
  await idx.insert([
    { id: 'a', values: [1, 0, 0, 0] },
    { id: 'b', values: [0, 1, 0, 0] },
  ]);
  const r = await idx.deleteByIds(['a', 'missing']);
  assert.equal(r.count, 1);
  assert.deepEqual(r.ids, ['a']);
  const after = await idx.describe();
  assert.equal(after.vectorsCount, 1);
  idx.close();
});

test('query metadata filter ($eq, $in, range)', async () => {
  const { idx } = newIndex();
  await idx.insert([
    { id: '1', values: [1, 0, 0, 0], metadata: { platform: 'netflix', rating: 8 } },
    { id: '2', values: [1, 0, 0, 0], metadata: { platform: 'hbo', rating: 9 } },
    { id: '3', values: [1, 0, 0, 0], metadata: { platform: 'amazon', rating: 6 } },
  ]);
  const netflix = await idx.query([1, 0, 0, 0], {
    topK: 10,
    filter: { platform: 'netflix' },
    returnMetadata: 'all',
  });
  assert.deepEqual(netflix.matches.map((m) => m.id), ['1']);

  const inList = await idx.query([1, 0, 0, 0], {
    topK: 10,
    filter: { platform: { $in: ['netflix', 'hbo'] } },
  });
  assert.equal(inList.count, 2);

  const range = await idx.query([1, 0, 0, 0], {
    topK: 10,
    filter: { rating: { $gte: 8 } },
  });
  assert.equal(range.count, 2);
  idx.close();
});

test('namespace isolation', async () => {
  const { idx } = newIndex();
  await idx.insert([
    { id: '1', values: [1, 0, 0, 0], namespace: 'tenantA' },
    { id: '2', values: [1, 0, 0, 0], namespace: 'tenantB' },
  ]);
  const a = await idx.query([1, 0, 0, 0], { topK: 10, namespace: 'tenantA' });
  assert.deepEqual(a.matches.map((m) => m.id), ['1']);
  idx.close();
});

test('dimension mismatch rejected', async () => {
  const { idx } = newIndex();
  await assert.rejects(idx.insert([{ id: 'a', values: [1, 2] }]), /dimensions/);
  idx.close();
});

test('topK > 100 rejected', async () => {
  const { idx } = newIndex();
  await idx.insert([{ id: 'a', values: [1, 0, 0, 0] }]);
  await assert.rejects(idx.query([1, 0, 0, 0], { topK: 200 }), /topK/);
  idx.close();
});

test('topK > 50 with returnValues rejected', async () => {
  const { idx } = newIndex();
  await idx.insert([{ id: 'a', values: [1, 0, 0, 0] }]);
  await assert.rejects(
    idx.query([1, 0, 0, 0], { topK: 80, returnValues: true }),
    /topK/
  );
  idx.close();
});

test('returnValues and returnMetadata flags honored', async () => {
  const { idx } = newIndex();
  await idx.insert([{ id: 'a', values: [1, 0, 0, 0], metadata: { x: 1 } }]);
  const none = await idx.query([1, 0, 0, 0], { topK: 1 });
  assert.equal(none.matches[0].values, undefined);
  assert.equal(none.matches[0].metadata, undefined);

  const full = await idx.query([1, 0, 0, 0], {
    topK: 1,
    returnValues: true,
    returnMetadata: 'all',
  });
  assert.ok(Array.isArray(full.matches[0].values));
  assert.deepEqual(full.matches[0].metadata, { x: 1 });
  idx.close();
});

test('queryById returns matches for stored vector', async () => {
  const { idx } = newIndex();
  await idx.insert([
    { id: 'a', values: [1, 0, 0, 0] },
    { id: 'b', values: [0.99, 0.01, 0, 0] },
  ]);
  const r = await idx.queryById('a', { topK: 2 });
  assert.equal(r.matches[0].id, 'a');
  assert.equal(r.matches[1].id, 'b');
  idx.close();
});

test('listVectors paginates with cursor', async () => {
  const { idx } = newIndex();
  await idx.insert(
    Array.from({ length: 5 }, (_, i) => ({
      id: `id-${i}`,
      values: [i, 0, 0, 0],
    }))
  );
  const page1 = await idx.listVectors({ count: 2 });
  assert.equal(page1.count, 2);
  assert.ok(page1.isTruncated);
  const page2 = await idx.listVectors({ count: 2, cursor: page1.cursor });
  assert.equal(page2.count, 2);
  assert.notDeepEqual(page1.vectors, page2.vectors);
  idx.close();
});

test('metadata index CRUD + 10-cap', async () => {
  const { idx } = newIndex();
  await idx.createMetadataIndex({ propertyName: 'a', indexType: 'string' });
  const listed = await idx.listMetadataIndexes();
  assert.equal(listed.metadataIndexes.length, 1);

  for (let i = 0; i < 9; i++) {
    await idx.createMetadataIndex({
      propertyName: `p${i}`,
      indexType: 'number',
    });
  }
  await assert.rejects(
    idx.createMetadataIndex({ propertyName: 'overflow', indexType: 'boolean' }),
    /10/
  );

  await idx.deleteMetadataIndex({ propertyName: 'a' });
  const after = await idx.listMetadataIndexes();
  assert.equal(after.metadataIndexes.find((m) => m.propertyName === 'a'), undefined);
  idx.close();
});

test('auto-embed: { text } uses configured embedder', async () => {
  const dir = tmpDir();
  const embedder = new MockEmbedder(4);
  const idx = createLocalIndex({
    name: 'auto',
    dimensions: 4,
    metric: 'cosine',
    dbDir: dir,
    embedder,
  });
  await idx.upsert([
    { id: 'a', text: 'hello' },
    { id: 'b', text: 'world' },
  ]);
  const matches = await idx.query('hello', { topK: 1 });
  assert.equal(matches.matches[0].id, 'a');
  idx.close();
});

test('auto-embed without embedder rejected', async () => {
  const { idx } = newIndex();
  await assert.rejects(idx.insert([{ id: 'a', text: 'no embedder' }]), /embedder/);
  await assert.rejects(idx.query('text query'), /embedder/);
  idx.close();
});

test('reopen existing index with mismatched dims rejected', async () => {
  const { idx, dir } = newIndex();
  await idx.insert([{ id: 'a', values: [1, 0, 0, 0] }]);
  idx.close();
  assert.throws(
    () =>
      createLocalIndex({
        name: 'test',
        dimensions: 8,
        metric: 'cosine',
        dbDir: dir,
      }),
    /dimensions/
  );
});

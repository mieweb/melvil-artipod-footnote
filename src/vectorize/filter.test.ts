import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { compileFilter } from './filter.js';

test('compileFilter: undefined → null', () => {
  assert.equal(compileFilter(undefined), null);
});

test('compileFilter: empty object throws', () => {
  assert.throws(() => compileFilter({}));
});

test('compileFilter: implicit $eq', () => {
  const r = compileFilter({ platform: 'netflix' })!;
  assert.equal(r.sql, 'json_extract(metadata, ?) = ?');
  assert.deepEqual(r.params, ['$.platform', 'netflix']);
});

test('compileFilter: explicit $ne includes missing keys', () => {
  const r = compileFilter({ platform: { $ne: 'hbo' } })!;
  assert.match(r.sql, /IS NULL OR.*!= \?/);
  assert.deepEqual(r.params, ['$.platform', '$.platform', 'hbo']);
});

test('compileFilter: $in / $nin', () => {
  const a = compileFilter({ p: { $in: ['hbo', 'netflix'] } })!;
  assert.match(a.sql, /IN \(\?, \?\)/);
  const b = compileFilter({ p: { $nin: ['hbo', 'netflix'] } })!;
  assert.match(b.sql, /IS NULL OR.*NOT IN/);
});

test('compileFilter: range operators', () => {
  const r = compileFilter({ ts: { $gte: 1, $lt: 100 } })!;
  // both clauses present, joined by AND
  assert.match(r.sql, /json_extract\(metadata, \?\) >= \?/);
  assert.match(r.sql, /json_extract\(metadata, \?\) < \?/);
});

test('compileFilter: dotted nesting → JSON path', () => {
  const r = compileFilter({ 'pandas.nice': 42 })!;
  assert.deepEqual(r.params, ['$.pandas.nice', 42]);
});

test('compileFilter: implicit AND on multiple keys', () => {
  const r = compileFilter({ a: 1, b: { $ne: 2 } })!;
  assert.equal(r.sql.split(' AND ').length, 2);
});

test('compileFilter: key starting with $ rejected', () => {
  assert.throws(() => compileFilter({ $bad: 1 }));
});

test('compileFilter: filter exceeding 2048 bytes rejected', () => {
  const huge = { k: 'x'.repeat(3000) };
  assert.throws(() => compileFilter(huge), /2048/);
});

test('compileFilter: mixing range and equality operators rejected', () => {
  assert.throws(() =>
    compileFilter({ ts: { $gt: 1, $eq: 5 } as never })
  );
});

test('compileFilter: boolean value coerced to 0/1', () => {
  const r = compileFilter({ active: true })!;
  assert.deepEqual(r.params, ['$.active', 1]);
});

/**
 * `npx footnote` CLI — mirrors `wrangler vectorize` subcommands against a
 * local sqlite-backed Vectorize index.
 */
import * as fs from 'fs';
import * as path from 'path';
import minimist from 'minimist';
import Database from 'better-sqlite3';
import { createLocalIndex, type LocalVectorizeIndex } from './local-index.js';
import type {
  VectorizeDistanceMetric,
  VectorizeMetadataIndexType,
  VectorizeVector,
} from './types.js';

const argv = minimist(process.argv.slice(2), {
  string: [
    'db-dir',
    'metric',
    'file',
    'vector',
    'filter',
    'namespace',
    'ids',
    'cursor',
    'return-metadata',
    'property-name',
    'type',
  ],
  boolean: ['return-values', 'help'],
  alias: { h: 'help' },
  default: { 'db-dir': './.footnote' },
});

const [resource, action, name, ...rest] = argv._;

async function main(): Promise<void> {
  if (argv.help || !resource) {
    printUsage();
    return;
  }
  if (resource !== 'vectorize') {
    fail(`unknown resource: ${resource}. expected: vectorize`);
  }
  if (!action) {
    printUsage();
    return;
  }
  if (!name && !['help'].includes(String(action))) {
    fail(`missing index name. usage: footnote vectorize ${action} <name> ...`);
  }

  switch (action) {
    case 'create':
      return create(String(name));
    case 'info':
    case 'describe':
      return info(String(name));
    case 'insert':
      return insertOrUpsert(String(name), false);
    case 'upsert':
      return insertOrUpsert(String(name), true);
    case 'query':
      return query(String(name));
    case 'get-by-ids':
      return getByIds(String(name));
    case 'delete-by-ids':
      return deleteByIds(String(name));
    case 'list-vectors':
      return listVectors(String(name));
    case 'create-metadata-index':
      return createMetadataIndex(String(name));
    case 'delete-metadata-index':
      return deleteMetadataIndex(String(name));
    case 'list-metadata-index':
      return listMetadataIndexes(String(name));
    default:
      fail(`unknown vectorize action: ${action}`);
  }
}

function openIndex(name: string, opts: { dimensions?: number; metric?: VectorizeDistanceMetric } = {}): LocalVectorizeIndex {
  const dbDir = String(argv['db-dir']);
  const dbPath = path.join(dbDir, `${name}.sqlite`);
  if (!opts.dimensions || !opts.metric) {
    // Open existing — derive dims/metric from the stored meta.
    if (!fs.existsSync(dbPath)) {
      fail(`index '${name}' not found at ${dbPath}. Run: footnote vectorize create ${name} --dimensions=N --metric=cosine`);
    }
    // Probe the meta table directly without going through VectorizeStore's
    // constructor (which requires dims/metric up front).
    const probe = new Database(dbPath, { readonly: true });
    const dimRow = probe
      .prepare(`SELECT value FROM index_meta WHERE key='dimensions'`)
      .get() as { value: string } | undefined;
    const metricRow = probe
      .prepare(`SELECT value FROM index_meta WHERE key='metric'`)
      .get() as { value: string } | undefined;
    probe.close();
    if (!dimRow || !metricRow) {
      fail(`index '${name}' is missing metadata; re-create it.`);
    }
    opts.dimensions = Number(dimRow.value);
    opts.metric = metricRow.value as VectorizeDistanceMetric;
  }
  return createLocalIndex({
    name,
    dimensions: opts.dimensions!,
    metric: opts.metric!,
    dbDir,
  });
}

async function create(name: string): Promise<void> {
  const dimensions = Number(argv.dimensions);
  const metric = String(argv.metric ?? 'cosine') as VectorizeDistanceMetric;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    fail('--dimensions=<int> is required');
  }
  if (!['cosine', 'euclidean', 'dot-product'].includes(metric)) {
    fail(`--metric must be cosine | euclidean | dot-product`);
  }
  const idx = openIndex(name, { dimensions, metric });
  const desc = await idx.describe();
  idx.close();
  console.log(JSON.stringify({ created: name, ...desc }, null, 2));
}

async function info(name: string): Promise<void> {
  const idx = openIndex(name);
  const desc = await idx.describe();
  const meta = await idx.listMetadataIndexes();
  idx.close();
  console.log(JSON.stringify({ name, ...desc, metadataIndexes: meta.metadataIndexes }, null, 2));
}

async function insertOrUpsert(name: string, overwrite: boolean): Promise<void> {
  const file = argv.file;
  if (!file) fail('--file=<path.ndjson> is required');
  const text = fs.readFileSync(String(file), 'utf8');
  const vectors: VectorizeVector[] = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as VectorizeVector;
      } catch (e) {
        fail(`line ${i + 1}: invalid JSON: ${(e as Error).message}`);
      }
    });

  const idx = openIndex(name);
  const r = overwrite ? await idx.upsert(vectors) : await idx.insert(vectors);
  idx.close();
  console.log(JSON.stringify(r, null, 2));
}

async function query(name: string): Promise<void> {
  const vec = parseVectorArg(argv.vector);
  const opts = {
    topK: argv['top-k'] !== undefined ? Number(argv['top-k']) : undefined,
    returnValues: Boolean(argv['return-values']),
    returnMetadata: (argv['return-metadata'] as 'none' | 'indexed' | 'all') ?? 'none',
    namespace: argv.namespace ? String(argv.namespace) : undefined,
    filter: argv.filter ? JSON.parse(String(argv.filter)) : undefined,
  };
  const idx = openIndex(name);
  const matches = await idx.query(vec, opts);
  idx.close();
  console.log(JSON.stringify(matches, null, 2));
}

async function getByIds(name: string): Promise<void> {
  const ids = parseIds(argv.ids);
  const idx = openIndex(name);
  const out = await idx.getByIds(ids);
  idx.close();
  console.log(JSON.stringify(out, null, 2));
}

async function deleteByIds(name: string): Promise<void> {
  const ids = parseIds(argv.ids);
  const idx = openIndex(name);
  const out = await idx.deleteByIds(ids);
  idx.close();
  console.log(JSON.stringify(out, null, 2));
}

async function listVectors(name: string): Promise<void> {
  const idx = openIndex(name);
  const out = await idx.listVectors({
    count: argv.count ? Number(argv.count) : undefined,
    cursor: argv.cursor ? String(argv.cursor) : undefined,
  });
  idx.close();
  console.log(JSON.stringify(out, null, 2));
}

async function createMetadataIndex(name: string): Promise<void> {
  const propertyName = String(argv['property-name'] ?? '');
  const indexType = String(argv.type ?? '') as VectorizeMetadataIndexType;
  if (!propertyName) fail('--property-name is required');
  if (!['string', 'number', 'boolean'].includes(indexType)) {
    fail('--type must be string | number | boolean');
  }
  const idx = openIndex(name);
  const r = await idx.createMetadataIndex({ propertyName, indexType });
  idx.close();
  console.log(JSON.stringify(r, null, 2));
}

async function deleteMetadataIndex(name: string): Promise<void> {
  const propertyName = String(argv['property-name'] ?? '');
  if (!propertyName) fail('--property-name is required');
  const idx = openIndex(name);
  const r = await idx.deleteMetadataIndex({ propertyName });
  idx.close();
  console.log(JSON.stringify(r, null, 2));
}

async function listMetadataIndexes(name: string): Promise<void> {
  const idx = openIndex(name);
  const r = await idx.listMetadataIndexes();
  idx.close();
  console.log(JSON.stringify(r, null, 2));
}

function parseVectorArg(v: unknown): number[] {
  if (!v) fail('--vector is required (JSON array or @path/to/file.json)');
  const raw = String(v);
  const json = raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw;
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === 'number')) {
    fail('--vector must be a JSON array of numbers');
  }
  return parsed;
}

function parseIds(v: unknown): string[] {
  if (!v) fail('--ids=id1,id2,...');
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function printUsage(): void {
  console.log(`footnote — local Cloudflare Vectorize-compatible index

Usage:
  footnote vectorize <action> <name> [options]

Actions:
  create <name> --dimensions=N --metric=cosine|euclidean|dot-product
  info <name>
  insert|upsert <name> --file=vectors.ndjson
  query <name> --vector=@vec.json [--top-k=5] [--return-values]
               [--return-metadata=none|indexed|all] [--filter='{...}'] [--namespace=ns]
  get-by-ids <name> --ids=id1,id2,...
  delete-by-ids <name> --ids=id1,id2,...
  list-vectors <name> [--count=100] [--cursor=...]
  create-metadata-index <name> --property-name=key --type=string|number|boolean
  delete-metadata-index <name> --property-name=key
  list-metadata-index <name>

Options:
  --db-dir=<path>   Directory for sqlite files. Default: ./.footnote
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

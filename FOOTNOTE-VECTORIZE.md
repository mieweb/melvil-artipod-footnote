# FOOTNOTE Vectorize

A Cloudflare [Vectorize](https://developers.cloudflare.com/vectorize/)-compatible vector database that runs **locally** (Node + SQLite) or **on Cloudflare Workers** (real Vectorize binding) — from the **same handler code**.

Ship a Hono app that uses `env.MY_INDEX.query(...)`; in dev it talks to a local `sqlite-vec` file under `./.footnote/`, in prod it talks to Cloudflare Vectorize. No code changes.

## Install

```bash
npm install @mieweb/footnote
# Optional, only if you use the Hono adapter:
npm install hono
```

## Quick start (local, Node)

```ts
import { Hono } from 'hono';
import { createLocalIndex, vectorizeBindings } from '@mieweb/footnote/vectorize/hono';

const MY_INDEX = createLocalIndex({
  name: 'demo',           // file: ./.footnote/demo.sqlite
  dimensions: 768,
  metric: 'cosine',
});

const app = new Hono();
app.use('*', vectorizeBindings({ MY_INDEX }));

app.post('/search', async (c) => {
  const { query } = await c.req.json();
  const matches = await c.env.MY_INDEX.query(query, {
    topK: 5,
    returnMetadata: 'all',
  });
  return c.json(matches);
});

export default app;
```

## Quick start (Cloudflare Workers)

Same handler. Replace the bootstrap:

```toml
# wrangler.toml
[[vectorize]]
binding = "MY_INDEX"
index_name = "demo"
```

```ts
// Workers entry — no vectorizeBindings middleware
import { Hono } from 'hono';
const app = new Hono<{ Bindings: { MY_INDEX: VectorizeIndex } }>();
// ...same routes...
export default app;
```

## API parity

`LocalVectorizeIndex` implements the [Vectorize binding interface](https://developers.cloudflare.com/vectorize/reference/client-api/). Method signatures and return shapes match Cloudflare exactly.

| Operation | Local | Cloudflare |
|---|---|---|
| `insert(vectors)` | ✅ | ✅ |
| `upsert(vectors)` | ✅ | ✅ |
| `query(vector, opts)` | ✅ | ✅ |
| `queryById(id, opts)` | ✅ | ✅ |
| `getByIds(ids)` | ✅ | ✅ |
| `deleteByIds(ids)` | ✅ | ✅ |
| `describe()` | ✅ | ✅ |
| `createMetadataIndex({ propertyName, indexType })` | ✅ | ✅ |
| `deleteMetadataIndex({ propertyName })` | ✅ | ✅ |
| `listMetadataIndexes()` | ✅ | ✅ |
| `listVectors({ count, cursor })` | ✅ | ✅ (preview) |

Mutations return `{ mutationId, count }`. Locally they are committed synchronously; `describe().processedUpToMutation` always reflects the latest mutation.

### Query options

```ts
type VectorizeQueryOptions = {
  topK?: number;                                   // default 5, max 100 (50 if values/all metadata)
  namespace?: string;
  returnValues?: boolean;                          // default false
  returnMetadata?: 'none' | 'indexed' | 'all';     // default 'none'
  filter?: VectorizeMetadataFilter;
};
```

### Metadata filter operators

`$eq`, `$ne`, `$in`, `$nin`, `$lt`, `$lte`, `$gt`, `$gte`. Implicit AND across keys. Dotted keys (`pandas.nice`) describe nesting. Filter JSON must be ≤ 2048 bytes. Behavior matches Cloudflare's [metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/) spec.

```ts
await env.MY_INDEX.query(vec, {
  topK: 3,
  filter: { streaming_platform: 'netflix', 'rating.imdb': { $gte: 7 } },
});
```

### Distance metrics

`cosine`, `euclidean`, `dot-product`. Set at index creation; immutable thereafter.

### Namespaces

Per-vector partition key. Filtered before metadata filters.

## Extension: auto-embed `{ text }`

A FOOTNOTE-only convenience. If you pass `{ text }` instead of `{ values }`, the index calls your configured embedder. Strict-parity callers (using `{ values }`) get identical behavior to Cloudflare.

```ts
const MY_INDEX = createLocalIndex({
  name: 'demo',
  dimensions: 768,
  metric: 'cosine',
  embedder: { model: 'ollama:nomic-embed-text' },  // or 'text-embedding-3-small', etc.
});

await MY_INDEX.upsert([
  { id: '1', text: 'Patient registration workflow', metadata: { doc: 'reg.md' } },
]);

const matches = await MY_INDEX.query('how do I register a patient?', { topK: 5 });
```

Auto-embed is rejected on Workers (no embedder available in the binding); pre-embed before insert or use Workers AI yourself.

## CLI: `npx footnote vectorize`

Mirrors `wrangler vectorize` subcommands. All commands operate on `./.footnote/<name>.sqlite` unless `--db-dir` is set.

```bash
# Create an index
npx footnote vectorize create demo --dimensions=768 --metric=cosine

# Insert / upsert from NDJSON ({"id":"1","values":[...],"metadata":{...}} per line)
npx footnote vectorize insert demo --file=vectors.ndjson
npx footnote vectorize upsert demo --file=vectors.ndjson

# Query
npx footnote vectorize query demo \
  --vector=@query.json \
  --top-k=5 \
  --return-metadata=all \
  --filter='{"streaming_platform":"netflix"}'

# By ID
npx footnote vectorize get-by-ids demo --ids=1,2,3
npx footnote vectorize delete-by-ids demo --ids=1,2,3
npx footnote vectorize list-vectors demo --count=100 [--cursor=...]

# Inspect
npx footnote vectorize info demo

# Metadata indexes
npx footnote vectorize create-metadata-index demo --property-name=url --type=string
npx footnote vectorize delete-metadata-index demo --property-name=url
npx footnote vectorize list-metadata-index demo
```

## Storage layout

```
./.footnote/
  demo.sqlite          # one file per index
  prod-search.sqlite
```

Each `.sqlite` is self-contained: vectors (`sqlite-vec` `vec0` virtual table), metadata (JSON), metadata-index registry, and index config (dimensions/metric/created_at). Portable across machines.

## Limits

| | Local | Cloudflare |
|---|---|---|
| `topK` | 100 (50 if `returnValues` or `returnMetadata: 'all'`) | same |
| Metadata per vector | 10 KiB (advisory) | 10 KiB |
| Metadata indexes per index | 10 | 10 |
| Filter JSON size | 2048 bytes | 2048 bytes |
| Dimensions | any | model-dependent |

## Programmatic API

```ts
import { createLocalIndex, type VectorizeIndex } from '@mieweb/footnote/vectorize';

const index: VectorizeIndex = createLocalIndex({
  name: 'demo',
  dimensions: 768,
  metric: 'cosine',
  dbDir: './.footnote',     // optional, default
  embedder: { model: 'mock', dimension: 768 }, // optional
});
```

## Compatibility notes

- Cloudflare Vectorize is **eventually consistent** (~seconds). Local is **immediately consistent**. Don't rely on read-your-write behavior in tests if you also target Cloudflare.
- `Float32Array` / `Float64Array` / `number[]` all accepted; stored as Float32 to match `vec0`.
- Insert is non-overwriting on ID conflict (matches Cloudflare). Use `upsert` to replace.

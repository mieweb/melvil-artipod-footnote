/**
 * Vectorize metadata filter compiler.
 *
 * Translates a `VectorizeMetadataFilter` (see types.ts) into a SQL WHERE
 * fragment over a JSON column named `metadata`. Operators supported:
 *   $eq, $ne, $in, $nin, $lt, $lte, $gt, $gte
 *
 * Behavior mirrors:
 * https://developers.cloudflare.com/vectorize/reference/metadata-filtering/
 */
import {
  FILTER_MAX_BYTES,
  type VectorizeFilterOperators,
  type VectorizeMetadataFilter,
  type VectorizeMetadataValue,
} from './types.js';

export interface CompiledFilter {
  sql: string;
  params: Array<string | number>;
}

const COMPARISON_OPS = new Set([
  '$eq',
  '$ne',
  '$in',
  '$nin',
  '$lt',
  '$lte',
  '$gt',
  '$gte',
]);

const RANGE_OPS = new Set(['$lt', '$lte', '$gt', '$gte']);

/**
 * Compile a Vectorize filter object into a SQL fragment + bound params.
 * Returns `null` for an empty/undefined filter (caller should omit WHERE).
 *
 * The SQL references one column: `metadata` (JSON TEXT column).
 */
export function compileFilter(
  filter: VectorizeMetadataFilter | undefined | null
): CompiledFilter | null {
  if (filter === undefined || filter === null) return null;
  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw new Error('filter must be a non-empty object');
  }
  const keys = Object.keys(filter);
  if (keys.length === 0) {
    throw new Error('filter must be a non-empty object');
  }

  const json = JSON.stringify(filter);
  if (Buffer.byteLength(json, 'utf8') > FILTER_MAX_BYTES) {
    throw new Error(
      `filter JSON exceeds ${FILTER_MAX_BYTES} byte limit`
    );
  }

  const clauses: string[] = [];
  const params: Array<string | number> = [];

  for (const key of keys) {
    validateKey(key);
    const path = jsonPath(key);
    const value = filter[key];

    if (isOperatorObject(value)) {
      const opClauses = compileOperators(path, value);
      for (const c of opClauses) {
        clauses.push(c.sql);
        params.push(...c.params);
      }
    } else {
      // implicit $eq
      const c = compileEq(path, value as VectorizeMetadataValue);
      clauses.push(c.sql);
      params.push(...c.params);
    }
  }

  return { sql: clauses.join(' AND '), params };
}

function validateKey(key: string): void {
  if (!key) throw new Error('filter key cannot be empty');
  if (key.length > 512) throw new Error(`filter key '${key}' is too long`);
  if (key.startsWith('$')) {
    throw new Error(`filter key '${key}' cannot start with $`);
  }
  if (/["|]/.test(key)) {
    throw new Error(`filter key '${key}' contains invalid characters`);
  }
}

function jsonPath(key: string): string {
  // dotted keys describe nesting: "pandas.nice" -> $.pandas.nice
  // sqlite json_extract uses $.a.b syntax
  return '$.' + key;
}

function isOperatorObject(v: unknown): v is VectorizeFilterOperators {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v as object);
  if (keys.length === 0) return false;
  return keys.every((k) => COMPARISON_OPS.has(k));
}

function compileOperators(
  path: string,
  ops: VectorizeFilterOperators
): CompiledFilter[] {
  const out: CompiledFilter[] = [];

  // Combine lower and upper bound range ops into one extraction; other
  // combinations are not allowed by Cloudflare semantics.
  const lower = (ops.$gt !== undefined ? '$gt' : ops.$gte !== undefined ? '$gte' : null) as
    | '$gt'
    | '$gte'
    | null;
  const upper = (ops.$lt !== undefined ? '$lt' : ops.$lte !== undefined ? '$lte' : null) as
    | '$lt'
    | '$lte'
    | null;
  const hasOther = Object.keys(ops).some(
    (k) => !RANGE_OPS.has(k)
  );
  if ((lower || upper) && hasOther) {
    throw new Error(
      'range operators ($lt/$lte/$gt/$gte) cannot be combined with non-range operators'
    );
  }

  for (const [op, raw] of Object.entries(ops) as Array<
    [keyof VectorizeFilterOperators, unknown]
  >) {
    switch (op) {
      case '$eq':
        out.push(compileEq(path, raw as VectorizeMetadataValue));
        break;
      case '$ne':
        out.push(compileNe(path, raw as VectorizeMetadataValue));
        break;
      case '$in':
        out.push(compileInList(path, raw as VectorizeMetadataValue[], false));
        break;
      case '$nin':
        out.push(compileInList(path, raw as VectorizeMetadataValue[], true));
        break;
      case '$lt':
      case '$lte':
      case '$gt':
      case '$gte':
        out.push(compileRange(path, op, raw as string | number));
        break;
      default:
        throw new Error(`unknown operator: ${String(op)}`);
    }
  }
  return out;
}

function compileEq(path: string, value: VectorizeMetadataValue): CompiledFilter {
  if (value === null) {
    return {
      sql: `(json_extract(metadata, ?) IS NULL OR json_type(metadata, ?) = 'null')`,
      params: [path, path],
    };
  }
  return {
    sql: `json_extract(metadata, ?) = ?`,
    params: [path, toSqlScalar(value)],
  };
}

function compileNe(path: string, value: VectorizeMetadataValue): CompiledFilter {
  if (value === null) {
    return {
      sql: `(json_extract(metadata, ?) IS NOT NULL AND json_type(metadata, ?) != 'null')`,
      params: [path, path],
    };
  }
  return {
    // NE matches missing keys too (Cloudflare treats missing as not-equal)
    sql: `(json_extract(metadata, ?) IS NULL OR json_extract(metadata, ?) != ?)`,
    params: [path, path, toSqlScalar(value)],
  };
}

function compileInList(
  path: string,
  values: VectorizeMetadataValue[],
  negate: boolean
): CompiledFilter {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`$in/$nin requires a non-empty array`);
  }
  const placeholders = values.map(() => '?').join(', ');
  const op = negate ? 'NOT IN' : 'IN';
  // For negate, also include missing keys (treated as not-in)
  const sql = negate
    ? `(json_extract(metadata, ?) IS NULL OR json_extract(metadata, ?) NOT IN (${placeholders}))`
    : `json_extract(metadata, ?) ${op} (${placeholders})`;
  const params: Array<string | number> = negate
    ? [path, path, ...values.map(toSqlScalar)]
    : [path, ...values.map(toSqlScalar)];
  return { sql, params };
}

function compileRange(
  path: string,
  op: '$lt' | '$lte' | '$gt' | '$gte',
  value: string | number
): CompiledFilter {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${op} value must be string or number`);
  }
  const sqlOp = { $lt: '<', $lte: '<=', $gt: '>', $gte: '>=' }[op];
  return {
    sql: `json_extract(metadata, ?) ${sqlOp} ?`,
    params: [path, value],
  };
}

function toSqlScalar(v: VectorizeMetadataValue): string | number {
  if (v === null) {
    throw new Error('null value not supported here');
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' || typeof v === 'number') return v;
  throw new Error(`unsupported filter value type: ${typeof v}`);
}

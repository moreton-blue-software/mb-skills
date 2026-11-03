// Select Date transport paths from Core's runtime structural input schema.
// This is not a replacement for the procedure's validation or permission checks.

type Schema = Record<string, unknown>;
type Plan = Map<string, { path: string[]; date: boolean }>;
const record = (value: unknown): value is Schema =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keyFor = (path: string[]) => path.map(key => key.replace(/\\/g, '\\\\').replace(/\./g, '\\.')).join('.');
const invalid = () => new Error('Date input is invalid or has ambiguous schema branches; use an explicit ISO timestamp with timezone and an unambiguous contract');

function hasDate(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(hasDate);
  return record(schema) && (schema['x-superjson'] === 'Date' || Object.values(schema).some(hasDate));
}

function merge(target: Plan, source: Plan): void {
  for (const [key, entry] of source) {
    const previous = target.get(key);
    if (previous && previous.date !== entry.date) throw invalid();
    target.set(key, entry);
  }
}

// Only structural exclusions select a union branch. Unrepresented refinements
// cannot prove a branch ineligible, so different remaining Date plans refuse.
function plan(value: unknown, schema: unknown, path: string[]): Plan | undefined {
  if (schema === false) return undefined;
  if (!record(schema)) return new Map();
  if ('$ref' in schema) throw invalid(); // Runtime discovery does not emit refs.
  if (record(schema.not) && Object.keys(schema.not).length === 0) return undefined;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return undefined;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return undefined;
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (typeof schema.type === 'string' && schema.type !== type
    && !(schema.type === 'integer' && typeof value === 'number' && Number.isInteger(value))) return undefined;

  const result: Plan = new Map();
  if (schema['x-superjson'] === 'Date') {
    if (typeof value !== 'string') return undefined;
    result.set(keyFor(path), { path, date: true });
  } else if (type !== 'object' && type !== 'array' && (schema.type || schema.enum || Object.hasOwn(schema, 'const'))) {
    result.set(keyFor(path), { path, date: false });
  }
  if (record(value)) {
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key === 'string' && !Object.hasOwn(value, key))) return undefined;
    for (const [key, child] of Object.entries(value)) {
      const properties = record(schema.properties) ? schema.properties : {};
      const childSchema = Object.hasOwn(properties, key) ? properties[key] : schema.additionalProperties;
      // additionalProperties:false also represents Zod's strip behavior, not
      // only strict objects; unknown keys must not select a union branch.
      if (!record(childSchema)) continue;
      const childPlan = plan(child, childSchema, [...path, key]);
      if (!childPlan) return undefined;
      merge(result, childPlan);
    }
  } else if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return undefined;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return undefined;
    for (let index = 0; index < value.length; index++) {
      const childSchema = Array.isArray(schema.prefixItems) && index < schema.prefixItems.length
        ? schema.prefixItems[index] : schema.items;
      const childPlan = plan(value[index], childSchema, [...path, String(index)]);
      if (!childPlan) return undefined;
      merge(result, childPlan);
    }
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    if (!Array.isArray(schema[keyword])) continue;
    const candidates = schema[keyword].map(branch => plan(value, branch, path)).filter(candidate => candidate !== undefined);
    if (!candidates.length) return undefined;
    const signature = (candidate: Plan) => JSON.stringify([...candidate].filter(([, entry]) => entry.date).map(([key]) => key).sort());
    if (candidates.some(candidate => signature(candidate) !== signature(candidates[0]!))) throw invalid();
    merge(result, candidates[0]!);
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const branchPlan = plan(value, branch, path);
      if (!branchPlan) return undefined;
      merge(result, branchPlan);
    }
  }
  return result;
}

function isoDate(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw invalid();
  const [, year, month, day, hour, minute, second, , zone] = match;
  const days = new Date(`${year}-${month}-01T00:00:00Z`);
  days.setUTCMonth(days.getUTCMonth() + 1, 0);
  if (+month! < 1 || +month! > 12 || +day! < 1 || +day! > days.getUTCDate()
    || +hour! > 23 || +minute! > 59 || +second! > 59
    || (zone !== 'Z' && (+zone!.slice(1, 3) > 23 || +zone!.slice(4) > 59))) throw invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalid();
  return date.toISOString();
}

/** Input is already checked as plain JSON by serializeInput. */
export function dateInputEnvelope(input: unknown, schema: unknown): {
  json: unknown; meta?: { values: string[] | Record<string, string[]>; v: number };
} {
  if (!hasDate(schema)) return { json: input };
  const selected = plan(input, schema, []);
  if (!selected) throw invalid();
  const dates = [...selected.values()].filter(entry => entry.date);
  if (!dates.length) return { json: input };
  let json = structuredClone(input);
  const values: Record<string, string[]> = Object.create(null);
  for (const { path } of dates) {
    // SuperJSON itself refuses these path segments during deserialization.
    if (path.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw invalid();
    if (!path.length) {
      json = isoDate(json);
    } else {
      let parent = json as Record<string, unknown>;
      for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
      const key = path[path.length - 1]!;
      parent[key] = isoDate(parent[key]);
      values[keyFor(path)] = ['Date'];
    }
  }
  return { json, meta: { values: dates.some(entry => !entry.path.length) ? ['Date'] : values, v: 1 } };
}

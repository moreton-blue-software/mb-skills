// Minimal superjson-compatible envelope codec for the helper's tRPC calls.
// The Embrace server's tRPC instance uses the superjson transformer, so request
// bodies and response payloads are `{ json, meta? }` envelopes; `meta` carries
// revival hints keyed by dot paths ("0.updatedAt": ["Date"], root specials as a
// bare array). Byte-for-byte envelope shapes were verified against the real
// superjson package (see superjson-lite.test.ts); only the types the v3 agent
// procedures use (plain JSON, undefined, Date, set, map) are supported, and
// anything richer is refused loudly rather than silently mis-encoded.
// Usage: see trpc.ts.

export type SuperjsonMeta = {
  values?: string[] | Record<string, string[]>;
  v?: number;
};

export type SuperjsonEnvelope = {
  json: unknown;
  meta?: SuperjsonMeta;
};

/** Serialize a procedure input for the request body. */
export function serializeInput(input: unknown): SuperjsonEnvelope {
  if (input === undefined) {
    // Exact bytes of superjson.serialize(undefined).
    return { json: null, meta: { values: ['undefined'], v: 1 } };
  }
  if (!isPlainJsonValue(input, [])) {
    throw new Error('procedure input must be plain JSON (dates, sets and maps are not supported)');
  }
  return { json: input };
}

function isPlainJsonValue(value: unknown, seen: unknown[]): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return true;
  if (type !== 'object') return false;
  if (seen.includes(value)) return false;
  // Only plain objects and arrays count; Date/Map/Set/RegExp and class
  // instances are refused rather than silently mis-encoded.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return false;
  const next = [...seen, value];
  if (Array.isArray(value)) return value.every(item => isPlainJsonValue(item, next));
  return Object.values(value).every(item => isPlainJsonValue(item, next));
}

/** Deserialize a `result.data` envelope back into live values. */
export function deserializeEnvelope(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return envelope;
  const { json, meta } = envelope as SuperjsonEnvelope;
  if (!meta || meta.values === undefined) return json;
  const revived = structuredClone(json);
  const entries = Object.entries(
    Array.isArray(meta.values) ? { '': meta.values } : (meta.values as Record<string, string[]>),
  ).map(([path, descriptors]) => [path.split('.').filter(part => part !== ''), descriptors] as const);
  // Deepest paths first so containers revive after their children.
  entries.sort((a, b) => b[0].length - a[0].length);
  for (const [segments, descriptors] of entries) {
    if (segments.length === 0) continue; // Root descriptors handled below.
    const container = navigate(revived, segments.slice(0, -1));
    if (container === undefined || container === null) continue;
    const key = segments[segments.length - 1]!;
    const current = (container as Record<string | number, unknown>)[key];
    (container as Record<string | number, unknown>)[key] = revive(current, descriptors);
  }
  if (Array.isArray(meta.values)) return revive(revived, meta.values);
  return revived;
}

function navigate(value: unknown, segments: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[/^\d+$/.test(segment) ? Number(segment) : segment];
  }
  return current;
}

function revive(value: unknown, descriptors: readonly string[]): unknown {
  let revived = value;
  for (const descriptor of descriptors) {
    switch (descriptor.toLowerCase()) {
      case 'date':
        revived = typeof revived === 'string' || typeof revived === 'number' ? new Date(revived) : new Date(NaN);
        break;
      case 'set':
        revived = new Set(Array.isArray(revived) ? revived : []);
        break;
      case 'map':
        revived = new Map(Array.isArray(revived) ? (revived as [unknown, unknown][]) : []);
        break;
      case 'undefined':
        revived = undefined;
        break;
      default:
        break; // Unknown types stay as their JSON representation.
    }
  }
  return revived;
}

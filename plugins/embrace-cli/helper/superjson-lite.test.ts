// Superjson envelope codec: exact bytes for the shapes the v3 agent procedures
// use, and revival of the meta formats the real superjson emits.

import { describe, expect, test } from 'bun:test';
import { deserializeEnvelope, serializeInput } from './superjson-lite';

describe('serializeInput', () => {
  test('undefined serializes to the exact superjson bytes', () => {
    expect(JSON.stringify(serializeInput(undefined)))
      .toBe('{"json":null,"meta":{"values":["undefined"],"v":1}}');
  });

  test('plain objects serialize without meta', () => {
    expect(JSON.stringify(serializeInput({ threadId: 't1' }))).toBe('{"json":{"threadId":"t1"}}');
    expect(JSON.stringify(serializeInput([{ id: 't1' }]))).toBe('{"json":[{"id":"t1"}]}');
  });

  test('refuses non-JSON values instead of mis-encoding them', () => {
    expect(() => serializeInput(new Date())).toThrow(/plain JSON/);
    expect(() => serializeInput(new Map())).toThrow(/plain JSON/);
    expect(() => serializeInput({ nested: new Set() })).toThrow(/plain JSON/);
    expect(() => serializeInput(10n)).toThrow(/plain JSON/);
  });
});

describe('deserializeEnvelope', () => {
  test('returns json as-is when meta is absent', () => {
    expect(deserializeEnvelope({ json: [{ id: 't1' }] })).toEqual([{ id: 't1' }]);
  });

  test('revives nested dates by dot path (the real superjson meta format)', () => {
    const envelope = {
      json: [{ id: 't1', updatedAt: '2026-01-02T03:04:05.000Z' }],
      meta: { values: { '0.updatedAt': ['Date'] }, v: 1 },
    };
    const revived = deserializeEnvelope(envelope) as { updatedAt: Date }[];
    expect(revived[0]!.updatedAt).toBeInstanceOf(Date);
    expect(revived[0]!.updatedAt.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  test('revives sets, maps and undefined inside containers', () => {
    const envelope = {
      json: { tags: ['a'], pairs: [['k', 'v']], missing: null, when: '1970-01-01T00:00:00.000Z' },
      meta: { values: { tags: ['set'], pairs: ['map'], missing: ['undefined'], when: ['Date'] }, v: 1 },
    };
    const revived = deserializeEnvelope(envelope) as Record<string, unknown>;
    expect(revived.tags).toBeInstanceOf(Set);
    expect(revived.pairs).toBeInstanceOf(Map);
    expect((revived.pairs as Map<string, string>).get('k')).toBe('v');
    expect('missing' in revived && revived.missing === undefined).toBe(true);
    expect(revived.when).toBeInstanceOf(Date);
  });

  test('revives a root special (bare array meta)', () => {
    expect(deserializeEnvelope({ json: null, meta: { values: ['undefined'], v: 1 } })).toBeUndefined();
  });

  test('leaves unknown descriptor types as their JSON form', () => {
    const envelope = { json: { x: 'stay' }, meta: { values: { x: ['exotic'] }, v: 1 } };
    expect((deserializeEnvelope(envelope) as Record<string, unknown>).x).toBe('stay');
  });

  test('revives children before their container (date inside a map)', () => {
    const envelope = {
      json: { m: [['when', '2026-01-02T03:04:05.000Z']] },
      meta: { values: { m: ['map'], 'm.0.1': ['Date'] }, v: 1 },
    };
    const revived = deserializeEnvelope(envelope) as { m: Map<string, unknown> };
    expect(revived.m).toBeInstanceOf(Map);
    expect(revived.m.get('when')).toBeInstanceOf(Date);
  });
});

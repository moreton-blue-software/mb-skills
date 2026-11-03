// Pure Date encoding regressions. Real-library checks optionally resolve from
// MOD_CONTRACT_MODULES=<existing node_modules>; never download dependencies.
import { afterEach, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { serializeInput } from './superjson-lite';
import { parseCliArgs, runCommand } from './cli';
import { setFetchForTests } from './fetch';
import { DESCRIBE_QUERY, DESCRIBE_MUTATION, LIST_QUERIES, LIST_MUTATIONS } from './discovery';

const DATE = { type: 'string', format: 'date-time', 'x-superjson': 'Date' };
const STRING = { type: 'string', format: 'date-time' };
const ISO = '2026-11-01T12:34:56.789Z';
const nullable = { anyOf: [DATE, { type: 'null' }] };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const schema = object({
  strict: DATE, coerced: DATE, text: STRING, optional: DATE, nullable,
  rows: { type: 'array', items: object({ at: DATE, text: STRING }) },
  tuple: { type: 'array', prefixItems: [STRING, DATE], items: DATE, minItems: 2 },
  dates: { type: 'object', additionalProperties: DATE },
}, ['strict', 'coerced', 'text']);
const input = {
  strict: ISO, coerced: ISO, text: ISO, nullable: null,
  rows: [{ at: ISO, text: ISO }, { at: ISO, text: ISO }],
  tuple: [ISO, ISO, ISO], dates: { 'a.b': ISO, 'c\\d': ISO, '': ISO },
};
const values = {
  strict: ['Date'], coerced: ['Date'], 'rows.0.at': ['Date'], 'rows.1.at': ['Date'],
  'tuple.1': ['Date'], 'tuple.2': ['Date'], 'dates.a\\.b': ['Date'], 'dates.c\\\\d': ['Date'], 'dates.': ['Date'],
};

let real: { superjson: any; z: any } | undefined;
try {
  const require = createRequire(import.meta.url);
  const paths = process.env.MOD_CONTRACT_MODULES ? [resolve(process.env.MOD_CONTRACT_MODULES, '..')] : undefined;
  const superjson = (await import(require.resolve('superjson', { paths }))).default;
  const { z } = await import(require.resolve('zod', { paths }));
  real = { superjson, z };
} catch {
  console.warn('PENDING: installed SuperJSON/Zod contract checks (set MOD_CONTRACT_MODULES to existing node_modules)');
}

const coreConverter = process.env.MOD_CORE_SOURCE
  ? (await import(resolve(process.env.MOD_CORE_SOURCE, 'worker/lib/trpc-contracts/zod-json-schema.ts'))).convertStructuralSchema
  : undefined;

function parser(z: any) {
  return z.object({
    strict: z.date(), coerced: z.coerce.date(), text: z.string().datetime(), optional: z.date().optional(),
    nullable: z.date().nullable(), rows: z.array(z.object({ at: z.date(), text: z.string().datetime() })),
    tuple: z.tuple([z.string().datetime(), z.date()]).rest(z.date()), dates: z.record(z.date()),
  });
}

function assertAccepted(envelope: any) {
  if (!real) throw new Error('Real libraries required');
  const revived = real.superjson.deserialize(envelope);
  expect(parser(real.z).safeParse(revived).success).toBe(true);
  expect(revived.strict).toBeInstanceOf(Date);
  expect(revived.coerced).toBeInstanceOf(Date);
  expect(revived.text).toBe(ISO);
  expect(revived.dates['a.b']).toBeInstanceOf(Date);
  expect(revived.dates['c\\d']).toBeInstanceOf(Date);
  expect(revived.dates['']).toBeInstanceOf(Date);
  expect(Object.hasOwn(revived, 'optional')).toBe(false);
  expect(revived.nullable).toBeNull();
  expect(real.superjson.serialize(revived)).toEqual(envelope);
}

describe('schema-marked Date input', () => {
  test('exact nested, tuple, record and escaped paths; original JSON is unchanged', () => {
    expect(serializeInput(input, schema)).toEqual({ json: input, meta: { values, v: 1 } });
    expect(input.strict).toBe(ISO);
    expect(serializeInput(ISO, DATE)).toEqual({ json: ISO, meta: { values: ['Date'], v: 1 } });
    expect(serializeInput([ISO], { type: 'array', items: DATE })).toEqual({ json: [ISO], meta: { values: { '0': ['Date'] }, v: 1 } });
    expect(serializeInput({ '': ISO }, object({ '': DATE }))).toEqual({ json: { '': ISO }, meta: { values: { '': ['Date'] }, v: 1 } });
  });
  test('format alone, unknown markers and date-looking strings never convert', () => {
    for (const unmarked of [undefined, STRING, { ...STRING, 'x-superjson': 'date' }, { ...STRING, 'x-superjson': 'Unknown' }]) {
      expect(serializeInput(ISO, unmarked)).toEqual({ json: ISO });
    }
    expect(serializeInput({ when: ISO }, object({ when: STRING }))).toEqual({ json: { when: ISO } });
    expect(serializeInput(undefined, DATE)).toEqual({ json: null, meta: { values: ['undefined'], v: 1 } });
    expect(serializeInput(null, nullable)).toEqual({ json: null });
    expect(serializeInput({}, object({ optional: DATE }))).toEqual({ json: {} });
  });
  test('valid timezone offsets normalize, leap days work', () => {
    expect(serializeInput('2024-02-29T13:00:00+01:00', DATE).json).toBe('2024-02-29T12:00:00.000Z');
    expect(serializeInput('2024-02-29T13:00:00.1-01:00', DATE).json).toBe('2024-02-29T14:00:00.100Z');
  });
  test('invalid or ambiguous ISO dates refuse without exposing values', () => {
    for (const value of ['SECRET-not-date', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z',
      '2026-13-01T00:00:00Z', '2026-01-00T00:00:00Z', '2026-01-01', '2026-01-01T00:00:00',
      '2026-01-01T24:00:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00',
      '2026-01-01T00:00:00.1234Z', 123, false, null]) {
      expect(() => serializeInput(value, DATE)).toThrow(/Date input/);
    }
    expect(() => serializeInput('SECRET-not-date', DATE)).not.toThrow(/SECRET/);
  });
  test('nullable, identical union plans, discriminators, wrappers and intersections', () => {
    for (const wrapped of [nullable, { anyOf: [DATE, DATE] }, { allOf: [DATE, DATE] }]) {
      expect(serializeInput(ISO, wrapped).meta?.values).toEqual(['Date']);
    }
    const tagged = { oneOf: [object({ kind: { const: 'date' }, value: DATE }, ['kind', 'value']),
      object({ kind: { const: 'text' }, value: STRING }, ['kind', 'value'])] };
    expect(serializeInput({ kind: 'date', value: ISO }, tagged).meta?.values).toEqual({ value: ['Date'] });
    expect(serializeInput({ kind: 'text', value: ISO }, tagged).meta).toBeUndefined();
    expect(serializeInput({ when: ISO, label: 'a' }, { allOf: [object({ when: DATE }), object({ label: { type: 'string' } })] })
      .meta?.values).toEqual({ when: ['Date'] });
  });
  test('unions with different Date plans and conflicting intersections never guess', () => {
    for (const branch of [{ anyOf: [DATE, STRING] }, { oneOf: [STRING, DATE] }, { anyOf: [DATE, {}] },
      { allOf: [DATE, STRING] }]) expect(() => serializeInput(ISO, branch)).toThrow(/ambiguous/);
    expect(() => serializeInput({ when: ISO }, { anyOf: [object({ when: DATE }), object({ when: STRING })] })).toThrow(/ambiguous/);
    expect(() => serializeInput({ when: ISO }, { allOf: [object({ when: DATE }), object({ when: STRING })] })).toThrow(/ambiguous/);
    expect(() => serializeInput({ when: ISO }, { anyOf: [object({ when: DATE }), object({ other: DATE })] })).toThrow(/ambiguous/);
  });
  test('nested invalid Dates refuse and absent optional or nullable Dates preserve JSON', () => {
    expect(() => serializeInput({ ...input, rows: [{ at: 'bad', text: ISO }] }, schema)).toThrow(/Date input/);
    expect(serializeInput({ optional: ISO, nullable: ISO }, object({ optional: DATE, nullable })).meta?.values)
      .toEqual({ optional: ['Date'], nullable: ['Date'] });
    expect(serializeInput({ nullable: null }, object({ optional: DATE, nullable }))).toEqual({ json: { nullable: null } });
  });
  test('SuperJSON-forbidden path segments refuse instead of producing unusable requests', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(() => serializeInput(JSON.parse(`{"${key}":"${ISO}"}`), { type: 'object', additionalProperties: DATE })).toThrow(/Date input/);
    }
  });
  test.skipIf(!real || !coreConverter)('Core runtime converter schemas round-trip representative and wrapped Zod contracts', () => {
    const { z, superjson } = real!;
    const contract = parser(z);
    const generated = coreConverter(contract, 'input').schema;
    expect(generated.properties.strict['x-superjson']).toBe('Date');
    expect(generated.properties.coerced['x-superjson']).toBe('Date');
    expect(generated.properties.text['x-superjson']).toBeUndefined();
    assertAccepted(serializeInput(input, generated));
    const wrapped = z.object({ data: z.object({ when: z.date().readonly(),
      repeatSetting: z.object({ endDate: z.coerce.date().optional() }).nullish(),
      optional: z.date().default(() => { throw new Error('must not execute default factory'); }),
      refined: z.date().refine((date: Date) => date.getTime() > 0),
      branded: z.date().brand(), caught: z.date().catch(() => { throw new Error('must not execute catch factory'); }),
    }) });
    const value = { data: { when: ISO, repeatSetting: { endDate: ISO }, optional: ISO, refined: ISO, branded: ISO, caught: ISO } };
    const encoded = serializeInput(value, coreConverter(wrapped, 'input').schema);
    expect(encoded.meta?.values).toEqual({ 'data.when': ['Date'], 'data.repeatSetting.endDate': ['Date'],
      'data.optional': ['Date'], 'data.refined': ['Date'], 'data.branded': ['Date'], 'data.caught': ['Date'] });
    expect(wrapped.safeParse(superjson.deserialize(encoded)).success).toBe(true);
    const tagged = z.discriminatedUnion('kind', [z.object({ kind: z.literal('date'), at: z.date() }),
      z.object({ kind: z.literal('text'), at: z.string().datetime() })]);
    for (const kind of ['date', 'text']) {
      const envelope = serializeInput({ kind, at: ISO }, coreConverter(tagged, 'input').schema);
      expect(tagged.safeParse(superjson.deserialize(envelope)).success).toBe(true);
      expect(envelope.meta?.values).toEqual(kind === 'date' ? { at: ['Date'] } : undefined);
    }
    expect(() => serializeInput(ISO, coreConverter(z.union([z.date(), z.string().datetime()]), 'input').schema)).toThrow(/ambiguous/);
  });
  test.skipIf(!real)('actual SuperJSON deserializes into strict/coerced Date and datetime-string Zod parsers', () => {
    assertAccepted(serializeInput(input, schema));
    expect(real!.z.date().safeParse(real!.superjson.deserialize(serializeInput(ISO, DATE))).success).toBe(true);
    expect(real!.z.object({ '': real!.z.date() }).safeParse(real!.superjson.deserialize(serializeInput({ '': ISO }, object({ '': DATE })))).success).toBe(true);
    expect(parser(real!.z).safeParse(input).success).toBe(false); // strict z.date rejects the original JSON
    expect(real!.z.coerce.date().safeParse(ISO).success).toBe(true);
    expect(real!.z.string().datetime().safeParse(real!.superjson.deserialize(serializeInput(ISO, STRING))).success).toBe(true);
  });
});

const ORIGIN = 'http://localhost:5999';
const NOW = Date.parse(ISO);
const TOKEN = { origin: ORIGIN, access_token: 'fixture-access', refresh_token: 'fixture-refresh',
  email: 'fixture@example.test', expires_at: NOW + 3_600_000 };
const tokenStore = { get: async () => TOKEN, put: async () => {}, remove: async () => true, list: async () => [TOKEN] };
const reply = (data: unknown) => Response.json({ result: { data: { json: data } } });
const metadata = (name: string, type: string, inputSchema: unknown = schema) => ({ name, type,
  deployment: { commitSha: 'a'.repeat(40), deployedAt: ISO },
  input: { status: 'supported', presence: 'required', fidelity: 'structural', schema: inputSchema },
  output: { status: 'supported', fidelity: 'structural', schema: { type: 'object' } },
});
const run = (command: string, name: string, data: unknown = input) => {
  const out: string[] = [], err: string[] = [];
  return runCommand(parseCliArgs([command, '--origin', ORIGIN, name, JSON.stringify(data)]),
    { tokenStore, now: () => NOW, stdout: text => out.push(text), stderr: text => err.push(text) })
    .then(code => ({ code, out, err }));
};
afterEach(() => setFetchForTests());

describe('CLI Date input transport', () => {
  for (const command of ['call', 'mutate']) {
    const type = command === 'call' ? 'query' : 'mutation';
    const name = `v3.fixture.${command}Dates`;
    const describeName = command === 'call' ? DESCRIBE_QUERY : DESCRIBE_MUTATION;
    test.skipIf(!real)(`${command}: fresh GET description then one actual parser-accepted request`, async () => {
      const requests: string[] = [];
      setFetchForTests(async (url, init) => {
        const parsed = new URL(String(url));
        requests.push(parsed.pathname);
        if (parsed.pathname === `/trpc/${describeName}`) {
          expect(init?.method).toBe('GET');
          expect(JSON.parse(parsed.searchParams.get('input')!)).toEqual({ json: { name } });
          const inputSchema = coreConverter ? coreConverter(parser(real!.z), 'input').schema : schema;
          return reply(metadata(name, type, inputSchema));
        }
        expect(parsed.pathname).toBe(`/trpc/${name}`);
        expect(init?.method).toBe(command === 'call' ? 'GET' : 'POST');
        const envelope = JSON.parse(command === 'call' ? parsed.searchParams.get('input')! : String(init?.body));
        expect(envelope.meta.values).toEqual(values);
        assertAccepted(envelope);
        return reply({ accepted: true });
      });
      expect((await run(command, name)).code).toBe(0);
      expect((await run(command, name)).code).toBe(0);
      expect(requests).toEqual([`/trpc/${describeName}`, `/trpc/${name}`, `/trpc/${describeName}`, `/trpc/${name}`]);
    });
    test(`${command}: invalid dates and ambiguous branches stop before the business request`, async () => {
      for (const [value, inputSchema] of [['SECRET-bad-date', DATE], [ISO, { anyOf: [DATE, STRING] }], [null, DATE]]) {
        const requests: string[] = [];
        setFetchForTests(async (url, init) => {
          requests.push(String(url));
          expect(init?.method).toBe('GET');
          return reply(metadata(name, type, inputSchema));
        });
        const result = await run(command, name, value);
        expect(result.code).toBe(1);
        expect(result.err.join()).not.toContain('SECRET');
        if (command === 'mutate') expect(result.err.join()).toContain('not-dispatched');
        expect(requests).toHaveLength(1);
      }
    });
    test(`${command}: older unmarked metadata preserves strings`, async () => {
      let count = 0;
      setFetchForTests(async (url, init) => {
        count++;
        if (String(url).includes(describeName)) return reply(metadata(name, type, STRING));
        const envelope = JSON.parse(command === 'call' ? new URL(String(url)).searchParams.get('input')! : String(init?.body));
        expect(envelope).toEqual({ json: ISO });
        return reply('ok');
      });
      expect((await run(command, name, ISO)).code).toBe(0);
      expect(count).toBe(2);
    });
  }
  test('delete metadata containing Dates dispatches the same Date-marked POST', async () => {
    const requests: string[] = [];
    const name = 'v3.fixture.deleteDates';
    setFetchForTests(async (url, init) => {
      const parsed = new URL(String(url));
      requests.push(parsed.pathname);
      if (parsed.pathname === `/trpc/${DESCRIBE_MUTATION}`) {
        expect(init?.method).toBe('GET');
        return reply(metadata(name, 'mutation'));
      }
      expect(init?.method).toBe('POST');
      expect(parsed.pathname).toBe(`/trpc/${name}`);
      const envelope = JSON.parse(String(init?.body));
      expect(envelope.meta.values).toEqual(values);
      return reply({ archived: true });
    });
    const result = await run('mutate', name);
    expect(result.code).toBe(0);
    expect(requests).toEqual([`/trpc/${DESCRIBE_MUTATION}`, `/trpc/${name}`]);
  });
  test('metadata calls do not recursively describe', async () => {
    let count = 0;
    setFetchForTests(async (_, init) => { count++; expect(init?.method).toBe('GET'); return reply({}); });
    for (const name of [DESCRIBE_QUERY, DESCRIBE_MUTATION, LIST_QUERIES, LIST_MUTATIONS]) expect((await run('call', name, {})).code).toBe(0);
    expect(count).toBe(4);
  });
  test('unknown or mismatched successful query metadata never supplies a Date schema', async () => {
    for (const description of [null, {}, { ...metadata('v3.fixture.other', 'query'), input: { status: 'supported', fidelity: 'structural', schema: DATE } },
      { ...metadata('v3.fixture.readDates', 'query', DATE), input: { status: 'unsupported' } }]) {
      let count = 0;
      setFetchForTests(async (url, init) => {
        count++;
        expect(init?.method).toBe('GET');
        if (String(url).includes(DESCRIBE_QUERY)) return reply(description);
        expect(JSON.parse(new URL(String(url)).searchParams.get('input')!)).toEqual({ json: ISO });
        return reply('ok');
      });
      expect((await run('call', 'v3.fixture.readDates', ISO)).code).toBe(0);
      expect(count).toBe(2);
    }
  });
  test('missing query discovery retains plain JSON; permission failure does not fall back', async () => {
    for (const code of ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED']) {
      let count = 0;
      setFetchForTests(async (url, init) => {
        count++;
        expect(init?.method).toBe('GET');
        if (String(url).includes(DESCRIBE_QUERY)) return Response.json({ error: { json: { data: { code } } } }, { status: code === 'NOT_FOUND' ? 404 : 403 });
        expect(JSON.parse(new URL(String(url)).searchParams.get('input')!)).toEqual({ json: ISO });
        return reply('ok');
      });
      expect((await run('call', 'v3.fixture.readDates', ISO)).code).toBe(code === 'NOT_FOUND' ? 0 : 1);
      expect(count).toBe(code === 'NOT_FOUND' ? 2 : 1);
    }
  });
});

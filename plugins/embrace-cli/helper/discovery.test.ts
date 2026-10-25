import { afterEach, describe, expect, test } from 'bun:test';
import { discoveryRequest, DESCRIBE_QUERY, LIST_QUERIES } from './discovery';
import { parseCliArgs, runCommand } from './cli';
import { setFetchForTests } from './fetch';

const ORIGIN = 'https://example.test';
afterEach(() => setFetchForTests());

const token = { origin: ORIGIN, access_token: 'TEST-ACCESS', refresh_token: 'TEST-REFRESH', expires_at: Date.now() + 3_600_000, email: 'user@example.test' };
const tokenStore = {
  get: async () => token,
  put: async () => {},
  remove: async () => {},
  list: async () => [token],
};

describe('discovery commands', () => {
  test('builds a bounded search request and describe request', () => {
    expect(discoveryRequest({ command: 'discover' })).toEqual({ procedure: LIST_QUERIES, inputJson: '{"search":"","limit":50,"after":null}' });
    expect(parseCliArgs(['discover', '--origin', ORIGIN, '--search', 'project', '--limit', '5', '--after', 'v3.project.getOne']))
      .toMatchObject({ command: 'discover', procedure: LIST_QUERIES, inputJson: '{"search":"project","limit":5,"after":"v3.project.getOne"}' });
    expect(parseCliArgs(['describe', '--origin', ORIGIN, 'v3.futureModule.searchRecords']))
      .toMatchObject({ command: 'describe', procedure: DESCRIBE_QUERY, inputJson: '{"name":"v3.futureModule.searchRecords"}' });
  });

  test('rejects missing origins, extra positionals, malformed names and unbounded input', () => {
    for (const argv of [
      ['discover'], ['describe', '--origin', ORIGIN],
      ['discover', '--origin', ORIGIN, 'extra'],
      ['describe', '--origin', ORIGIN, '../bad'],
      ['discover', '--origin', ORIGIN, '--limit', '101'],
      ['discover', '--origin', ORIGIN, '--limit', '0'],
      ['discover', '--origin', ORIGIN, '--limit', '1.5'],
      ['discover', '--origin', ORIGIN, '--search', 'x'.repeat(201)],
    ]) expect(() => parseCliArgs(argv)).toThrow();
  });

  test('discovers, describes, and executes a newly registered query using only GET', async () => {
    const name = 'v3.futureModule.findNewRecords';
    const deployment = { commitSha: 'fixture-deployment', deployedAt: '2026-10-25T00:00:00Z' };
    const requests: { url: URL; method?: string; body?: unknown }[] = [];
    setFetchForTests(async (url, init) => {
      const parsed = new URL(String(url));
      requests.push({ url: parsed, method: init?.method, body: init?.body });
      const input = JSON.parse(parsed.searchParams.get('input')!).json;
      const data = parsed.pathname.endsWith(LIST_QUERIES)
        ? { deployment, queries: [{ name, type: 'query' }], nextAfter: null }
        : parsed.pathname.endsWith(DESCRIBE_QUERY)
          ? { deployment, name, type: 'query', input: { status: 'supported', presence: 'required', schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }, fidelity: 'structural' }, output: { status: 'none' } }
          : { items: [], count: input.count };
      return Response.json({ result: { data: { json: data } } });
    });
    const out: string[] = [];
    const context = { tokenStore, stdout: (text: string) => out.push(text), stderr: () => {} };
    expect(await runCommand(parseCliArgs(['discover', '--origin', ORIGIN, '--search', 'future']), context)).toBe(0);
    const listed = JSON.parse(out[0]!);
    expect(listed.queries[0].name).toBe(name);
    expect(await runCommand(parseCliArgs(['describe', '--origin', ORIGIN, listed.queries[0].name]), context)).toBe(0);
    const described = JSON.parse(out[1]!);
    expect(described.deployment).toEqual(listed.deployment);
    expect(described.input.schema.required).toEqual(['count']);
    expect(await runCommand(parseCliArgs(['call', '--origin', ORIGIN, name, '{"count":3}']), context)).toBe(0);
    expect(JSON.parse(out[2]!)).toEqual({ items: [], count: 3 });
    expect(requests).toHaveLength(3);
    expect(requests.every(request => request.method === 'GET' && request.body === undefined)).toBe(true);
    expect(out.join('\n')).not.toContain('TEST-ACCESS');
  });

  test('reports unavailable discovery without guessing a fallback or making a second request', async () => {
    let count = 0;
    setFetchForTests(async () => {
      count++;
      return Response.json({ error: { json: { data: { code: 'NOT_FOUND' } } } }, { status: 404 });
    });
    const err: string[] = [];
    const code = await runCommand(parseCliArgs(['discover', '--origin', ORIGIN]), { tokenStore, stdout: () => {}, stderr: text => err.push(text) });
    expect(code).toBe(1);
    expect(count).toBe(1);
    expect(JSON.parse(err[0]!).hint).toContain('Do not guess');
  });

  test('discovery refreshes the stored session through the same auth path as calls', async () => {
    const requests: string[] = [];
    let saved: unknown;
    const expiredStore = {
      ...tokenStore,
      get: async () => ({ ...token, expires_at: Date.now() - 60_000 }),
      put: async (value: typeof token) => { saved = value; },
    };
    setFetchForTests(async (url, init) => {
      requests.push(String(url));
      if (String(url).endsWith('/oauth2/token')) {
        expect(String(init?.body)).toContain('grant_type=refresh_token');
        return Response.json({ access_token: 'TEST-NEW-ACCESS', refresh_token: 'TEST-NEW-REFRESH', expires_in: 3600 });
      }
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer TEST-NEW-ACCESS');
      expect(init?.method).toBe('GET');
      return Response.json({ result: { data: { json: { deployment: { commitSha: 'fixture', deployedAt: 'unknown' }, queries: [], nextAfter: null } } } });
    });
    const out: string[] = [];
    expect(await runCommand(parseCliArgs(['discover', '--origin', ORIGIN]), { tokenStore: expiredStore, stdout: text => out.push(text), stderr: () => {} })).toBe(0);
    expect(requests).toHaveLength(2);
    expect(saved).toMatchObject({ access_token: 'TEST-NEW-ACCESS', refresh_token: 'TEST-NEW-REFRESH' });
    expect(out.join('')).not.toContain('TEST-NEW-ACCESS');
  });

  test('requires sign-in before discovery without making an API request', async () => {
    let requests = 0;
    setFetchForTests(async () => { requests++; return Response.json({}); });
    const err: string[] = [];
    const signedOut = { ...tokenStore, get: async () => null, list: async () => [] };
    const code = await runCommand(parseCliArgs(['discover', '--origin', ORIGIN]), { tokenStore: signedOut, stdout: () => {}, stderr: text => err.push(text) });
    expect(code).toBe(2);
    expect(requests).toBe(0);
    expect(JSON.parse(err[0]!).hint).toContain('login');
  });

  test('preserves unsupported contract status rather than inventing an empty schema', async () => {
    setFetchForTests(async () => Response.json({ result: { data: { json: {
      deployment: { commitSha: 'fixture', deployedAt: 'unknown' }, name: 'v3.project.specialQuery', type: 'query',
      input: { status: 'unsupported', reason: 'unsupported-schema' }, output: { status: 'none' },
    } } } }));
    const out: string[] = [];
    expect(await runCommand(parseCliArgs(['describe', '--origin', ORIGIN, 'v3.project.specialQuery']), { tokenStore, stdout: text => out.push(text), stderr: () => {} })).toBe(0);
    expect(JSON.parse(out[0]!).input).toEqual({ status: 'unsupported', reason: 'unsupported-schema' });
  });
});

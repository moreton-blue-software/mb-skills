// Fake-origin mutation preflight/transport tests; no live account or server.
import { afterEach, describe, expect, test } from 'bun:test';
import { parseCliArgs, runCommand } from './cli';
import { DESCRIBE_MUTATION, EXECUTE_MUTATION, LIST_MUTATIONS } from './discovery';
import { setFetchForTests } from './fetch';
import { executeReviewedMutation } from './mutations';

const ORIGIN = 'http://localhost:5999';
const NAME = 'v3.crm.company.createCompany';
const DEPLOYMENT = { commitSha: 'a'.repeat(40), deployedAt: '2026-10-26T00:00:00.000Z' };
const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const TOKEN = { origin: ORIGIN, access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH',
  email: 'fixture@example.test', expires_at: NOW + 3_600_000 };
const tokenStore = { get: async () => TOKEN, put: async () => {}, remove: async () => true, list: async () => [TOKEN] };
const metadata = () => ({ deployment: DEPLOYMENT, name: NAME, type: 'mutation',
  input: { status: 'supported', presence: 'required', fidelity: 'structural', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  output: { status: 'supported', fidelity: 'structural', schema: { type: 'object' } } });
const envelope = (data: unknown) => Response.json({ result: { data: { json: data } } });
const company = { id: 'new-company', name: 'Fixture', description: 'Actual procedure result' };
interface Captured { url: string; method?: string; body?: string; redirect?: RequestRedirect }
function stub(options: { describe?: unknown; executeResponse?: () => Response | Promise<Response> } = {}) {
  const requests: Captured[] = [];
  setFetchForTests(async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method, body: init?.body === undefined ? undefined : String(init.body), redirect: init?.redirect });
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN.access_token}`);
    if (url.includes(DESCRIBE_MUTATION)) return envelope(options.describe ?? metadata());
    if (url.endsWith(EXECUTE_MUTATION)) return options.executeResponse ? options.executeResponse() : envelope(company);
    throw new Error('Unexpected path');
  });
  return requests;
}
const execute = (input: unknown = { name: 'Fixture' }) => executeReviewedMutation({ origin: ORIGIN,
  procedure: NAME, input, accessToken: TOKEN.access_token });
afterEach(() => setFetchForTests());

describe('mutation CLI selection', () => {
  test('keeps discovery query default and accepts ordinary mutation arguments', () => {
    expect(parseCliArgs(['discover', '--origin', ORIGIN]).operationType).toBe('query');
    expect(parseCliArgs(['discover', '--origin', ORIGIN, '--type', 'mutation']).procedure).toBe(LIST_MUTATIONS);
    expect(parseCliArgs(['describe', '--origin', ORIGIN, '--type', 'mutation', NAME]).procedure).toBe(DESCRIBE_MUTATION);
    expect(parseCliArgs(['mutate', '--origin', ORIGIN, NAME, '{"name":"Fixture"}']))
      .toEqual({ command: 'mutate', origin: ORIGIN, procedure: NAME, inputJson: '{"name":"Fixture"}' });
  });
  test('rejects removed request-id option, unknown types, malformed JSON and extra arguments', () => {
    for (const argv of [
      ['mutate', '--origin', ORIGIN, '--request-id', 'removed', NAME, '{}'],
      ['mutate', '--origin', ORIGIN, NAME, '{}', 'extra'],
      ['mutate', '--origin', ORIGIN, NAME, '{bad'],
      ['describe', '--origin', ORIGIN, '--type', 'delete', NAME],
    ]) expect(() => parseCliArgs(argv)).toThrow();
  });
});

describe('fixed mutation gateway', () => {
  test('fresh description is GET; one POST carries only name/input and returns actual data', async () => {
    const requests = stub();
    expect(await execute()).toEqual({ ok: true, data: company });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.method).toBe('GET');
    expect(JSON.parse(new URL(requests[0]!.url).searchParams.get('input')!).json).toEqual({ name: NAME });
    expect(requests[1]!.url).toBe(`${ORIGIN}/trpc/${EXECUTE_MUTATION}`);
    expect(requests[1]!.method).toBe('POST');
    expect(requests[1]!.redirect).toBe('error');
    expect(JSON.parse(requests[1]!.body!).json).toEqual({ name: NAME, input: { name: 'Fixture' } });
    expect(requests.some(r => new URL(r.url).pathname === `/trpc/${NAME}`)).toBe(false);
  });
  test('separate explicit calls each dispatch once; no client replay cache is promised', async () => {
    const requests = stub();
    expect((await execute()).ok).toBe(true);
    expect((await execute()).ok).toBe(true);
    expect(requests.filter(r => r.method === 'POST')).toHaveLength(2);
  });
  test('unsupported, mismatched, unknown or malformed metadata cannot dispatch', async () => {
    for (const description of [
      { ...metadata(), type: 'query' }, { ...metadata(), name: 'v3.crm.company.deleteCompany' },
      { ...metadata(), deployment: { ...DEPLOYMENT, commitSha: 'unknown' } },
      { ...metadata(), deployment: { ...DEPLOYMENT, deployedAt: 'unknown' } },
      { ...metadata(), input: { status: 'unsupported', reason: 'unsupported-parser' } },
      { ...metadata(), output: { status: 'unsupported', reason: 'unsupported-schema' } },
      { ...metadata(), input: { status: 'supported', presence: 'required', fidelity: 'structural', schema: {} } },
      { ...metadata(), input: { status: 'none' } },
    ]) {
      const requests = stub({ describe: description });
      const result = await execute();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.outcome).toBe('not-dispatched');
      expect(requests).toHaveLength(1);
    }
  });
  test('required input cannot be absent; none input stays omitted', async () => {
    const required = stub();
    const missing = await executeReviewedMutation({ origin: ORIGIN, procedure: NAME, accessToken: TOKEN.access_token });
    expect(missing.ok).toBe(false);
    expect(required).toHaveLength(1);
    const requests = stub({ describe: { ...metadata(), input: { status: 'none' }, output: { status: 'none' } },
      executeResponse: () => Response.json({ result: { data: { json: null, meta: { values: ['undefined'], v: 1 } } } }) });
    expect(await executeReviewedMutation({ origin: ORIGIN, procedure: NAME, accessToken: TOKEN.access_token }))
      .toEqual({ ok: true, data: undefined });
    const body = JSON.parse(requests[1]!.body!);
    expect(Object.hasOwn(body.json, 'input')).toBe(false);
    expect(body.meta).toBeUndefined();
  });
  test('decodes actual procedure values without requiring an object receipt or id', async () => {
    for (const value of [null, false, 0, ['one', 'two'], { status: 'unresolved' }]) {
      stub({ executeResponse: () => envelope(value) });
      expect(await execute()).toEqual({ ok: true, data: value });
    }
    stub({ executeResponse: () => Response.json({ result: { data: {
      json: { updatedAt: '2026-01-01T00:00:00.000Z' }, meta: { values: { updatedAt: ['Date'] }, v: 1 },
    } } }) });
    const result = await execute();
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.data as { updatedAt: Date }).updatedAt).toBeInstanceOf(Date);
  });
  test('hidden/deleted or denied mutation descriptions never cause fallback POST', async () => {
    let count = 0;
    setFetchForTests(async () => { count++; return Response.json({ error: { json: { data: { code: 'NOT_FOUND' } } } }, { status: 404 }); });
    const result = await execute();
    expect(result.ok).toBe(false);
    expect(count).toBe(1);
    if (!result.ok) expect(result.error.error).toContain('NOT_FOUND');
  });
  test('server errors expose only a bounded code, never raw message or automatic retry', async () => {
    for (const code of ['FORBIDDEN', 'BAD_REQUEST', 'CONFLICT']) {
      const requests = stub({ executeResponse: () => Response.json({ error: { json: { message: 'SECRET-provider-diagnostic', data: { code } } } }, { status: 409 }) });
      const result = await execute();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.error).toContain(code);
      expect(JSON.stringify(result)).not.toContain('SECRET-provider-diagnostic');
      expect(requests.filter(r => r.method === 'POST')).toHaveLength(1);
    }
  });
  test('lost responses or malformed envelopes report uncertainty without retry or diagnostics', async () => {
    for (const respond of [
      () => { throw new Error('SECRET-token-in-error'); },
      () => new Response('SECRET-invalid-json', { status: 502 }),
      () => Response.json({ arbitrary: 'SECRET-body' }),
      () => Response.json({ result: { data: { arbitrary: 'SECRET-body' } } }),
    ]) {
      const requests = stub({ executeResponse: respond });
      const result = await execute();
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('SECRET');
      if (!result.ok) {
        expect(result.error.outcome).toBe('unknown');
        expect(result.error.hint).toContain('duplicate submissions can execute twice');
      }
      expect(requests.filter(r => r.method === 'POST')).toHaveLength(1);
    }
  });
  test('preflight failure never dispatches or leaks raw exception', async () => {
    let count = 0;
    setFetchForTests(async () => { count++; throw new Error('SECRET-preflight'); });
    const result = await execute();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    if (!result.ok) expect(result.error.outcome).toBe('not-dispatched');
    expect(count).toBe(1);
  });
  test('status uses the injected clock and correctly reports expiry', async () => {
    const out: string[] = [];
    const context = { tokenStore, now: () => NOW, stdout: (text: string) => out.push(text) };
    expect(await runCommand(parseCliArgs(['status', '--origin', ORIGIN, '--json']), context)).toBe(0);
    expect(JSON.parse(out[0]!).sessions[0].accessTokenValid).toBe(true);
    out.length = 0;
    expect(await runCommand(parseCliArgs(['status', '--origin', ORIGIN, '--json']), { ...context, now: () => TOKEN.expires_at })).toBe(0);
    expect(JSON.parse(out[0]!).sessions[0].accessTokenValid).toBe(false);
  });
  test('CLI refreshes first and emits sanitized actual procedure output', async () => {
    let saved: unknown;
    const expiredStore = { ...tokenStore, get: async () => ({ ...TOKEN, expires_at: 0 }), put: async (token: typeof TOKEN) => { saved = token; } };
    const requests: string[] = [];
    setFetchForTests(async (url, init) => {
      requests.push(String(url));
      if (String(url).endsWith('/oauth2/token')) return Response.json({ access_token: 'SECRET-NEW', refresh_token: 'SECRET-ROTATED', expires_in: 3600 });
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer SECRET-NEW');
      return envelope(String(url).includes(DESCRIBE_MUTATION) ? metadata() : { password: 'SECRET-password', id: 'new-company' });
    });
    const out: string[] = [], err: string[] = [];
    const code = await runCommand(parseCliArgs(['mutate', '--origin', ORIGIN, NAME, '{"name":"Fixture"}']),
      { tokenStore: expiredStore, now: () => NOW, stdout: text => out.push(text), stderr: text => err.push(text) });
    expect(code).toBe(0);
    expect(saved).toMatchObject({ access_token: 'SECRET-NEW', refresh_token: 'SECRET-ROTATED' });
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect(JSON.parse(out[0]!).password).toBe('[redacted]');
    expect(err).toHaveLength(0);
  });
});

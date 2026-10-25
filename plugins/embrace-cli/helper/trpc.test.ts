// Fake-origin tRPC calls with the HTTP layer stubbed: transport shape (URL,
// method, bearer header, superjson body bytes) and envelope/error handling.
// No live server is contacted.

import { afterEach, describe, expect, test } from 'bun:test';
import { setFetchForTests } from './fetch';
import { assertProcedureName, callProcedure } from './trpc';

afterEach(() => setFetchForTests());

interface Captured {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: string;
}

function stubCapture(responder: (captured: Captured) => Response): Captured[] {
  const captured: Captured[] = [];
  setFetchForTests(async (input, init) => {
    const record: Captured = {
      url: String(input),
      method: init?.method,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body: String(init?.body ?? ''),
    };
    captured.push(record);
    return responder(record);
  });
  return captured;
}

const ORIGIN = 'http://localhost:5999';

describe('assertProcedureName', () => {
  test('accepts v3 dotted names, refuses everything else', () => {
    expect(() => assertProcedureName('v3.agent.listThreads')).not.toThrow();
    expect(() => assertProcedureName('v3.common.topBar.getCurrentUser')).not.toThrow();
    expect(() => assertProcedureName('listThreads')).toThrow(/procedure/);
    expect(() => assertProcedureName('v3.agent')).toThrow(/procedure/);
    expect(() => assertProcedureName('../etc/passwd')).toThrow(/procedure/);
  });
});

describe('callProcedure', () => {
  test('accepts future query names and passes their input without a module allowlist', async () => {
    const captured = stubCapture(() => Response.json({ result: { data: { json: { items: [] } } } }));
    const result = await callProcedure({
      origin: ORIGIN,
      procedure: 'v3.futureModule.searchNewRecords',
      input: { filter: { label: 'new contract' }, pageSize: 5 },
      accessToken: 'ACCESS-1',
    });
    const request = captured[0]!;
    const url = new URL(request.url);
    expect(url.pathname).toBe('/trpc/v3.futureModule.searchNewRecords');
    expect(JSON.parse(url.searchParams.get('input')!)).toEqual({ json: { filter: { label: 'new contract' }, pageSize: 5 } });
    expect(request.method).toBe('GET');
    expect(request.body).toBe('');
    expect(result.data).toEqual({ items: [] });
  });
  test('never retries a mutation with POST when GET is rejected', async () => {
    const captured = stubCapture(() => Response.json({ error: { json: { data: { code: 'METHOD_NOT_SUPPORTED' } } } }, { status: 405 }));
    const result = await callProcedure({ origin: ORIGIN, procedure: 'v3.agent.approveThread', input: { threadId: 't1' }, accessToken: 'A' });
    expect(result.ok).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('GET');
    expect(captured[0]!.body).toBe('');
  });

  test('GETs query procedures with the envelope in ?input= and a bearer header', async () => {
    const captured = stubCapture(() => Response.json({ result: { data: { json: [{ id: 't1' }] } } }));
    const result = await callProcedure({
      origin: ORIGIN,
      procedure: 'v3.agent.listThreads',
      input: undefined,
      accessToken: 'ACCESS-1',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([{ id: 't1' }]);
    const call = captured[0]!;
    const [path, query] = call.url.split('?');
    expect(path).toBe(`${ORIGIN}/trpc/v3.agent.listThreads`);
    expect(call.method).toBe('GET');
    expect(call.headers.authorization).toBe('Bearer ACCESS-1');
    expect(call.headers['content-type']).toBeUndefined();
    expect(decodeURIComponent(query ?? '')).toContain('{"json":null,"meta":{"values":["undefined"],"v":1}}');
  });

  test('wraps object input in the superjson envelope', async () => {
    const captured = stubCapture(() => Response.json({ result: { data: { json: { id: 't1', title: 'Example' } } } }));
    const result = await callProcedure({
      origin: ORIGIN,
      procedure: 'v3.agent.getThread',
      input: { threadId: 't1' },
      accessToken: 'ACCESS-1',
    });
    expect(new URL(captured[0]!.url).searchParams.get('input')).toBe('{"json":{"threadId":"t1"}}');
    expect(result.data).toEqual({ id: 't1', title: 'Example' });
  });

  test('deserializes meta revivals in the response', async () => {
    stubCapture(() => Response.json({
      result: { data: { json: [{ id: 't1', updatedAt: '2026-01-02T03:04:05.000Z' }], meta: { values: { '0.updatedAt': ['Date'] }, v: 1 } } },
    }));
    const result = await callProcedure({ origin: ORIGIN, procedure: 'v3.agent.listThreads', accessToken: 'A' });
    const threads = result.data as { updatedAt: Date }[];
    expect(threads[0]!.updatedAt).toBeInstanceOf(Date);
  });

  test('surfaces the tRPC error code without the message body', async () => {
    stubCapture(() => new Response(JSON.stringify({ error: { json: { message: 'internal detail', data: { code: 'FORBIDDEN' } } } }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }));
    const result = await callProcedure({ origin: ORIGIN, procedure: 'v3.agent.getThread', input: { threadId: 't1' }, accessToken: 'A' });
    expect(result).toMatchObject({ ok: false, httpStatus: 403, errorCode: 'FORBIDDEN' });
  });

  test('reports non-JSON responses as HTTP_<status>', async () => {
    stubCapture(() => new Response('gateway broke', { status: 502 }));
    const result = await callProcedure({ origin: ORIGIN, procedure: 'v3.agent.listThreads', accessToken: 'A' });
    expect(result).toMatchObject({ ok: false, httpStatus: 502, errorCode: 'HTTP_502' });
  });
});

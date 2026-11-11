// Fake-origin public capability detection and v2 CLI/transport contracts.
import { afterEach, describe, expect, test } from 'bun:test';
import { CONNECTION_ERROR, CONNECTION_PATH, FRONTEND_POINTER_PATH, resolveConnection, detectBackend, INITIAL_V2_PROCEDURE, V3_BACKEND, type Backend } from './connection';
import { parseCliArgs, runCommand } from './cli';
import { setFetchForTests } from './fetch';
import { assertProcedureName, callQuery } from './trpc';
import { DESCRIBE_QUERY, DESCRIBE_MUTATION, LIST_QUERIES, LIST_MUTATIONS } from './discovery';

const ORIGIN = 'https://example.test';
const fixture = () => ({
  product: 'embrace-v2', instance: { id: 'fixture-instance' }, issuer: `${ORIGIN}/api/auth`,
  api: { transport: 'trpc', baseUrl: ORIGIN, procedureDiscovery: false, initialAllowedProcedure: INITIAL_V2_PROCEDURE },
  approvalMode: 'app-origin',
});
const backend: Extract<Backend, { product: 'embrace-v2' }> = { product: 'embrace-v2', baseUrl: ORIGIN, procedureDiscovery: false as const, initialAllowedProcedure: INITIAL_V2_PROCEDURE };
const token = { origin: ORIGIN, access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_at: Date.now() + 3_600_000, email: null };
const tokenStore = { get: async () => token, put: async () => {}, remove: async () => true, list: async () => [token] };
afterEach(() => setFetchForTests());

describe('connection detection', () => {
  test('validates the server contract without credentials, redirects or persistence', async () => {
    let count = 0;
    setFetchForTests(async (url, init) => {
      count++;
      expect(String(url)).toBe(`${ORIGIN}${CONNECTION_PATH}`);
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('manual');
      expect(init?.credentials).toBe('omit');
      expect(init?.headers).toBeUndefined();
      expect(init?.body).toBeUndefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(fixture());
    });
    expect(await detectBackend(ORIGIN)).toEqual(backend);
    expect(await detectBackend(ORIGIN)).toEqual(backend);
    expect(count).toBe(2);
  });

  test('only 404 retains legacy v3, regardless of its body', async () => {
    setFetchForTests(async () => new Response('not json', { status: 404 }));
    expect(await detectBackend(ORIGIN)).toEqual(V3_BACKEND);
  });

  const invalidDocuments: [string, () => unknown][] = [
    ['null', () => null], ['array', () => []], ['empty', () => ({})],
    ['unknown product', () => ({ ...fixture(), product: 'other' })],
    ['disagreeing v3 product', () => ({ ...fixture(), product: 'embrace-v3' })],
    ['missing instance', () => ({ ...fixture(), instance: undefined })],
    ['empty instance', () => ({ ...fixture(), instance: { id: ' ' } })],
    ['issuer origin', () => ({ ...fixture(), issuer: 'https://other.example.test/api/auth' })],
    ['issuer path', () => ({ ...fixture(), issuer: `${ORIGIN}/other` })],
    ['issuer trailing slash', () => ({ ...fixture(), issuer: `${ORIGIN}/api/auth/` })],
    ['issuer query', () => ({ ...fixture(), issuer: `${ORIGIN}/api/auth?x=1` })],
    ['API origin', () => ({ ...fixture(), api: { ...fixture().api, baseUrl: 'https://other.example.test' } })],
    ['API scheme', () => ({ ...fixture(), api: { ...fixture().api, baseUrl: 'http://example.test' } })],
    ['API port', () => ({ ...fixture(), api: { ...fixture().api, baseUrl: `${ORIGIN}:444` } })],
    ['API credentials', () => ({ ...fixture(), api: { ...fixture().api, baseUrl: 'https://user:password@example.test' } })],
    ['API query', () => ({ ...fixture(), api: { ...fixture().api, baseUrl: `${ORIGIN}?x=1` } })],
    ['API fragment', () => ({ ...fixture(), api: { ...fixture().api, baseUrl: `${ORIGIN}#x` } })],
    ['API relative URL', () => ({ ...fixture(), api: { ...fixture().api, baseUrl: '/trpc' } })],
    ['transport', () => ({ ...fixture(), api: { ...fixture().api, transport: 'rest' } })],
    ['discovery disagreement', () => ({ ...fixture(), api: { ...fixture().api, procedureDiscovery: true } })],
    ['discovery missing', () => ({ ...fixture(), api: { ...fixture().api, procedureDiscovery: undefined } })],
    ['initial procedure disagreement', () => ({ ...fixture(), api: { ...fixture().api, initialAllowedProcedure: 'core.other.query' } })],
    ['approval mode', () => ({ ...fixture(), approvalMode: 'unknown' })],
  ];
  for (const [name, document] of invalidDocuments) test(`fails closed: ${name}`, async () => {
    setFetchForTests(async () => Response.json(document()));
    await expect(detectBackend(ORIGIN)).rejects.toThrow(CONNECTION_ERROR);
  });
  for (const status of [204, 301, 302, 307, 308, 400, 401, 403, 429, 500, 503]) {
    test(`fails closed: HTTP ${status}`, async () => {
      setFetchForTests(async () => new Response(null, { status, headers: { Location: 'https://other.example.test' } }));
      await expect(detectBackend(ORIGIN)).rejects.toThrow(status >= 500 ? 'Embrace backend unavailable (server error); try again' : CONNECTION_ERROR);
    });
  }
  test('rejects followed redirects even when a fetch implementation returns 200 or 404', async () => {
    for (const status of [200, 404]) {
      setFetchForTests(async () => {
        const response = new Response(JSON.stringify(fixture()), { status });
        Object.defineProperty(response, 'redirected', { value: true });
        return response;
      });
      await expect(detectBackend(ORIGIN)).rejects.toThrow(CONNECTION_ERROR);
    }
  });
  test('rejects a response from a different URL', async () => {
    setFetchForTests(async () => {
      const response = Response.json(fixture());
      Object.defineProperty(response, 'url', { value: 'https://other.example.test' });
      return response;
    });
    await expect(detectBackend(ORIGIN)).rejects.toThrow(CONNECTION_ERROR);
  });
  test('malformed JSON and network errors expose only the fixed error', async () => {
    for (const stub of [async () => new Response('private-invalid-json')]) {
      setFetchForTests(stub);
      await expect(detectBackend(ORIGIN)).rejects.toThrow(CONNECTION_ERROR);
    }
  });
  test('accepts the builder omission when no initial API permission is registered', async () => {
    const document = fixture();
    delete (document.api as { initialAllowedProcedure?: string }).initialAllowedProcedure;
    document.approvalMode = 'review-split-origin';
    setFetchForTests(async () => Response.json(document));
    expect(await detectBackend(ORIGIN)).toEqual({ product: 'embrace-v2', baseUrl: ORIGIN, procedureDiscovery: false });
  });
});

describe('v2 queries', () => {
  test('uses strict bounded dotted names without broadening legacy v3 validation', () => {
    for (const name of [INITIAL_V2_PROCEDURE, 'custom_module.get_one', 'v3.agent.listThreads']) expect(() => assertProcedureName(name, backend)).not.toThrow();
    for (const name of ['', 'core', 'core..auth', '.core.auth', 'core.auth.', '../core.auth', 'core.auth/x', 'core.auth?x', 'core.auth#x', 'core.auth%2Fquery', 'core.auth,other.query', 'core.\nquery', 'core.query\n', 'core.query\r', 'core.é', 'core.' + 'a'.repeat(196)]) {
      expect(() => assertProcedureName(name, backend)).toThrow();
    }
    expect(() => assertProcedureName('core.' + 'a'.repeat(195), backend)).not.toThrow();
    expect(() => assertProcedureName(INITIAL_V2_PROCEDURE)).toThrow(/v3/);
    expect(() => assertProcedureName('v3.custom_module.get_one')).toThrow(/v3/);
    expect(() => assertProcedureName('v3.agent.listThreads')).not.toThrow();
  });
  test('GETs the advertised base and procedure without /trpc or metadata calls; decodes SuperJSON', async () => {
    let count = 0;
    setFetchForTests(async (url, init) => {
      count++;
      expect(String(url)).toBe(`${ORIGIN}/${INITIAL_V2_PROCEDURE}?input=${encodeURIComponent('{"json":{}}')}`);
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe('error');
      expect(init?.credentials).toBe('omit');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fixture-access');
      return Response.json({ result: { data: { json: { userId: 'fixture-user', date: '2026-01-01T00:00:00.000Z' }, meta: { values: { date: ['Date'] }, v: 1 } } } });
    });
    const result = await callQuery({ origin: ORIGIN, procedure: INITIAL_V2_PROCEDURE, input: {}, accessToken: token.access_token, backend });
    expect(result).toMatchObject({ ok: true, data: { userId: 'fixture-user', date: new Date('2026-01-01T00:00:00Z') } });
    expect(count).toBe(1);
  });
  test('uses a validated same-origin base path and keeps input plain JSON without Date inference', async () => {
    setFetchForTests(async (url) => {
      expect(new URL(url).pathname).toBe('/api/query/custom.getOne');
      expect(JSON.parse(new URL(url).searchParams.get('input')!)).toEqual({ json: { date: '2026-01-01T00:00:00Z' } });
      return Response.json({ result: { data: { json: null } } });
    });
    expect((await callQuery({ origin: ORIGIN, procedure: 'custom.getOne', input: { date: '2026-01-01T00:00:00Z' }, accessToken: token.access_token, backend: { ...backend, baseUrl: `${ORIGIN}/api/query` } })).ok).toBe(true);
  });
  test('mutation or auth rejection over GET never retries with POST', async () => {
    for (const code of ['METHOD_NOT_SUPPORTED', 'UNAUTHORIZED', 'FORBIDDEN']) {
      let count = 0;
      setFetchForTests(async (_, init) => {
        count++;
        expect(init?.method).toBe('GET');
        return Response.json({ error: { json: { message: 'private-diagnostic', data: { code } } } }, { status: 401 });
      });
      const result = await callQuery({ origin: ORIGIN, procedure: INITIAL_V2_PROCEDURE, input: {}, accessToken: token.access_token, backend });
      expect(result).toEqual({ ok: false, httpStatus: 401, errorCode: code });
      expect(count).toBe(1);
    }
  });
});

describe('backend-aware CLI', () => {
  function stub() {
    const requests: string[] = [];
    setFetchForTests(async (url, init) => {
      requests.push(String(url));
      expect(init?.method).toBe('GET');
      if (String(url).endsWith(CONNECTION_PATH)) return Response.json(fixture());
      expect(new URL(url).pathname).toBe(`/${INITIAL_V2_PROCEDURE}`);
      return Response.json({ result: { data: { json: { userId: 'fixture-user', isSuperUser: false } } } });
    });
    return requests;
  }
  test('signed-in v2 CLI query dispatches once with no state writes', async () => {
    const requests = stub(), out: string[] = [], err: string[] = [];
    const code = await runCommand(parseCliArgs(['call', '--origin', ORIGIN, INITIAL_V2_PROCEDURE, '{}']), {
      tokenStore: { ...tokenStore, put: async () => { throw new Error('Unexpected state write'); } },
      stdout: text => out.push(text), stderr: text => err.push(text),
    });
    expect(code).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ userId: 'fixture-user', isSuperUser: false });
    expect(err).toEqual([]);
    expect(requests).toHaveLength(2);
  });
  test('explicit-origin status detects v2 without a session; call then refuses cleanly', async () => {
    const requests = stub(), out: string[] = [], err: string[] = [];
    const context = { tokenStore: { ...tokenStore, get: async () => null, list: async () => [] }, stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) };
    expect(await runCommand(parseCliArgs(['status', '--origin', ORIGIN, '--json']), context)).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ sessions: [], backend: { product: 'embrace-v2', procedureDiscovery: false, initialAllowedProcedure: INITIAL_V2_PROCEDURE } });
    expect(out.join()).not.toContain('fixture-instance');
    expect(await runCommand(parseCliArgs(['call', '--origin', ORIGIN, INITIAL_V2_PROCEDURE, '{}']), context)).toBe(2);
    expect(err.join()).toContain('not signed in');
    expect(requests).toEqual([`${ORIGIN}${CONNECTION_PATH}`, `${ORIGIN}${CONNECTION_PATH}`]);
  });
  for (const argv of [
    ['mutate', INITIAL_V2_PROCEDURE, '{}'],
    ['discover'], ['discover', '--type', 'mutation'],
    ['describe', INITIAL_V2_PROCEDURE], ['describe', '--type', 'mutation', INITIAL_V2_PROCEDURE],
    ...[LIST_QUERIES, LIST_MUTATIONS, DESCRIBE_QUERY, DESCRIBE_MUTATION].map(name => ['call', name, '{}']),
  ]) test(`v2 refuses without discovery/POST dispatch: ${argv.join(' ')}`, async () => {
    const requests = stub(), err: string[] = [];
    const code = await runCommand(parseCliArgs([argv[0]!, '--origin', ORIGIN, ...argv.slice(1)]), {
      tokenStore, stdout: () => {}, stderr: text => err.push(text),
    });
    expect(code).toBe(1);
    expect(err.join()).toContain(argv[0] === 'mutate' ? 'V2 mutations are not supported' : INITIAL_V2_PROCEDURE);
    expect(requests).toEqual([`${ORIGIN}${CONNECTION_PATH}`]);
  });
  test('invalid connection metadata fails before token access or API dispatch', async () => {
    let count = 0;
    setFetchForTests(async () => { count++; return Response.json({ private: 'private-server-content' }); });
    const err: string[] = [];
    expect(await runCommand(parseCliArgs(['call', '--origin', ORIGIN, INITIAL_V2_PROCEDURE, '{}']), {
      tokenStore: { ...tokenStore, get: async () => { throw new Error('private-token-read'); } }, stderr: text => err.push(text),
    })).toBe(1);
    expect(err).toEqual([JSON.stringify({ error: CONNECTION_ERROR })]);
    expect(count).toBe(2);
  });
  test('discovery and mutation refusal precede session access or refresh', async () => {
    const requests = stub();
    for (const argv of [['discover'], ['describe', INITIAL_V2_PROCEDURE], ['mutate', INITIAL_V2_PROCEDURE, '{}']]) {
      const err: string[] = [];
      expect(await runCommand(parseCliArgs([argv[0]!, '--origin', ORIGIN, ...argv.slice(1)]), {
        tokenStore: { ...tokenStore, get: async () => { throw new Error('Unexpected session access'); } },
        stderr: text => err.push(text),
      })).toBe(1);
      expect(err.join()).not.toContain('Unexpected session access');
    }
    expect(requests).toEqual(Array(3).fill(`${ORIGIN}${CONNECTION_PATH}`));
  });
  test('discovery refusal does not fabricate an initial procedure when omitted', async () => {
    const document = fixture();
    delete (document.api as { initialAllowedProcedure?: string }).initialAllowedProcedure;
    setFetchForTests(async () => Response.json(document));
    const err: string[] = [];
    expect(await runCommand(parseCliArgs(['discover', '--origin', ORIGIN]), { tokenStore, stderr: text => err.push(text) })).toBe(1);
    expect(err.join()).toContain('No initial allowed procedure is advertised');
    expect(err.join()).not.toContain(INITIAL_V2_PROCEDURE);
  });
  test('404 still rejects v2 describe names before the v3 metadata request', async () => {
    let count = 0;
    setFetchForTests(async () => { count++; return new Response(null, { status: 404 }); });
    const err: string[] = [];
    expect(await runCommand(parseCliArgs(['describe', '--origin', ORIGIN, INITIAL_V2_PROCEDURE]), { tokenStore, stderr: text => err.push(text) })).toBe(1);
    expect(err.join()).toContain('v3.<module>.<name>');
    expect(count).toBe(2);
  });
  test('404 preserves v3 URL, fresh discovery and query output', async () => {
    const requests: string[] = [];
    setFetchForTests(async (url, init) => {
      requests.push(new URL(url).pathname);
      expect(init?.method).toBe('GET');
      if ((String(url).endsWith(CONNECTION_PATH) || String(url).endsWith(FRONTEND_POINTER_PATH))) return new Response(null, { status: 404 });
      return Response.json({ result: { data: { json: { items: [] } } } });
    });
    const out: string[] = [];
    expect(await runCommand(parseCliArgs(['call', '--origin', ORIGIN, 'v3.agent.listThreads', '{}']), { tokenStore, stdout: text => out.push(text) })).toBe(0);
    expect(requests).toEqual([CONNECTION_PATH, FRONTEND_POINTER_PATH, `/trpc/${DESCRIBE_QUERY}`, '/trpc/v3.agent.listThreads']);
    expect(JSON.parse(out[0]!)).toEqual({ items: [] });
  });
});


const FRONTEND = 'https://frontend.example.test';
const pointerFixture = () => ({ product: 'embrace-v2', kind: 'frontend-pointer', version: 1,
  instance: { id: 'fixture-instance' }, backendOrigin: ORIGIN });
const boundDocument = () => ({ ...fixture(), approvalMode: 'review-split-origin', frontendOrigins: [FRONTEND] });

describe('frontend pointer mutual binding', () => {
  function install(options: { initial?: () => Response; pointer?: unknown; document?: unknown } = {}) {
    const requests: string[] = [];
    setFetchForTests(async (url, init) => {
      requests.push(String(url));
      expect(init?.method).toBe('GET');
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('manual');
      expect(init?.headers).toBeUndefined();
      if (String(url) === `${FRONTEND}${CONNECTION_PATH}`) return options.initial?.() ?? new Response(null, { status: 404 });
      if (String(url) === `${FRONTEND}${FRONTEND_POINTER_PATH}`) return Response.json(options.pointer ?? pointerFixture());
      if (String(url) === `${ORIGIN}${CONNECTION_PATH}`) return Response.json(options.document ?? boundDocument());
      throw new Error('Unexpected request');
    });
    return requests;
  }
  test('resolves a single mutually bound pointer after 404 or HTML without credentials', async () => {
    for (const initial of [() => new Response(null, { status: 404 }), () => new Response('<html>SPA</html>')]) {
      const requests = install({ initial });
      expect(await resolveConnection(FRONTEND)).toEqual({ origin: ORIGIN, frontendOrigin: FRONTEND, backend });
      expect(requests).toEqual([`${FRONTEND}${CONNECTION_PATH}`, `${FRONTEND}${FRONTEND_POINTER_PATH}`, `${ORIGIN}${CONNECTION_PATH}`]);
    }
  });
  test('valid direct v2 backend never probes a pointer', async () => {
    const requests = install();
    expect(await resolveConnection(ORIGIN)).toEqual({ origin: ORIGIN, backend });
    expect(requests).toEqual([`${ORIGIN}${CONNECTION_PATH}`]);
  });
  test('absent pointer preserves original 404 or HTML/malformed document outcomes', async () => {
    for (const [initial, expected] of [
      [() => new Response(null, { status: 404 }), 'v3'],
      [() => new Response('<html>SPA</html>'), 'error'],
      [() => Response.json({ product: 'unknown' }), 'error'],
      [() => new Response(null, { status: 400 }), 'error'],
    ] as const) {
      const requests: string[] = [];
      setFetchForTests(async url => {
        requests.push(String(url));
        return String(url).endsWith(FRONTEND_POINTER_PATH) ? new Response(null, { status: 404 }) : initial();
      });
      if (expected === 'v3') expect(await resolveConnection(FRONTEND)).toEqual({ origin: FRONTEND, backend: V3_BACKEND });
      else await expect(resolveConnection(FRONTEND)).rejects.toThrow(CONNECTION_ERROR);
      expect(requests).toHaveLength(2);
    }
  });
  test('additional frontend members are allowed; normalized entered origin must be an exact member', async () => {
    install({ document: { ...boundDocument(), frontendOrigins: ['https://other.example.test', FRONTEND] } });
    expect((await resolveConnection(FRONTEND)).origin).toBe(ORIGIN);
  });
  const invalidPointers: [string, () => unknown][] = [
    ['unknown product', () => ({ ...pointerFixture(), product: 'other' })],
    ['wrong kind', () => ({ ...pointerFixture(), kind: 'backend' })],
    ['wrong version', () => ({ ...pointerFixture(), version: 2 })],
    ['string version', () => ({ ...pointerFixture(), version: '1' })],
    ['extra field', () => ({ ...pointerFixture(), extra: true })],
    ['missing field', () => { const { version, ...rest } = pointerFixture(); return rest; }],
    ['extra instance field', () => ({ ...pointerFixture(), instance: { id: 'fixture-instance', extra: true } })],
    ['empty id', () => ({ ...pointerFixture(), instance: { id: ' ' } })],
    ['array instance', () => ({ ...pointerFixture(), instance: [] })],
    ['array pointer', () => []],
    ...['http://backend.example.test', `${ORIGIN}/`, `${ORIGIN}/path`, `${ORIGIN}?x=1`, `${ORIGIN}#x`,
      'https://user:password@example.test', 'https://example.test:443', FRONTEND, '/relative', 'not a URL']
      .map(origin => [`target ${origin}`, () => ({ ...pointerFixture(), backendOrigin: origin })] as [string, () => unknown]),
  ];
  for (const [name, pointer] of invalidPointers) test(`rejects pointer ${name}`, async () => {
    const requests = install({ pointer: pointer() });
    await expect(resolveConnection(FRONTEND)).rejects.toThrow(CONNECTION_ERROR);
    expect(requests).toHaveLength(2);
  });
  const invalidBindings: [string, () => unknown][] = [
    ['id mismatch', () => ({ ...boundDocument(), instance: { id: 'other-fixture' } })],
    ['missing frontendOrigins', () => ({ ...fixture(), approvalMode: 'review-split-origin' })],
    ['empty frontendOrigins', () => ({ ...boundDocument(), frontendOrigins: [] })],
    ['wrong frontend', () => ({ ...boundDocument(), frontendOrigins: ['https://other.example.test'] })],
    ['nonexact frontend', () => ({ ...boundDocument(), frontendOrigins: [`${FRONTEND}/`] })],
    ['string frontendOrigins', () => ({ ...boundDocument(), frontendOrigins: FRONTEND })],
    ['wrong approval mode', () => ({ ...boundDocument(), approvalMode: 'app-origin' })],
    ['issuer mismatch', () => ({ ...boundDocument(), issuer: `${FRONTEND}/api/auth` })],
    ['API mismatch', () => ({ ...boundDocument(), api: { ...fixture().api, baseUrl: FRONTEND } })],
    ['chain', () => pointerFixture()],
  ];
  for (const [name, document] of invalidBindings) test(`rejects binding ${name} without following a second pointer`, async () => {
    const requests = install({ document: document() });
    await expect(resolveConnection(FRONTEND)).rejects.toThrow(CONNECTION_ERROR);
    expect(requests).toHaveLength(3);
    expect(requests).not.toContain(`${ORIGIN}${FRONTEND_POINTER_PATH}`);
  });
  for (const stage of ['pointer', 'backend']) {
    for (const mode of ['404', 'redirect', 'followed', 'wrong-url', 'HTML', 'network', '503']) {
      test(`${stage} ${mode} fails closed (404 pointer alone retains v3)`, async () => {
        let count = 0;
        setFetchForTests(async url => {
          count++;
          if (String(url) === `${FRONTEND}${CONNECTION_PATH}`) return new Response(null, { status: 404 });
          if (stage === 'backend' && String(url).endsWith(FRONTEND_POINTER_PATH)) return Response.json(pointerFixture());
          if (mode === 'network') throw new Error('private-network-diagnostic');
          if (mode === 'HTML') return new Response('<html>SPA</html>');
          if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: ORIGIN } });
          if (mode === '404' || mode === '503') return new Response(null, { status: Number(mode) });
          const response = Response.json(stage === 'pointer' ? pointerFixture() : boundDocument());
          Object.defineProperty(response, mode === 'followed' ? 'redirected' : 'url', { value: mode === 'followed' ? true : 'https://other.example.test' });
          return response;
        });
        if (stage === 'pointer' && mode === '404') expect((await resolveConnection(FRONTEND)).backend).toEqual(V3_BACKEND);
        else await expect(resolveConnection(FRONTEND)).rejects.toThrow(mode === 'network' || mode === '503' ? 'Embrace backend unavailable' : CONNECTION_ERROR);
        expect(count).toBe((stage === 'pointer' ? 2 : 3) + (mode === 'network' || mode === '503' ? 1 : 0));
      });
    }
  }
});


describe('bounded discovery availability', () => {
  test('timeout once then valid document succeeds without falling back', async () => {
    let count = 0;
    setFetchForTests(async url => {
      expect(String(url)).toBe(`${ORIGIN}${CONNECTION_PATH}`);
      if (++count === 1) throw new DOMException('private-timeout-diagnostic', 'TimeoutError');
      return Response.json(fixture());
    });
    expect(await detectBackend(ORIGIN)).toEqual(backend);
    expect(count).toBe(2);
  });
  for (const reason of ['timeout', 'network', 'server']) test(`${reason} has a fixed retryable diagnostic, never v3 or malformed fallback`, async () => {
    let count = 0;
    setFetchForTests(async () => {
      count++;
      if (reason === 'server') return new Response(null, { status: 503 });
      throw reason === 'timeout' ? new DOMException('private', 'TimeoutError') : new TypeError('private');
    });
    await expect(resolveConnection(ORIGIN)).rejects.toThrow(reason === 'timeout'
      ? 'Embrace backend unavailable (timed out); try again'
      : `Embrace backend unavailable (${reason} error); try again`);
    expect(count).toBe(2);
  });
  test('malformed JSON remains contract error with absent pointer and is not retried', async () => {
    const requests: string[] = [];
    setFetchForTests(async url => {
      requests.push(String(url));
      return String(url).endsWith(FRONTEND_POINTER_PATH) ? new Response(null, { status: 404 }) : new Response('<html>SPA</html>');
    });
    await expect(resolveConnection(ORIGIN)).rejects.toThrow(CONNECTION_ERROR);
    expect(requests).toEqual([`${ORIGIN}${CONNECTION_PATH}`, `${ORIGIN}${FRONTEND_POINTER_PATH}`]);
  });
  test('pointer and bound backend reads each tolerate one timeout, without chains', async () => {
    const counts = new Map<string, number>();
    setFetchForTests(async url => {
      const key = String(url), count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (key === `${FRONTEND}${CONNECTION_PATH}`) return new Response(null, { status: 404 });
      if (count === 1) throw new DOMException('private', 'TimeoutError');
      return Response.json(key.endsWith(FRONTEND_POINTER_PATH) ? pointerFixture() : boundDocument());
    });
    expect((await resolveConnection(FRONTEND)).origin).toBe(ORIGIN);
    expect([...counts.values()]).toEqual([1, 2, 2]);
  });
});


test('an unavailable attempt followed by 404 cannot silently select v3', async () => {
  for (const failure of ['timeout', 'server']) {
    let count = 0;
    setFetchForTests(async () => {
      if (++count === 1) {
        if (failure === 'timeout') throw new DOMException('private', 'TimeoutError');
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 404 });
    });
    await expect(resolveConnection(ORIGIN)).rejects.toThrow('Embrace backend unavailable');
    expect(count).toBe(2);
  }
});

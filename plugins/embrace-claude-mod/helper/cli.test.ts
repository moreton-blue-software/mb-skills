// CLI argument parsing and the full fake-origin flow (login --url-only →
// --complete → call → expiry refresh → logout) against a stubbed HTTP layer
// and real file-backed stores in temp directories. No live server; stdout is
// asserted to carry no token, code, cookie or auth-header material.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError, parseCliArgs, runCommand, type CliContext } from './cli';
import { setFetchForTests } from './fetch';
import { CONNECTION_PATH, FRONTEND_POINTER_PATH, INITIAL_V2_PROCEDURE } from './connection';
import { FilePendingLoginStore, FileTokenStore } from './token-store';

afterEach(() => setFetchForTests());

const ORIGIN = 'http://localhost:5999';

describe('parseCliArgs', () => {
  test('login with origin and flags', () => {
    expect(parseCliArgs(['login', '--origin', ORIGIN, '--url-only']))
      .toMatchObject({ command: 'login', origin: ORIGIN, urlOnly: true, complete: false });
    expect(parseCliArgs(['login', '--origin', ORIGIN])).toMatchObject({ urlOnly: false, complete: false });
  });

  test('call with procedure and json input', () => {
    expect(parseCliArgs(['call', '--origin', ORIGIN, 'v3.agent.getThread', '{"threadId":"t1"}']))
      .toMatchObject({ command: 'call', procedure: 'v3.agent.getThread', inputJson: '{"threadId":"t1"}' });
  });

  test('logout and status', () => {
    expect(parseCliArgs(['logout', '--origin', ORIGIN])).toMatchObject({ command: 'logout', force: false });
    expect(parseCliArgs(['status', '--json'])).toMatchObject({ command: 'status', json: true });
  });

  test('refuses invalid invocations', () => {
    expect(() => parseCliArgs([])).toThrow(CliError);
    expect(() => parseCliArgs(['nope'])).toThrow(/unknown subcommand/);
    expect(() => parseCliArgs(['login'])).toThrow(/--origin/);
    expect(() => parseCliArgs(['call', '--origin', ORIGIN])).toThrow(/procedure/);
    expect(() => parseCliArgs(['call', '--origin', ORIGIN, 'v3.agent.listThreads', '{}', 'extra'])).toThrow(/at most two/);
    expect(() => parseCliArgs(['call', '--origin', ORIGIN, 'v3.agent.listThreads', '{oops'])).toThrow(/JSON/);
    expect(() => parseCliArgs(['logout', '--origin', ORIGIN, '--unknown'])).toThrow(/arguments/);
  });
});

/** Collecting CLI context with real stores rooted in a fresh temp directory. */
function makeContext(stdin?: string): { ctx: CliContext; out: string[]; err: string[]; tokens: FileTokenStore; pending: FilePendingLoginStore } {
  const dir = mkdtempSync(join(tmpdir(), 'embrace-cli-cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const tokens = new FileTokenStore(dir);
  const pending = new FilePendingLoginStore(dir);
  const ctx: CliContext = {
    stdout: text => out.push(text),
    stderr: text => err.push(text),
    stdin,
    tokenStore: tokens,
    pendingStore: pending,
  };
  return { ctx, out, err, tokens, pending };
}

function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.sig`;
}

interface HttpStub {
  requests: { url: string; body: string }[];
  grantFor: (body: string) => Record<string, unknown> | undefined;
  revokeStatus: number;
  trpc: (url: string, body: string) => { status: number; payload: unknown };
}

function installHttpStub(stub: Partial<HttpStub> = {}): HttpStub['requests'] {
  const config: HttpStub = {
    requests: [],
    grantFor: () => undefined,
    revokeStatus: 200,
    trpc: () => ({ status: 200, payload: { result: { data: { json: [] } } } }),
    ...stub,
  };
  setFetchForTests(async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? '');
    config.requests.push({ url, body });
    if (url.endsWith('/api/auth/oauth2/token')) {
      const grant = config.grantFor(body);
      if (!grant) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      return Response.json(grant);
    }
    if (url.endsWith('/api/auth/oauth2/revoke')) {
      return new Response(null, { status: config.revokeStatus });
    }
    if (url.includes('/trpc/')) {
      const { status, payload } = config.trpc(url, body);
      return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  });
  return config.requests;
}

const THREADS = [{ id: 't1', title: 'Local approval', source: 'ask', status: 'Awaiting review', blockedReason: null, updatedAt: '2026-10-23T00:00:00.000Z' }];

describe('fake-origin flow', () => {
  test('login url-only → complete → call → refresh → logout', async () => {
    const { ctx, out, err, tokens } = makeContext();
    const requests = installHttpStub({
      grantFor: body => {
        if (body.includes('grant_type=authorization_code')) {
          return {
            access_token: fakeJwt({ email: 'dev@mb.test', exp: Math.floor(Date.now() / 1000) + 3600 }),
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'REFRESH-1',
            id_token: fakeJwt({ email: 'dev@mb.test' }),
          };
        }
        if (body.includes('grant_type=refresh_token')) {
          expect(body).toContain('client_id=claude-embrace-cli');
          expect(body).toContain(`resource=${encodeURIComponent(`${ORIGIN}/api/auth`)}`);
          return {
            access_token: fakeJwt({ email: 'dev@mb.test', exp: Math.floor(Date.now() / 1000) + 7200 }),
            token_type: 'Bearer',
            expires_in: 7200,
            refresh_token: 'REFRESH-2',
          };
        }
        return undefined;
      },
      trpc: url => ({
        status: 200,
        payload: url.includes('listThreads')
          ? { result: { data: { json: THREADS } } }
          : { result: { data: { json: { thread: { id: 't1', title: 'Example' } } } } },
      }),
    });

    // Step 1: url-only prints the authorize URL and parks the verifier.
    expect(await runCommand(parseCliArgs(['login', '--origin', ORIGIN, '--url-only']), ctx)).toBe(0);
    const started = JSON.parse(out[0]!) as { authorizeUrl: string; state: string; origin: string };
    expect(started.origin).toBe(ORIGIN);
    expect(new URL(started.authorizeUrl).searchParams.get('client_id')).toBe('claude-embrace-cli');
    expect(started.state).toMatch(/^[0-9a-f-]{36}$/);

    // Step 2: complete with the pasted code (and state) over stdin.
    expect(await runCommand(parseCliArgs(['login', '--origin', ORIGIN, '--complete']), {
      ...ctx,
      stdin: `the-one-time-code ${started.state}\n`,
    })).toBe(0);
    const signedIn = JSON.parse(out[1]!) as { origin: string; email: string };
    expect(signedIn).toEqual({ origin: ORIGIN, email: 'dev@mb.test' });

    // Step 3: call listThreads (void input envelope, bearer header).
    expect(await runCommand(parseCliArgs(['call', '--origin', ORIGIN, 'v3.agent.listThreads']), ctx)).toBe(0);
    expect(JSON.parse(out[2]!)).toEqual(THREADS);
    const listRequest = requests.find(request => request.url.startsWith(`${ORIGIN}/trpc/v3.agent.listThreads?`))!;
    expect(decodeURIComponent(listRequest.url.split('?')[1]!)).toContain('{"json":null,"meta":{"values":["undefined"],"v":1}}');

    // Step 4: getThread query with an object input.
    expect(await runCommand(parseCliArgs(['call', '--origin', ORIGIN, 'v3.agent.getThread', '{"threadId":"t1"}']), ctx)).toBe(0);
    expect(JSON.parse(out[3]!)).toEqual({ thread: { id: 't1', title: 'Example' } });
    const detailRequest = requests.find(request => request.url.startsWith(`${ORIGIN}/trpc/v3.agent.getThread?`))!;
    expect(new URL(detailRequest.url).searchParams.get('input')).toBe('{"json":{"threadId":"t1"}}');

    // Step 5: expiry forces a refresh; the rotated refresh token is persisted.
    const current = await tokens.get(ORIGIN);
    await tokens.put({ ...current!, expires_at: Date.now() - 1000 });
    expect(await runCommand(parseCliArgs(['call', '--origin', ORIGIN, 'v3.agent.listThreads']), ctx)).toBe(0);
    expect(requests.filter(request => request.url.endsWith('/oauth2/token') && request.body.includes('grant_type=refresh_token'))).toHaveLength(1);
    expect((await tokens.get(ORIGIN))?.refresh_token).toBe('REFRESH-2');
    expect(JSON.parse(out[4]!)).toEqual(THREADS);

    // Step 6: logout revokes the refresh token and drops the entry.
    expect(await runCommand(parseCliArgs(['logout', '--origin', ORIGIN]), ctx)).toBe(0);
    expect(JSON.parse(out[5]!)).toEqual({ origin: ORIGIN, signedOut: true });
    const revoke = requests.find(request => request.url.endsWith('/oauth2/revoke'))!;
    expect(revoke.body).toContain('token_type_hint=refresh_token');
    expect(revoke.body).toContain('client_id=claude-embrace-cli');
    expect(revoke.body).toContain('token=REFRESH-2');
    expect(await tokens.get(ORIGIN)).toBeNull();

    // Status prints only origin/email/expiry boolean.
    expect(await runCommand(parseCliArgs(['status', '--json']), ctx)).toBe(0);
    expect(JSON.parse(out[6]!)).toEqual({ sessions: [] });

    // Security: nothing sensitive ever reached stdout or stderr.
    const allOutput = [...out, ...err].join('\n');
    for (const secret of ['the-one-time-code', 'REFRESH-1', 'REFRESH-2', 'Bearer ', 'code_verifier']) {
      expect(allOutput).not.toContain(secret);
    }
  });

  test('call without a session exits 2 with a login hint', async () => {
    const { ctx, out, err } = makeContext();
    installHttpStub();
    const code = await runCommand(parseCliArgs(['call', '--origin', ORIGIN, 'v3.agent.listThreads']), ctx);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    const failure = JSON.parse(err[0]!) as { error: string; hint: string };
    expect(failure.error).toContain('not signed in');
    expect(failure.hint).toContain('login');
  });

  test('state mismatch refuses the exchange and clears the pending login', async () => {
    const { ctx, out, err, pending } = makeContext();
    installHttpStub();
    expect(await runCommand(parseCliArgs(['login', '--origin', ORIGIN, '--url-only']), ctx)).toBe(0);
    const started = JSON.parse(out[0]!) as { state: string };
    const code = await runCommand(parseCliArgs(['login', '--origin', ORIGIN, '--complete']), {
      ...ctx,
      stdin: `some-code not-${started.state}`,
    });
    expect(code).toBe(1);
    expect((JSON.parse(err[0]!) as { error: string }).error).toMatch(/state mismatch/);
    expect(await pending.get(ORIGIN)).toBeNull();
  });

  test('tRPC UNAUTHORIZED failure reports the code with a sign-in hint', async () => {
    const { ctx, out, err, tokens } = makeContext();
    installHttpStub({
      trpc: () => ({ status: 401, payload: { error: { json: { message: 'nope', data: { code: 'UNAUTHORIZED' } } } } }),
    });
    await tokens.put({
      origin: ORIGIN,
      email: 'dev@mb.test',
      access_token: 'STILL-VALID-ACCESS',
      refresh_token: 'REFRESH',
      expires_at: Date.now() + 3_600_000,
    });
    const code = await runCommand(parseCliArgs(['call', '--origin', ORIGIN, 'v3.agent.listThreads']), ctx);
    expect(code).toBe(1);
    const failure = JSON.parse(err[0]!) as { error: string; hint: string };
    expect(failure.error).toContain('UNAUTHORIZED');
    expect(failure.hint).toContain('sign');
    expect(out.join('\n')).not.toContain('STILL-VALID-ACCESS');
  });

  test('logout without revoke reachability keeps the session unless --force', async () => {
    const { ctx, out, err, tokens } = makeContext();
    installHttpStub({ revokeStatus: 503 });
    await tokens.put({
      origin: ORIGIN,
      email: 'dev@mb.test',
      access_token: 'A',
      refresh_token: 'R',
      expires_at: Date.now() + 3_600_000,
    });
    expect(await runCommand(parseCliArgs(['logout', '--origin', ORIGIN]), ctx)).toBe(1);
    expect(await tokens.get(ORIGIN)).not.toBeNull();
    expect(await runCommand(parseCliArgs(['logout', '--origin', ORIGIN, '--force']), ctx)).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ origin: ORIGIN, signedOut: false, localSessionRemoved: true, reason: 'logout not confirmed, retry' });
    expect(await tokens.get(ORIGIN)).toBeNull();
  });
});


describe('frontend URL lifecycle', () => {
  const frontend = 'https://frontend.example.test';
  const backendOrigin = 'https://backend.example.test';
  for (const approvalMode of ['review-split-origin', 'split-origin'])
  for (const completionOrigin of [frontend, backendOrigin]) test(`${approvalMode}: login completion via ${completionOrigin === frontend ? 'frontend' : 'backend'} preserves one backend session`, async () => {
    const { ctx, out, err, tokens, pending } = makeContext();
    const requests: { url: string; method: string; body: string }[] = [];
    setFetchForTests(async (input, init) => {
      const url = String(input), body = String(init?.body ?? '');
      requests.push({ url, method: init?.method ?? 'GET', body });
      if (url === `${frontend}${CONNECTION_PATH}`) return new Response('<html>SPA</html>');
      if (url === `${frontend}${FRONTEND_POINTER_PATH}`) return Response.json({ product: 'embrace-v2', kind: 'frontend-pointer', version: 1,
        instance: { id: 'fixture-instance' }, backendOrigin });
      if (url === `${backendOrigin}${CONNECTION_PATH}`) return Response.json({ product: 'embrace-v2', instance: { id: 'fixture-instance' },
        issuer: `${backendOrigin}/api/auth`, api: { transport: 'trpc', baseUrl: backendOrigin, procedureDiscovery: false, initialAllowedProcedure: INITIAL_V2_PROCEDURE },
        approvalMode, frontendOrigins: [frontend] });
      expect(new URL(url).origin).toBe(backendOrigin);
      if (url.endsWith('/oauth2/token')) {
        expect(body).toContain(`resource=${encodeURIComponent(`${backendOrigin}/api/auth`)}`);
        return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'Bearer', id_token: 'synthetic-id-token' });
      }
      if (url.endsWith('/oauth2/revoke')) return new Response(null, { status: 200 });
      expect(new URL(url).pathname).toBe(`/${INITIAL_V2_PROCEDURE}`);
      expect(init?.method).toBe('GET');
      expect(JSON.parse(new URL(url).searchParams.get('input')!)).toEqual({ json: {} });
      return Response.json({ result: { data: { json: { userId: 'fixture-user', isSuperUser: false } } } });
    });
    const run = (argv: string[], context: CliContext = ctx) => runCommand(parseCliArgs(argv), context);
    expect(await run(['login', '--origin', frontend, '--url-only'])).toBe(0);
    const started = JSON.parse(out.at(-1)!);
    expect(started.origin).toBe(backendOrigin);
    expect(started.frontendOrigin).toBe(frontend);
    expect(new URL(started.authorizeUrl).origin).toBe(backendOrigin);
    expect(new URL(started.authorizeUrl).searchParams.get('redirect_uri')).toBe(`${backendOrigin}/oauth/cli-finish`);
    expect(await pending.get(frontend)).toBeNull();
    expect(await pending.get(backendOrigin)).not.toBeNull();
    expect((await pending.get(backendOrigin))?.frontendOrigin).toBe(frontend);
    expect(await run(['login', '--origin', completionOrigin, '--complete'], { ...ctx, stdin: `synthetic-code ${started.state}` })).toBe(0);
    expect(await tokens.get(frontend)).toBeNull();
    expect((await tokens.list())).toHaveLength(1);
    expect((await tokens.get(backendOrigin))?.frontendOrigin).toBe(frontend);
    expect(await tokens.get(backendOrigin)).not.toHaveProperty('id_token');
    expect((await tokens.get(backendOrigin))?.revocationEndpoint).toBe(`${backendOrigin}/api/auth/oauth2/revoke`);
    // Existing backend-only sessions gain display metadata only after verified connect.
    const connected = (await tokens.get(backendOrigin))!;
    delete connected.frontendOrigin;
    await tokens.put(connected);
    expect(await run(['login', '--origin', frontend, '--url-only'])).toBe(0);
    expect((await tokens.get(backendOrigin))?.frontendOrigin).toBe(frontend);
    for (const origin of [frontend, backendOrigin]) {
      expect(await run(['status', '--origin', origin, '--json'])).toBe(0);
      expect(JSON.parse(out.at(-1)!).sessions).toEqual([{ origin: backendOrigin, frontendOrigin: frontend, email: null, accessTokenValid: true }]);
      expect(await run(['call', '--origin', origin, INITIAL_V2_PROCEDURE, '{}'])).toBe(0);
      expect(JSON.parse(out.at(-1)!)).toEqual({ userId: 'fixture-user', isSuperUser: false });
      const count = requests.filter(r => r.method === 'POST').length;
      expect(await run(['login', '--origin', origin, '--url-only'])).toBe(0);
      expect(JSON.parse(out.at(-1)!).connected).toBe(true);
      expect(requests.filter(r => r.method === 'POST')).toHaveLength(count);
    }
    expect(await run(['status', '--json'])).toBe(0);
    expect(JSON.parse(out.at(-1)!).sessions[0].frontendOrigin).toBe(frontend);
    expect(await run(['status'])).toBe(0);
    expect(out.at(-1)).toContain(`connected to ${frontend} (backend ${backendOrigin})`);
    const stored = (await tokens.get(backendOrigin))!;
    await tokens.put({ ...stored, expires_at: 0 });
    expect(await run(['call', '--origin', frontend, INITIAL_V2_PROCEDURE, '{}'])).toBe(0);
    expect((await tokens.get(backendOrigin))?.frontendOrigin).toBe(frontend);
    expect((await tokens.get(backendOrigin))?.revocationEndpoint).toBe(`${backendOrigin}/api/auth/oauth2/revoke`);
    expect(await tokens.get(backendOrigin)).not.toHaveProperty('id_token');
    expect(await run(['logout', '--origin', frontend])).toBe(0);
    expect(requests.some(r => r.url === `${backendOrigin}/api/auth/oauth2/revoke` && r.method === 'POST')).toBe(true);
    expect(await tokens.list()).toEqual([]);
    await tokens.put(stored);
    expect(await run(['logout', '--origin', backendOrigin])).toBe(0);
    expect(await tokens.list()).toEqual([]);
    expect(await pending.get(backendOrigin)).toBeNull();
    expect(err).toEqual([]);
    const text = out.join('\n');
    expect(text).not.toContain('fixture-access');
    expect(text).not.toContain('fixture-refresh');
    expect(text).not.toContain('synthetic-code');
  });
  test('unverified pointer prevents OAuth and session access', async () => {
    const { ctx, err } = makeContext();
    setFetchForTests(async url => String(url).endsWith(FRONTEND_POINTER_PATH)
      ? Response.json({ product: 'embrace-v2', kind: 'frontend-pointer', version: 1, instance: { id: 'fixture-instance' }, backendOrigin: `${backendOrigin}/path` })
      : new Response(null, { status: 404 }));
    for (const command of ['login', 'call', 'status']) {
      const argv = [command, '--origin', frontend, ...(command === 'login' ? ['--url-only'] : command === 'call' ? [INITIAL_V2_PROCEDURE, '{}'] : [])];
      expect(await runCommand(parseCliArgs(argv), { ...ctx, tokenStore: { get: async () => { throw new Error('Unexpected session access'); }, list: async () => [], put: async () => {}, remove: async () => true } })).toBe(1);
    }
    expect(err.every(text => text.includes('Could not verify the Embrace connection document'))).toBe(true);
  });
});


describe('discovery-independent confirmed logout', () => {
  const backend = 'https://backend.example.test', frontend = 'https://frontend.example.test';
  const endpoint = `${backend}/api/auth/oauth2/revoke`;
  async function setup() {
    const context = makeContext();
    await context.tokens.put({ origin: backend, frontendOrigin: frontend, revocationEndpoint: endpoint,
      email: null, access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_at: 0 });
    return context;
  }
  test('discovery entirely down cannot prevent revocation, for either URL', async () => {
    for (const origin of [frontend, backend]) {
      const { ctx, out, tokens } = await setup();
      const requests: string[] = [];
      setFetchForTests(async (url, init) => {
        requests.push(String(url));
        if (String(url) !== endpoint) throw new DOMException('private-discovery-down', 'TimeoutError');
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('manual');
        expect(init?.credentials).toBe('omit');
        return new Response(null, { status: 200 });
      });
      expect(await runCommand(parseCliArgs(['logout', '--origin', origin]), ctx)).toBe(0);
      expect(requests).toEqual([endpoint]);
      expect(JSON.parse(out[0]!)).toEqual({ origin: backend, signedOut: true });
      expect(await tokens.list()).toEqual([]);
    }
  });
  for (const failure of ['timeout', '503']) test(`${failure} retries once then confirms; no discovery request`, async () => {
    const { ctx, tokens } = await setup();
    let count = 0;
    setFetchForTests(async url => {
      expect(String(url)).toBe(endpoint);
      if (++count === 1) {
        if (failure === 'timeout') throw new DOMException('private', 'TimeoutError');
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 200 });
    });
    expect(await runCommand(parseCliArgs(['logout', '--origin', frontend]), ctx)).toBe(0);
    expect(count).toBe(2);
    expect(await tokens.list()).toEqual([]);
  });
  for (const failure of ['timeout', '503', 'network', 'invalid_token', 'invalid_client', 'redirect']) {
    test(`unconfirmed ${failure} retains session, bounded attempts, no false sign-out`, async () => {
      const { ctx, tokens, out, err } = await setup();
      let count = 0;
      setFetchForTests(async url => {
        expect(String(url)).toBe(endpoint);
        count++;
        if (failure === 'timeout') throw new DOMException('private', 'TimeoutError');
        if (failure === 'network') throw new TypeError('private');
        if (failure === '503') return new Response(null, { status: 503 });
        if (failure === 'redirect') return new Response(null, { status: 302, headers: { Location: frontend } });
        return Response.json({ error: failure, error_description: 'private' }, { status: 400 });
      });
      expect(await runCommand(parseCliArgs(['logout', '--origin', frontend]), ctx)).toBe(1);
      expect(count).toBe(failure === 'timeout' || failure === '503' ? 2 : 1);
      expect(out).toEqual([]);
      expect(err.join()).toContain('logout not confirmed, retry; session kept');
      expect(err.join()).not.toContain('private');
      expect(await tokens.get(backend)).not.toBeNull();
    });
  }
  test('RFC 7009 200 for an already-invalid token confirms logout without parsing a body', async () => {
    const { ctx, tokens } = await setup();
    setFetchForTests(async () => new Response(null, { status: 200 }));
    expect(await runCommand(parseCliArgs(['logout', '--origin', backend]), ctx)).toBe(0);
    expect(await tokens.list()).toEqual([]);
  });
  test('missing refresh token cannot claim confirmed logout', async () => {
    const { ctx, tokens, out } = await setup();
    await tokens.put({ ...(await tokens.get(backend))!, refresh_token: '' });
    let count = 0;
    setFetchForTests(async () => { count++; return new Response(null, { status: 200 }); });
    expect(await runCommand(parseCliArgs(['logout', '--origin', backend]), ctx)).toBe(1);
    expect(count).toBe(0);
    expect(out).toEqual([]);
    expect(await tokens.get(backend)).not.toBeNull();
  });
  test('ambiguous saved frontend cannot select a credential destination', async () => {
    const { ctx, tokens } = await setup();
    await tokens.put({ ...(await tokens.get(backend))!, origin: 'https://other.example.test', revocationEndpoint: 'https://other.example.test/api/auth/oauth2/revoke' });
    let count = 0;
    setFetchForTests(async () => { count++; return new Response(null, { status: 200 }); });
    expect(await runCommand(parseCliArgs(['logout', '--origin', frontend]), ctx)).toBe(1);
    expect(count).toBe(0);
    expect(await tokens.list()).toHaveLength(2);
  });
  test('legacy session derives only its canonical issuer endpoint, without discovery migration', async () => {
    const { ctx, tokens } = await setup();
    const token = (await tokens.get(backend))!;
    delete token.revocationEndpoint;
    await tokens.put(token);
    setFetchForTests(async url => { expect(String(url)).toBe(endpoint); return new Response(null, { status: 200 }); });
    expect(await runCommand(parseCliArgs(['logout', '--origin', frontend]), ctx)).toBe(0);
    expect(await tokens.list()).toEqual([]);
  });
  test('stored foreign endpoint cannot receive a token; session retained', async () => {
    const { ctx, tokens } = await setup();
    await tokens.put({ ...(await tokens.get(backend))!, revocationEndpoint: `${frontend}/api/auth/oauth2/revoke` });
    let count = 0;
    setFetchForTests(async () => { count++; return new Response(null, { status: 200 }); });
    expect(await runCommand(parseCliArgs(['logout', '--origin', frontend]), ctx)).toBe(1);
    expect(count).toBe(0);
    expect(await tokens.get(backend)).not.toBeNull();
  });
});

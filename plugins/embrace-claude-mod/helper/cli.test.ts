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
    expect(JSON.parse(out[0]!)).toEqual({ origin: ORIGIN, signedOut: true });
    expect(await tokens.get(ORIGIN)).toBeNull();
  });
});

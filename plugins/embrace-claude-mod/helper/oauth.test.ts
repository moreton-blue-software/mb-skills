// OAuth URL construction, pasted-code parsing, state verification and grant
// mapping — all pure, no network.

import { afterEach, describe, expect, test } from 'bun:test';
import { setFetchForTests } from './fetch';
import {
  buildAuthorizeUrl,
  exchangeCode,
  decodeJwtClaims,
  normalizeOrigin,
  parsePastedCode,
  toStoredToken,
  verifyState,
} from './oauth';

const ORIGIN = 'https://rev2933.example.embraceapp.dev';

function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.not-a-real-signature`;
}

describe('normalizeOrigin', () => {
  test('adds https and strips paths', () => {
    expect(normalizeOrigin('rev2933.example.embraceapp.dev')).toBe(ORIGIN);
    expect(normalizeOrigin(`${ORIGIN}/some/path?x=1`)).toBe(ORIGIN);
    expect(normalizeOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });

  test('rejects non-http schemes', () => {
    expect(() => normalizeOrigin('ftp://example.com')).toThrow(/http/);
  });
});

describe('buildAuthorizeUrl', () => {
  const url = new URL(buildAuthorizeUrl(ORIGIN, 'CHALLENGE', 'STATE'));

  test('targets the authorize endpoint', () => {
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}/api/auth/oauth2/authorize`);
  });

  test('carries every PKCE/OIDC parameter of the proven flow', () => {
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('claude-embrace-cli');
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/oauth/cli-finish`);
    expect(url.searchParams.get('scope')).toBe('openid email profile offline_access');
    expect(url.searchParams.get('resource')).toBe(`${ORIGIN}/api/auth`);
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('STATE');
  });
});

describe('parsePastedCode', () => {
  test('bare code', () => {
    expect(parsePastedCode('  abc123  ')).toEqual({ code: 'abc123' });
  });

  test('code and state', () => {
    expect(parsePastedCode('abc123 fedcba')).toEqual({ code: 'abc123', state: 'fedcba' });
  });

  test('pasted redirect URL', () => {
    expect(parsePastedCode(`${ORIGIN}/oauth/cli-finish?code=abc123&state=fedcba`)).toEqual({
      code: 'abc123',
      state: 'fedcba',
    });
  });

  test('pasted query string', () => {
    expect(parsePastedCode('code=abc123&state=fedcba')).toEqual({ code: 'abc123', state: 'fedcba' });
  });

  test('empty input is refused', () => {
    expect(() => parsePastedCode('   ')).toThrow(/no code/);
  });
});

describe('verifyState', () => {
  test('accepts matching state', () => {
    expect(() => verifyState({ state: 's1' }, 's1')).not.toThrow();
  });

  test('accepts absent state', () => {
    expect(() => verifyState({ state: 's1' }, undefined)).not.toThrow();
  });

  test('refuses mismatched state', () => {
    expect(() => verifyState({ state: 's1' }, 's2')).toThrow(/state mismatch/);
  });
});

describe('decodeJwtClaims', () => {
  test('decodes payload without verifying', () => {
    expect(decodeJwtClaims(fakeJwt({ email: 'dev@mb.test', exp: 1893456000 }))).toMatchObject({
      email: 'dev@mb.test',
      exp: 1893456000,
    });
  });

  test('returns null for non-JWT', () => {
    expect(decodeJwtClaims('not-a-jwt')).toBeNull();
    expect(decodeJwtClaims(undefined)).toBeNull();
  });
});

describe('toStoredToken', () => {
  test('prefers expires_at, then JWT exp, then expires_in', () => {
    const now = 1_700_000_000_000;
    const claimsJwt = fakeJwt({ email: 'a@mb.test', exp: 1893456000 });
    expect(toStoredToken(ORIGIN, { access_token: claimsJwt, expires_at: 1893460000 }, { now: () => now }).expires_at)
      .toBe(1893460000 * 1000);
    expect(toStoredToken(ORIGIN, { access_token: claimsJwt }, { now: () => now }).expires_at).toBe(1893456000 * 1000);
    expect(toStoredToken(ORIGIN, { access_token: 'opaque', expires_in: 60 }, { now: () => now }).expires_at)
      .toBe(now + 60 * 1000);
  });

  test('email precedence: id_token, then access token, then previous', () => {
    const idOnly = fakeJwt({ email: 'id@mb.test' });
    const accessOnly = fakeJwt({ email: 'access@mb.test' });
    expect(toStoredToken(ORIGIN, { access_token: accessOnly, id_token: idOnly }).email).toBe('id@mb.test');
    expect(toStoredToken(ORIGIN, { access_token: accessOnly }).email).toBe('access@mb.test');
    expect(toStoredToken(ORIGIN, { access_token: 'opaque' }, { previousEmail: 'prev@mb.test' }).email).toBe('prev@mb.test');
    expect(toStoredToken(ORIGIN, { access_token: 'opaque' }).email).toBeNull();
  });
});


afterEach(() => setFetchForTests());

describe('safe token endpoint diagnostics', () => {
  test('reports known resource errors without losing the description', async () => {
    setFetchForTests(async () => Response.json({ error: 'invalid_request', error_description: 'requested resource invalid' }, { status: 400 }));
    await expect(exchangeCode(ORIGIN, 'dummy-code', 'dummy-verifier')).rejects.toThrow('invalid_request: requested resource invalid');
  });

  test('does not expose arbitrary provider descriptions that echo a code', async () => {
    setFetchForTests(async () => Response.json({ error: 'invalid_request', error_description: 'code DUMMY-SEED-SECRET was invalid' }, { status: 400 }));
    let message = '';
    try { await exchangeCode(ORIGIN, 'DUMMY-SEED-SECRET', 'dummy-verifier'); } catch (error) { message = String(error); }
    expect(message).toContain('invalid_request');
    expect(message).not.toContain('DUMMY-SEED-SECRET');
  });
});

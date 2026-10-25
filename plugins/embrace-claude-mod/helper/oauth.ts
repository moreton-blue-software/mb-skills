// OAuth2/OIDC protocol for the Embrace CLI public client (PKCE S256, secretless).
// Mirrors the proven implementation in core-v3 scripts/e2e/oidc-cli-login.local-e2e.ts
// and the server contract of @better-auth/oauth-provider:
//   issuer                 = {origin}/api/auth
//   authorize              = POST-redirect GET {issuer}/oauth2/authorize (manual browser navigation)
//   token (code + refresh) = POST {issuer}/oauth2/token, application/x-www-form-urlencoded
//   revoke                 = POST {origin}/api/auth/oauth2/revoke (RFC 7009)
// The `resource` parameter MUST be sent on both the code exchange and the
// refresh grant: the server only mints a JWT access token (audience = issuer)
// when a resource/audience is requested, and the tRPC bearer gate requires it.
// Never logs or returns tokens in errors.
// Usage: see cli.ts (`login`, `logout` subcommands).

import { httpFetch } from './fetch';

export const CLIENT_ID = 'claude-embrace-cli';
export const SCOPES = 'openid email profile offline_access';
const REQUEST_TIMEOUT_MS = 30_000;

export function issuerOf(origin: string): string {
  return `${origin}/api/auth`;
}

export function redirectUriOf(origin: string): string {
  return `${origin}/oauth/cli-finish`;
}

/** Normalize an origin input to `scheme://host[:port]`; accepts scheme-less hosts. */
export function normalizeOrigin(input: string): string {
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input) ? input : `https://${input}`;
  const url = new URL(candidate);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('origin must be an http(s) URL');
  }
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.origin;
}

/** The authorize URL the human opens in any browser (contains only public PKCE material). */
export function buildAuthorizeUrl(origin: string, codeChallenge: string, state: string): string {
  const authorize = new URL(`${issuerOf(origin)}/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUriOf(origin),
    scope: SCOPES,
    resource: issuerOf(origin),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  return authorize.toString();
}

/** A successful token-endpoint response (either grant). */
export interface TokenGrant {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  /** Epoch seconds, when the server states it. */
  expires_at?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

/** Decoded (NOT verified — the server verifies; we only read claims) JWT payload. */
export function decodeJwtClaims(jwt: string | undefined): Record<string, unknown> | null {
  if (!jwt) return null;
  const segments = jwt.split('.');
  if (segments.length !== 3) return null;
  try {
    const base64 = segments[1]!.replaceAll('-', '+').replaceAll('_', '/');
    const json = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function postForm(url: string, params: Record<string, string>): Promise<TokenGrant> {
  const response = await httpFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Only known fixed diagnostics escape; provider text may echo secrets.
    const code = await oauthErrorOf(response);
    throw new Error(`token endpoint responded ${response.status}${code ? ` (${code})` : ''}`);
  }
  const grant = (await response.json()) as TokenGrant;
  if (!grant?.access_token) throw new Error('token endpoint response missing access_token');
  return grant;
}

async function oauthErrorOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown; error_description?: unknown };
    const code = typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : null;
    const descriptions = new Set(['requested resource invalid', 'code verification failed', 'invalid redirect uri', 'pkce is required for public clients']);
    const description = typeof body.error_description === 'string' && descriptions.has(body.error_description)
      ? body.error_description : null;
    if (code && description) return `${code}: ${description}`;
    return code;
  } catch {
    return null;
  }
}

/** Exchange the one-time paste code for tokens (secretless PKCE public client). */
export function exchangeCode(origin: string, code: string, codeVerifier: string): Promise<TokenGrant> {
  return postForm(`${issuerOf(origin)}/oauth2/token`, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUriOf(origin),
    code_verifier: codeVerifier,
    client_id: CLIENT_ID,
    resource: issuerOf(origin),
  });
}

/** Refresh the access token; the server rotates the refresh token in the response. */
export function refreshGrant(origin: string, refreshToken: string): Promise<TokenGrant> {
  return postForm(`${issuerOf(origin)}/oauth2/token`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    resource: issuerOf(origin),
  });
}

/** Revoke a refresh token (RFC 7009). Server returns 200 with an empty body. */
export async function revokeToken(origin: string, refreshToken: string): Promise<void> {
  const response = await httpFetch(`${issuerOf(origin)}/oauth2/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      token: refreshToken,
      token_type_hint: 'refresh_token',
    }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const code = await oauthErrorOf(response);
    throw new Error(`revoke endpoint responded ${response.status}${code ? ` (${code})` : ''}`);
  }
}

/** Parse the pasted finish-page payload: a bare code, "code state", or a pasted URL/query. */
export function parsePastedCode(pasted: string): { code: string; state?: string } {
  const text = pasted.trim();
  if (!text) throw new Error('no code provided');
  if (text.includes('://') || /^code=/.test(text)) {
    const url = new URL(text.includes('://') ? text : `http://localhost/?${text}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (code) return state ? { code, state } : { code };
  }
  const [code, state] = text.split(/\s+/);
  if (!code) throw new Error('no code provided');
  return state ? { code, state } : { code };
}

/** Verify a pasted state against the pending login's state, when one was provided. */
export function verifyState(pending: { state: string }, pasted: string | undefined): void {
  if (pasted !== undefined && pasted !== pending.state) {
    throw new Error('state mismatch: the pasted code belongs to a different login attempt');
  }
}

/** Build the stored token entry from a token grant. Pure; email/expiry only, no verification. */
export function toStoredToken(
  origin: string,
  grant: TokenGrant,
  options: { previousEmail?: string | null; now?: () => number } = {},
): StoredTokenLike {
  const now = options.now ?? Date.now;
  const idClaims = decodeJwtClaims(grant.id_token);
  const accessClaims = decodeJwtClaims(grant.access_token);
  const email = stringClaim(idClaims, 'email') ?? stringClaim(accessClaims, 'email') ?? options.previousEmail ?? null;
  const expiresAtSeconds =
    numberClaim(grant, 'expires_at')
    ?? numberClaim(accessClaims, 'exp')
    ?? now() / 1000 + (numberClaim(grant, 'expires_in') ?? 3600);
  return {
    origin,
    email,
    access_token: grant.access_token!,
    refresh_token: typeof grant.refresh_token === 'string' ? grant.refresh_token : '',
    expires_at: Math.round(expiresAtSeconds * 1000),
  };
}

/** The stored-token shape (re-exported so cli.ts has one import point). */
export interface StoredTokenLike {
  origin: string;
  email: string | null;
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

function stringClaim(claims: Record<string, unknown> | null, key: string): string | null {
  const value = claims?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberClaim(record: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

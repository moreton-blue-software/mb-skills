// Public backend capabilities only. Fetch fresh; never persist connection metadata
// or send a session, cookie, or bearer token to this endpoint.
import { httpFetch } from './fetch';

export const CONNECTION_PATH = '/api/auth/.well-known/embrace-connection';
export const CONNECTION_ERROR = 'Could not verify the Embrace connection document; refusing backend fallback.';
export const INITIAL_V2_PROCEDURE = 'core.auth.getUserSession';

export type Backend = { product: 'embrace-v3' } | {
  product: 'embrace-v2';
  baseUrl: string;
  procedureDiscovery: false;
  initialAllowedProcedure?: typeof INITIAL_V2_PROCEDURE;
};

export const V3_BACKEND: Backend = { product: 'embrace-v3' };

export async function detectBackend(origin: string): Promise<Backend> {
  try {
    const endpoint = `${origin}${CONNECTION_PATH}`;
    const response = await httpFetch(endpoint, {
      method: 'GET', redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.redirected || (response.url && response.url !== endpoint)) throw new Error();
    // Absence alone preserves the existing v3 contract. Never infer from an
    // error body, inaccessible document, or an unrecognized product.
    if (response.status === 404) return V3_BACKEND;
    if (response.status !== 200) throw new Error();
    const document = await response.json();
    if (!document || typeof document !== 'object' || Array.isArray(document)
      || document.product !== 'embrace-v2'
      || typeof document.instance?.id !== 'string' || !document.instance.id.trim()
      || document.issuer !== `${origin}/api/auth`
      || document.api?.transport !== 'trpc'
      || document.api.procedureDiscovery !== false
      || typeof document.api.baseUrl !== 'string'
      || (document.api.initialAllowedProcedure !== undefined && document.api.initialAllowedProcedure !== INITIAL_V2_PROCEDURE)
      || !['app-origin', 'review-split-origin'].includes(document.approvalMode)) throw new Error();
    const base = new URL(document.api.baseUrl);
    if (base.origin !== origin || base.username || base.password || base.search || base.hash) throw new Error();
    return {
      product: 'embrace-v2', baseUrl: base.href.replace(/\/$/, ''), procedureDiscovery: false,
      ...(document.api.initialAllowedProcedure ? { initialAllowedProcedure: INITIAL_V2_PROCEDURE } : {}),
    };
  } catch {
    // Neither server-controlled bodies nor fetch errors belong in CLI output.
    throw new Error(CONNECTION_ERROR);
  }
}

export function unavailableDiscovery(backend: Extract<Backend, { product: 'embrace-v2' }>): string {
  return `Procedure discovery and describe are unavailable on this v2 backend. ${backend.initialAllowedProcedure
    ? `Initial allowed procedure: ${backend.initialAllowedProcedure}.`
    : 'No initial allowed procedure is advertised.'} Use a verified operator-supplied query/input contract; do not guess procedures.`;
}

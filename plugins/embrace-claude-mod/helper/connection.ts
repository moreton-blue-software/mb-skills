// Public backend capabilities only. Fetch fresh; never persist connection metadata
// or send a session, cookie, or bearer token to these endpoints.
import { httpFetch, BACKEND_TIMEOUT_MS, BackendUnavailableError, availabilityError } from './fetch';

export const CONNECTION_PATH = '/api/auth/.well-known/embrace-connection';
export const FRONTEND_POINTER_PATH = '/.well-known/embrace-connection.json';
export const CONNECTION_ERROR = 'Could not verify the Embrace connection document; refusing backend fallback.';
export const INITIAL_V2_PROCEDURE = 'core.auth.getUserSession';

export type Backend = { product: 'embrace-v3' } | {
  product: 'embrace-v2';
  baseUrl: string;
  procedureDiscovery: false;
  initialAllowedProcedure?: typeof INITIAL_V2_PROCEDURE;
};
export interface Connection {
  /** Canonical origin for OAuth, API access and session custody. */
  origin: string;
  backend: Backend;
  /** Display only; never a routing authority or cached pointer. */
  frontendOrigin?: string;
}

export const V3_BACKEND: Backend = { product: 'embrace-v3' };

async function publicDocument(endpoint: string): Promise<unknown | undefined> {
  let unavailable: BackendUnavailableError | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const signal = AbortSignal.timeout(BACKEND_TIMEOUT_MS);
    let response: Response;
    try {
      response = await httpFetch(endpoint, {
        method: 'GET', redirect: 'manual', credentials: 'omit', signal,
      });
    } catch (error) {
      unavailable = availabilityError(error, signal);
      if (attempt === 0) continue;
      throw unavailable;
    }
    // Manual redirect handling distinguishes a redirect denial from a network
    // failure without following it or sending any credentials.
    if (response.redirected || (response.url && response.url !== endpoint)) throw new Error();
    if (response.status >= 500) {
      unavailable = new BackendUnavailableError('server');
      if (attempt === 0) continue;
      throw unavailable;
    }
    if (response.status === 404) {
      // An unavailable attempt followed by absence is not verified legacy v3.
      if (unavailable) throw unavailable;
      return undefined;
    }
    if (response.status !== 200) throw new Error();
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw error;
      unavailable = availabilityError(error, signal);
      if (attempt === 0) continue;
      throw unavailable;
    }
  }
  throw new BackendUnavailableError('network');
}

function v2Document(value: unknown, origin: string) {
  const document = value as {
    product?: unknown; instance?: { id?: unknown }; issuer?: unknown;
    api?: { transport?: unknown; procedureDiscovery?: unknown; baseUrl?: unknown; initialAllowedProcedure?: unknown };
    approvalMode?: unknown; frontendOrigins?: unknown;
  } | null;
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || document.product !== 'embrace-v2'
    || typeof document.instance?.id !== 'string' || !document.instance.id.trim()
    || document.issuer !== `${origin}/api/auth`
    || document.api?.transport !== 'trpc'
    || document.api.procedureDiscovery !== false
    || typeof document.api.baseUrl !== 'string'
    || (document.api.initialAllowedProcedure !== undefined && document.api.initialAllowedProcedure !== INITIAL_V2_PROCEDURE)
    || (document.approvalMode !== 'app-origin' && document.approvalMode !== 'review-split-origin')) throw new Error();
  const base = new URL(document.api.baseUrl);
  if (base.origin !== origin || base.username || base.password || base.search || base.hash) throw new Error();
  const backend: Backend = {
    product: 'embrace-v2', baseUrl: base.href.replace(/\/$/, ''), procedureDiscovery: false,
    ...(document.api.initialAllowedProcedure ? { initialAllowedProcedure: INITIAL_V2_PROCEDURE } : {}),
  };
  return { backend, instanceId: document.instance.id as string, approvalMode: document.approvalMode as string, frontendOrigins: document.frontendOrigins as unknown };
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Resolve one static frontend pointer only after both directions are verified. */
export async function resolveConnection(origin: string): Promise<Connection> {
  let original: Connection | undefined;
  try {
    const document = await publicDocument(`${origin}${CONNECTION_PATH}`);
    if (document !== undefined) return { origin, backend: v2Document(document, origin).backend };
    original = { origin, backend: V3_BACKEND };
  } catch (error) {
    if (error instanceof BackendUnavailableError) throw error;
    // Preserve this failure if the frontend has no pointer (including HTML/SPAs).
  }
  try {
    const pointer = await publicDocument(`${origin}${FRONTEND_POINTER_PATH}`);
    if (pointer === undefined) {
      if (original) return original;
      throw new Error();
    }
    if (!exactKeys(pointer, ['product', 'kind', 'version', 'instance', 'backendOrigin'])
      || pointer.product !== 'embrace-v2' || pointer.kind !== 'frontend-pointer' || pointer.version !== 1
      || !exactKeys(pointer.instance, ['id']) || typeof pointer.instance.id !== 'string' || !pointer.instance.id.trim()
      || typeof pointer.backendOrigin !== 'string') throw new Error();
    const target = new URL(pointer.backendOrigin);
    // An origin string, not an arbitrary URL: reject even a trailing slash.
    if (target.protocol !== 'https:' || target.origin !== pointer.backendOrigin || target.origin === origin) throw new Error();
    const document = v2Document(await publicDocument(`${target.origin}${CONNECTION_PATH}`), target.origin);
    if (document.approvalMode !== 'review-split-origin' || document.instanceId !== pointer.instance.id
      || !Array.isArray(document.frontendOrigins) || !document.frontendOrigins.includes(origin)) throw new Error();
    return { origin: target.origin, backend: document.backend, frontendOrigin: origin };
  } catch (error) {
    if (error instanceof BackendUnavailableError) throw error;
    // Neither server-controlled bodies nor fetch errors belong in CLI output.
    throw new Error(CONNECTION_ERROR);
  }
}

export async function detectBackend(origin: string): Promise<Backend> {
  return (await resolveConnection(origin)).backend;
}

export function unavailableDiscovery(backend: Extract<Backend, { product: 'embrace-v2' }>): string {
  return `Procedure discovery and describe are unavailable on this v2 backend. ${backend.initialAllowedProcedure
    ? `Initial allowed procedure: ${backend.initialAllowedProcedure}.`
    : 'No initial allowed procedure is advertised.'} Use a verified operator-supplied query/input contract; do not guess procedures.`;
}

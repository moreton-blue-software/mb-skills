// Query-only tRPC transport: GET with a superjson input envelope and Bearer auth.
// The server rejects mutations over GET; never retry with POST.
// Usage: see cli.ts (`call` subcommand); fake-origin tests in trpc.test.ts.

import { httpFetch } from './fetch';
import { deserializeEnvelope, serializeInput } from './superjson-lite';

const REQUEST_TIMEOUT_MS = 30_000;

export interface TrpcCallResult {
  ok: boolean;
  httpStatus: number;
  /** tRPC error code (UNAUTHORIZED, FORBIDDEN, ...) when the call failed. */
  errorCode?: string;
  /** Deserialized procedure output when the call succeeded. */
  data?: unknown;
}

/** Validate a dotted v3 procedure name (for example `v3.agent.listThreads`). */
export function assertProcedureName(procedure: string): void {
  if (!/^v3\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/.test(procedure)) {
    throw new Error('procedure must look like v3.<module>.<name>');
  }
}

export async function callProcedure(args: {
  origin: string;
  procedure: string;
  input?: unknown;
  accessToken: string;
}): Promise<TrpcCallResult> {
  assertProcedureName(args.procedure);
  const envelope = JSON.stringify(serializeInput(args.input));
  const url = `${args.origin}/trpc/${args.procedure}?input=${encodeURIComponent(envelope)}`;
  const response = await httpFetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${args.accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, httpStatus: response.status, errorCode: `HTTP_${response.status}` };
  }
  const record = (payload ?? {}) as {
    result?: { data?: unknown };
    error?: { json?: { data?: { code?: unknown } } };
  };
  if (record.error) {
    const code = record.error.json?.data?.code;
    return {
      ok: false,
      httpStatus: response.status,
      errorCode: typeof code === 'string' ? code : `HTTP_${response.status}`,
    };
  }
  if (!response.ok) return { ok: false, httpStatus: response.status, errorCode: `HTTP_${response.status}` };
  return { ok: true, httpStatus: response.status, data: deserializeEnvelope(record.result?.data) };
}

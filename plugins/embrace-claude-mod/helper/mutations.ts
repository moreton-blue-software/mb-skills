// Execute reviewed non-delete mutations through Core's fixed gateway only.
// Usage: cli.ts mutate --origin <url> --request-id <uuid> <name> [input-json].
import { DESCRIBE_MUTATION, EXECUTE_MUTATION } from './discovery';
import { httpFetch } from './fetch';
import { assertProcedureName, callProcedure } from './trpc';
import { deserializeEnvelope, serializeInput } from './superjson-lite';

interface Deployment {
  commitSha: string;
  deployedAt: string;
}

interface MutationError {
  error: string;
  requestId: string;
  outcome: 'not-dispatched' | 'unknown';
  hint?: string;
}

type MutationResult = { ok: true; data: unknown } | { ok: false; error: MutationError };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function assertRequestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('mutate requires --request-id <uuid>; retain the same ID for this exact logical write');
  }
}

function deploymentOf(value: unknown): Deployment | null {
  if (!record(value) || typeof value.commitSha !== 'string' || !/^[0-9a-f]{40}$/i.test(value.commitSha)
    || typeof value.deployedAt !== 'string' || value.deployedAt === 'unknown'
    || !Number.isFinite(Date.parse(value.deployedAt))) return null;
  return { commitSha: value.commitSha, deployedAt: value.deployedAt };
}

function supportedContract(value: unknown, direction: 'input' | 'output'): boolean {
  if (!record(value)) return false;
  if (value.status === 'none') return true;
  return value.status === 'supported' && value.fidelity === 'structural'
    && record(value.schema) && Object.keys(value.schema).length > 0
    && (direction !== 'input' || value.presence === 'required' || value.presence === 'optional');
}

export async function executeReviewedMutation(args: {
  origin: string;
  procedure: string;
  requestId: string;
  input?: unknown;
  accessToken: string;
}): Promise<MutationResult> {
  assertRequestId(args.requestId);
  assertProcedureName(args.procedure);
  const rejected = (error: string): MutationResult => ({ ok: false, error: {
    error, requestId: args.requestId, outcome: 'not-dispatched',
  } });
  const uncertain = (error: string): MutationResult => ({ ok: false, error: {
    error, requestId: args.requestId, outcome: 'unknown',
    hint: 'Do not send a new request ID or blindly retry. Reconcile this exact request ID and payload; the write may already have succeeded.',
  } });

  let described;
  try {
    described = await callProcedure({ origin: args.origin, procedure: DESCRIBE_MUTATION,
      input: { name: args.procedure }, accessToken: args.accessToken });
  } catch {
    return rejected('Mutation contract could not be reached; no mutation was dispatched');
  }
  if (!described.ok) return rejected(`Mutation contract unavailable (${described.errorCode ?? described.httpStatus}); no mutation was dispatched`);
  const metadata = described.data;
  if (!record(metadata) || metadata.name !== args.procedure || metadata.type !== 'mutation') {
    return rejected('Mutation contract is malformed or does not match the requested operation');
  }
  const deployment = deploymentOf(metadata.deployment);
  if (!deployment) return rejected('Mutation contract has no verified deployment provenance');
  if (!supportedContract(metadata.input, 'input') || !supportedContract(metadata.output, 'output')) {
    return rejected('Mutation input or output contract is unsupported; no mutation was dispatched');
  }
  const inputContract = metadata.input;
  if (record(inputContract) && inputContract.status === 'none' && args.input !== undefined) {
    return rejected('Mutation contract accepts no input; omit the JSON argument');
  }
  if (record(inputContract) && inputContract.presence === 'required' && args.input === undefined) {
    return rejected('Mutation contract requires input; supply the documented JSON argument');
  }

  // Omitted input must stay omitted, not become null or an undefined child that
  // the deliberately plain-JSON request serializer cannot encode.
  let body: string;
  try {
    body = JSON.stringify(serializeInput({ name: args.procedure,
      ...(args.input === undefined ? {} : { input: args.input }),
      requestId: args.requestId, expectedDeployment: deployment }));
  } catch {
    return rejected('Mutation input must be plain JSON; no mutation was dispatched');
  }
  // The named business mutation is never sent directly. Core rechecks eligibility,
  // current permissions, deployment provenance and the request's replay identity.
  try {
    const response = await httpFetch(`${args.origin}/trpc/${EXECUTE_MUTATION}`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${args.accessToken}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    let payload: unknown;
    try { payload = await response.json(); } catch { return uncertain('Mutation gateway returned an unreadable response'); }
    if (!record(payload)) return uncertain('Mutation gateway returned a malformed response');
    if (!response.ok || payload.error) {
      const error = record(payload.error) && record(payload.error.json) && record(payload.error.json.data)
        ? payload.error.json.data.code : undefined;
      const code = typeof error === 'string' && /^[A-Z_]{1,64}$/.test(error) ? error : `HTTP_${response.status}`;
      return uncertain(`Mutation gateway did not report success (${code})`);
    }
    const result = record(payload.result) ? deserializeEnvelope(payload.result.data) : undefined;
    if (!record(result) || result.name !== args.procedure || result.requestId !== args.requestId
      || typeof result.replayed !== 'boolean') {
      return uncertain('Mutation gateway receipt does not match this request');
    }
    if (result.status === 'unresolved' && result.replayed === true) {
      return uncertain('Mutation outcome is unresolved; do not redispatch with a new request ID');
    }
    if (result.status !== 'succeeded' || !Object.hasOwn(result, 'data')) {
      return uncertain('Mutation gateway did not return a supported outcome with result data');
    }
    const executedDeployment = deploymentOf(result.deployment);
    if (!executedDeployment || executedDeployment.commitSha !== deployment.commitSha
      || executedDeployment.deployedAt !== deployment.deployedAt) {
      return uncertain('Mutation gateway receipt has different deployment provenance');
    }
    return { ok: true, data: result };
  } catch {
    return uncertain('Mutation gateway connection failed after dispatch');
  }
}

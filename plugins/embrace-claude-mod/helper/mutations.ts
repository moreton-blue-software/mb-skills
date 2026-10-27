// Execute a discovered non-delete mutation through its existing tRPC endpoint.
// Usage: cli.ts mutate --origin <url> <name> [input-json].
import { DESCRIBE_MUTATION } from './discovery';
import { httpFetch } from './fetch';
import { assertProcedureName, callProcedure } from './trpc';
import { deserializeEnvelope, serializeInput } from './superjson-lite';

interface MutationError {
  error: string;
  outcome: 'not-dispatched' | 'unknown';
  hint?: string;
}

type MutationResult = { ok: true; data: unknown } | { ok: false; error: MutationError };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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
  input?: unknown;
  accessToken: string;
}): Promise<MutationResult> {
  assertProcedureName(args.procedure);
  const rejected = (error: string): MutationResult => ({ ok: false, error: { error, outcome: 'not-dispatched' } });
  const uncertain = (error: string): MutationResult => ({ ok: false, error: {
    error, outcome: 'unknown',
    hint: 'Do not automatically retry. Check the record state before another attempt; the write may already have succeeded and duplicate submissions can execute twice.',
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
  const deployment = metadata.deployment;
  if (!record(deployment) || typeof deployment.commitSha !== 'string' || !/^[0-9a-f]{40}$/i.test(deployment.commitSha)
    || typeof deployment.deployedAt !== 'string' || !Number.isFinite(Date.parse(deployment.deployedAt))) {
    return rejected('Mutation contract has no verified deployment provenance');
  }
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

  // Contact updates may create a related company; this client supports updates only.
  if (args.procedure === 'v3.crm.contact.updateContact' && record(args.input)
    && args.input.contactCompanyName && args.input.useExisting !== true) {
    return rejected('Creating a company through contact update is unsupported; no mutation was dispatched');
  }
  let body: string;
  try {
    body = JSON.stringify(serializeInput(args.input));
  } catch {
    return rejected('Mutation input must be plain JSON; no mutation was dispatched');
  }
  // Discovery determines client eligibility. The actual procedure independently
  // enforces current permissions and input validation; this is not a token scope.
  try {
    const response = await httpFetch(`${args.origin}/trpc/${args.procedure}`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${args.accessToken}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    let payload: unknown;
    try { payload = await response.json(); } catch { return uncertain('Mutation procedure returned an unreadable response'); }
    if (!record(payload)) return uncertain('Mutation procedure returned a malformed response');
    if (!response.ok || payload.error) {
      const error = record(payload.error) && record(payload.error.json) && record(payload.error.json.data)
        ? payload.error.json.data.code : undefined;
      const code = typeof error === 'string' && /^[A-Z_]{1,64}$/.test(error) ? error : `HTTP_${response.status}`;
      return uncertain(`Mutation procedure did not report success (${code})`);
    }
    if (!record(payload.result) || !record(payload.result.data) || !Object.hasOwn(payload.result.data, 'json')) {
      return uncertain('Mutation procedure returned a malformed result envelope');
    }
    return { ok: true, data: deserializeEnvelope(payload.result.data) };
  } catch {
    return uncertain('Mutation procedure connection failed after dispatch');
  }
}

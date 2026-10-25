// Embrace CLI helper: PKCE login, authenticated tRPC calls, logout and status
// for Embrace origins. Runs as a plain Bun process outside any agent sandbox
// (spawned by Embrace Claude Mod, or used directly in a terminal).
//
// Usage:
//   bun helper/cli.ts login --origin https://mbdev.app.embracegrowth.ai
//     Prints the authorize URL, waits for the pasted one-time code on stdin,
//     then exchanges and stores tokens. --url-only prints
//     {"authorizeUrl","state"} and exits (mod flow step 1). --complete reads
//     the pasted code from stdin non-interactively (mod flow step 2).
//   bun helper/cli.ts discover --origin <url> --search project --limit 20
//   bun helper/cli.ts describe --origin <url> v3.project.getProjects
//   bun helper/cli.ts call --origin <url> v3.agent.listThreads
//   bun helper/cli.ts call --origin <url> v3.agent.getThread '{"threadId":"..."}'
//   bun helper/cli.ts logout --origin <url> [--force]
//   bun helper/cli.ts status [--origin <url>] [--json]
//
// Token custody: ${XDG_STATE_HOME:-~/.local/state}/embrace-cli/tokens.json
// (0600 file in a 0700 directory). Tokens, codes, cookies and auth headers are
// never printed; all output passes a redaction pass. Exit codes: 0 ok,
// 1 error, 2 not signed in. See README.md for the full flow.

import { parseArgs } from 'node:util';
import * as readline from 'node:readline/promises';
import {
  buildAuthorizeUrl,
  exchangeCode,
  normalizeOrigin,
  parsePastedCode,
  refreshGrant,
  revokeToken,
  toStoredToken,
  verifyState,
} from './oauth';
import { createPkcePair, createState } from './pkce';
import { sanitizeForPrint } from './sanitize';
import { setFetchForTests } from './fetch';
import {
  FilePendingLoginStore,
  FileTokenStore,
  isPendingFresh,
  isTokenExpired,
  stateDirectory,
  type PendingLoginStore,
  type TokenStore,
} from './token-store';
import { callProcedure } from './trpc';
import { discoveryRequest, LIST_QUERIES, DESCRIBE_QUERY } from './discovery';

export { setFetchForTests };

/** Everything the command flows need; injectable for tests. */
export interface CliContext {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Pre-seeded stdin text (tests, and the mod's piped paste). */
  stdin?: string;
  tokenStore?: TokenStore;
  pendingStore?: PendingLoginStore;
  now?: () => number;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export interface CliArgs {
  command: 'login' | 'call' | 'logout' | 'status' | 'discover' | 'describe';
  origin?: string;
  procedure?: string;
  inputJson?: string;
  urlOnly?: boolean;
  complete?: boolean;
  json?: boolean;
  force?: boolean;
}

/** Parse and validate argv (excluding argv[0]/argv[1]). Pure; tested. */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv;
  if (!command) throw new CliError('missing subcommand (login, discover, describe, call, logout or status)');
  try {
    if (command === 'login') {
      const { values } = parseArgs({
        args: rest,
        options: {
          origin: { type: 'string' },
          'url-only': { type: 'boolean', default: false },
          complete: { type: 'boolean', default: false },
        },
      });
      if (!values.origin) throw new CliError('login requires --origin <url>');
      return {
        command,
        origin: values.origin,
        urlOnly: Boolean(values['url-only']),
        complete: Boolean(values.complete),
      };
    }
    if (command === 'discover' || command === 'describe') {
      const { values, positionals } = parseArgs({
        args: rest,
        options: command === 'discover'
          ? { origin: { type: 'string' }, search: { type: 'string' }, limit: { type: 'string' }, after: { type: 'string' } }
          : { origin: { type: 'string' } },
        allowPositionals: true,
      });
      if (typeof values.origin !== 'string' || !values.origin) throw new CliError(`${command} requires --origin <url>`);
      if ((command === 'discover' && positionals.length !== 0)
        || (command === 'describe' && positionals.length !== 1)) {
        throw new CliError(command === 'discover' ? 'discover takes options only' : 'describe requires one query name');
      }
      const request = discoveryRequest({
        command,
        name: positionals[0],
        search: typeof values.search === 'string' ? values.search : undefined,
        limit: typeof values.limit === 'string' ? Number(values.limit) : undefined,
        after: typeof values.after === 'string' ? values.after : undefined,
      });
      return { command, origin: values.origin, ...request };
    }
    if (command === 'call') {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { origin: { type: 'string' } },
        allowPositionals: true,
      });
      if (!values.origin) throw new CliError('call requires --origin <url>');
      const [procedure, inputJson] = positionals;
      if (!procedure) throw new CliError('call requires a procedure (e.g. v3.agent.listThreads)');
      if (positionals.length > 2) throw new CliError('call takes at most two positionals: <procedure> [json]');
      if (inputJson !== undefined) JSON.parse(inputJson);
      return { command, origin: values.origin, procedure, inputJson };
    }
    if (command === 'logout') {
      const { values } = parseArgs({
        args: rest,
        options: { origin: { type: 'string' }, force: { type: 'boolean', default: false } },
      });
      if (!values.origin) throw new CliError('logout requires --origin <url>');
      return { command, origin: values.origin, force: Boolean(values.force) };
    }
    if (command === 'status') {
      const { values } = parseArgs({
        args: rest,
        options: { origin: { type: 'string' }, json: { type: 'boolean', default: false } },
      });
      return { command, origin: values.origin, json: Boolean(values.json) };
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof SyntaxError) throw new CliError('procedure input is not valid JSON');
    throw new CliError(`invalid arguments for ${command}`);
  }
  throw new CliError(`unknown subcommand: ${command}`);
}

/** Run a parsed command. Returns the process exit code. */
export async function runCommand(args: CliArgs, context: CliContext = {}): Promise<number> {
  const print = (payload: unknown) => (context.stdout ?? console.log)(JSON.stringify(sanitizeForPrint(payload)));
  const fail = (error: unknown): number => {
    if (error instanceof CliError) {
      (context.stderr ?? console.error)(JSON.stringify(sanitizeForPrint({ error: error.message, ...(error.hint ? { hint: error.hint } : {}) })));
      return error.exitCode;
    }
    if (error instanceof Error) {
      (context.stderr ?? console.error)(JSON.stringify(sanitizeForPrint({ error: error.message })));
      return 1;
    }
    // A plain `{ error, hint? }` payload from a flow.
    (context.stderr ?? console.error)(JSON.stringify(sanitizeForPrint(error)));
    return 1;
  };
  const tokenStore = context.tokenStore ?? new FileTokenStore();
  const pendingStore = context.pendingStore ?? new FilePendingLoginStore();
  const now = context.now ?? Date.now;

  try {
    const origin = args.origin === undefined ? undefined : normalizeOrigin(args.origin);
    switch (args.command) {
      case 'login':
        return await loginFlow(origin!, args, { tokenStore, pendingStore, now, print, fail, context });
      case 'call':
      case 'discover':
      case 'describe':
        return await callFlow(origin!, args, { tokenStore, now, print, fail });
      case 'logout':
        return await logoutFlow(origin!, args, { tokenStore, print, fail });
      case 'status':
        return await statusFlow(origin, args, { tokenStore, now, print, fail });
    }
  } catch (error) {
    return fail(error);
  }
}

type FlowContext = {
  tokenStore: TokenStore;
  pendingStore?: PendingLoginStore;
  now: () => number;
  print: (payload: unknown) => void;
  fail: (error: unknown) => number;
  context?: CliContext;
};

async function loginFlow(origin: string, args: CliArgs, flow: FlowContext): Promise<number> {
  const pendingStore = flow.pendingStore!;

  if (args.urlOnly) {
    const { verifier, challenge } = await createPkcePair();
    const state = createState();
    await pendingStore.put({ origin, verifier, state, created_at: flow.now() });
    flow.print({ origin, authorizeUrl: buildAuthorizeUrl(origin, challenge, state), state });
    return 0;
  }

  if (args.complete) {
    return completeLogin(origin, await readPasted(flow.context), flow);
  }

  // Interactive terminal flow: show the URL, then prompt for the pasted code.
  const { verifier, challenge } = await createPkcePair();
  const state = createState();
  await pendingStore.put({ origin, verifier, state, created_at: flow.now() });
  const write = flow.context?.stdout ?? console.log;
  write('');
  write('1. Open this URL in any browser and sign in:');
  write(`   ${buildAuthorizeUrl(origin, challenge, state)}`);
  write('2. The finish page shows a one-time code. Paste it here (with its state, if shown).');
  const pasted = await readPasted(flow.context, 'one-time code: ');
  return completeLogin(origin, pasted, flow);
}

async function completeLogin(origin: string, pasted: string, flow: FlowContext): Promise<number> {
  const pendingStore = flow.pendingStore!;
  const parsed = parsePastedCode(pasted);
  const pending = await pendingStore.get(origin);
  if (!pending) throw new CliError(`no pending login for ${origin}`, 1, 'start again: login --origin <url>');
  try {
    verifyState(pending, parsed.state);
    if (!isPendingFresh(pending, flow.now())) {
      throw new CliError('pending login expired (10 minutes)', 1, 'start again: login --origin <url>');
    }
    const grant = await exchangeCode(origin, parsed.code, pending.verifier);
    const stored = toStoredToken(origin, grant, { now: flow.now });
    if (!stored.refresh_token) throw new CliError('server did not issue a refresh token');
    await flow.tokenStore.put(stored);
    flow.print({ origin, email: stored.email });
    return 0;
  } finally {
    // The verifier and the code are single-use either way.
    await pendingStore.remove(origin);
  }
}

async function callFlow(origin: string, args: CliArgs, flow: FlowContext): Promise<number> {
  const stored = await flow.tokenStore.get(origin);
  if (!stored) {
    throw new CliError(`not signed in for ${origin}`, 2, `run: bun helper/cli.ts login --origin ${origin}`);
  }
  let accessToken = stored.access_token;
  if (isTokenExpired(stored, flow.now())) {
    accessToken = await refreshStoredToken(stored, flow);
  }
  const input = args.inputJson === undefined ? undefined : (JSON.parse(args.inputJson) as unknown);
  const result = await callProcedure({ origin, procedure: args.procedure!, input, accessToken });
  if (!result.ok) {
    flow.fail({
      error: `procedure ${args.procedure} failed (${result.errorCode ?? result.httpStatus})`,
      ...(result.errorCode === 'UNAUTHORIZED' ? { hint: 'try signing in again' } : {}),
      ...(result.errorCode === 'NOT_FOUND' && [LIST_QUERIES, DESCRIBE_QUERY].includes(args.procedure!)
        ? { hint: 'Discovery or this query contract is unavailable on this deployment; check the instance/version with its operator. Do not guess API names or input schemas.' }
        : {}),
    });
    return 1;
  }
  flow.print(result.data ?? null);
  return 0;
}

async function refreshStoredToken(stored: NonNullable<Awaited<ReturnType<TokenStore['get']>>>, flow: FlowContext): Promise<string> {
  if (!stored.refresh_token) throw new CliError('no refresh token stored', 2, 'sign in again');
  let grant;
  try {
    grant = await refreshGrant(stored.origin, stored.refresh_token);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/responded 4\d\d/.test(message)) {
      await flow.tokenStore.remove(stored.origin);
      throw new CliError('session expired or revoked', 2, 'sign in again: login --origin <url>');
    }
    throw new CliError('could not reach the token endpoint');
  }
  const refreshed = toStoredToken(stored.origin, grant, { previousEmail: stored.email, now: flow.now });
  if (!refreshed.refresh_token) refreshed.refresh_token = stored.refresh_token;
  await flow.tokenStore.put(refreshed);
  return refreshed.access_token;
}

async function logoutFlow(origin: string, args: CliArgs, flow: FlowContext): Promise<number> {
  const stored = await flow.tokenStore.get(origin);
  if (!stored) {
    flow.print({ origin, signedOut: false, reason: 'no stored session' });
    return 0;
  }
  try {
    if (stored.refresh_token) await revokeToken(origin, stored.refresh_token);
  } catch (error) {
    if (!args.force) {
      const message = error instanceof Error ? error.message : 'revoke failed';
      flow.fail({ error: `${message}; session kept`, hint: 'retry, or pass --force to drop the local session anyway' });
      return 1;
    }
  }
  await flow.tokenStore.remove(origin);
  flow.print({ origin, signedOut: true });
  return 0;
}

async function statusFlow(origin: string | undefined, args: CliArgs, flow: FlowContext): Promise<number> {
  const tokens = origin === undefined ? await flow.tokenStore.list() : [await flow.tokenStore.get(origin)].filter(
    (token): token is NonNullable<typeof token> => token !== null,
  );
  const sessions = tokens.map(token => ({
    origin: token.origin,
    email: token.email,
    accessTokenValid: !isTokenExpired(token, flow.now),
  }));
  if (args.json) {
    flow.print({ sessions });
    return 0;
  }
  const write = flow.context?.stdout ?? console.log;
  if (sessions.length === 0) write(`no Embrace sessions (state: ${stateDirectory()})`);
  for (const session of sessions) {
    write(`${session.origin}  ${session.email ?? 'unknown email'}  access token ${session.accessTokenValid ? 'valid' : 'EXPIRED'}`);
  }
  return 0;
}

/** Read the pasted code: injected stdin, piped stdin, or an interactive prompt. */
async function readPasted(context: CliContext | undefined, prompt?: string): Promise<string> {
  if (context?.stdin !== undefined) return context.stdin;
  if (typeof process !== 'undefined' && process.stdin?.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(prompt ?? '');
    } finally {
      rl.close();
    }
  }
  const chunks: Uint8Array[] = [];
  if (typeof process !== 'undefined') {
    for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

if (import.meta.main) {
  try {
    const exitCode = await runCommand(parseCliArgs(process.argv.slice(2)));
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof CliError || error instanceof Error ? error.message : 'unexpected error';
    console.error(JSON.stringify({ error: message }));
    process.exit(error instanceof CliError ? error.exitCode : 1);
  }
}

// embrace-cli Claude Code mod.
//
// /embrace-login: host picker (mbdev default, localhost dev, or any review
//   env via free text) → runs the Bun helper outside the sandbox to mint a
//   PKCE S256 authorize URL → shows it (copy button) → collects the pasted
//   one-time code → completes the secretless exchange → shows the signed-in
//   email and pins a status line. Query tRPC procedures run as the signed-in
//   user through the helper (e.g. `call v3.common.topBar.getCurrentUser`).
//
// Tokens live only in the helper's 0600 state file; this module never sees a
// token, and helper output is sanitized before printing anywhere.

import { atom, read, update } from 'claude-code';
import type { EngineInterface, PluginOptions, Register } from 'claude-code';

import type {
  EmbraceLoginState,
} from '../types';

const LOGIN_PANE = 'embrace-login';
const ORIGIN_STORE_KEY = 'embrace-cli:origin';
const FALLBACK_ORIGIN = 'https://mbdev.app.embracegrowth.ai';
const LOCAL_DEV_ORIGIN = 'http://localhost:5173';

const login = atom({ plugin: 'embrace-cli', key: 'login' } as const, {
  phase: 'idle',
  origin: '',
  authorizeUrl: '',
  message: '',
  email: null,
} satisfies EmbraceLoginState, { shape: 'login-1' });



interface HelperRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function defaultOrigin(options: PluginOptions): string {
  const origin = options.origin;
  return typeof origin === 'string' && origin ? origin : FALLBACK_ORIGIN;
}

/** Mirrors the helper's normalizeOrigin (https added when scheme-less). */
function normalizeOrigin(input: string): string | null {
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input) ? input : `https://${input}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

async function resolveHelper($: EngineInterface, options: PluginOptions): Promise<string | null> {
  const configured = typeof options.helperPath === 'string' ? options.helperPath.trim() : '';
  const candidates: string[] = configured ? [configured] : [];
  candidates.push(`${$.plugin.root}/helper/cli.ts`);
  for (const candidate of candidates) {
    const stat = await $.fs.stat(candidate).catch(() => null);
    if (stat?.kind === 'file') return candidate;
  }
  return null;
}

/** Run the helper (outside-sandbox process target) and collect its output. */
async function runHelper(
  $: EngineInterface,
  helper: string,
  args: readonly string[],
  stdin = '',
): Promise<HelperRun> {
  const { exitCode, stdout, stderr } = await $.process.run(['bun', helper, ...args], {
    timeoutMs: 60_000,
    stdin,
  });
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** The helper prints one JSON line; parse the last one that exists. */
function parseHelperJson(text: string): Record<string, unknown> | null {
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next line up.
    }
  }
  return null;
}

function helperError(run: HelperRun): string {
  return String(
    parseHelperJson(run.stderr)?.error
      ?? parseHelperJson(run.stdout)?.error
      ?? `helper exited ${run.exitCode}`,
  ).slice(0, 200);
}

const helperMissing = (howTo: string) => `embrace-cli helper not found. Set the plugin's helperPath option to helper/cli.ts (see README: ${howTo}).`;

// --- shared flows -------------------------------------------------------------

async function startLogin($: EngineInterface, options: PluginOptions, origin: string): Promise<string> {
  const helper = await resolveHelper($, options);
  if (!helper) return helperMissing('install');
  const started = await runHelper($, helper, ['login', '--origin', origin, '--url-only']);
  if (started.exitCode !== 0) return `helper failed: ${helperError(started)}`;
  const payload = parseHelperJson(started.stdout);
  const authorizeUrl = typeof payload?.authorizeUrl === 'string' ? payload.authorizeUrl : '';
  if (!authorizeUrl) return 'helper returned no authorize URL';
  await update($, login, previous => ({
    ...previous,
    phase: 'awaiting-code',
    origin,
    authorizeUrl,
    message: 'Open the authorize URL, sign in, then paste the code from the finish page.',
    email: null,
  } satisfies EmbraceLoginState));
  await $.ui.open({ id: LOGIN_PANE, title: `Embrace login — ${hostOf(origin)}`, focus: true });
  return `Embrace login started for ${origin}. Finish it in the Embrace login pane: open the authorize URL, sign in, and paste the one-time code.`;
}

async function completeLogin($: EngineInterface, options: PluginOptions, pasted: string): Promise<void> {
  const state = await read($, login);
  await update($, login, previous => ({ ...previous, phase: 'completing', message: 'Exchanging the code…' } satisfies EmbraceLoginState));
  const helper = await resolveHelper($, options);
  if (!helper) {
    await update($, login, previous => ({ ...previous, phase: 'error', message: helperMissing('install') } satisfies EmbraceLoginState));
    return;
  }
  const result = await runHelper($, helper, ['login', '--origin', state.origin, '--complete'], `${pasted}\n`);
  const payload = parseHelperJson(result.stdout);
  if (result.exitCode === 0 && payload && 'email' in payload) {
    const email = typeof payload.email === 'string' ? payload.email : null;
    await update($, login, previous => ({
      ...previous,
      phase: 'signed-in',
      origin: state.origin,
      authorizeUrl: '',
      message: '',
      email,
    } satisfies EmbraceLoginState));
    await $.store.set(ORIGIN_STORE_KEY, state.origin);
    $.ui.status(`embrace: ${email ?? 'signed in'} @ ${hostOf(state.origin)}`);
    $.ui.toast(`Signed in to Embrace as ${email ?? hostOf(state.origin)}`);
  } else {
    await update($, login, previous => ({ ...previous, phase: 'error', message: helperError(result) } satisfies EmbraceLoginState));
  }
}

async function refreshStatusLine($: EngineInterface, options: PluginOptions): Promise<void> {
  try {
    const helper = await resolveHelper($, options);
    if (!helper) return;
    const result = await runHelper($, helper, ['status', '--json']);
    if (result.exitCode !== 0) return;
    const sessions = parseHelperJson(result.stdout)?.sessions;
    if (!Array.isArray(sessions)) return;
    const session = sessions.find(
      (entry): entry is { origin: string; email: string | null; accessTokenValid: boolean } =>
        !!entry && typeof entry === 'object' && (entry as { accessTokenValid?: unknown }).accessTokenValid === true,
    );
    if (session) $.ui.status(`embrace: ${session.email ?? 'signed in'} @ ${hostOf(session.origin)}`);
  } catch {
    // Best-effort only; the status line stays unset.
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'embrace-login',
      description: 'Sign in to an Embrace origin (PKCE paste-code flow)',
      argumentHint: '[origin]',
    });
    void refreshStatusLine($, options);
    return next(e);
  });

  on('command.run', { command: 'embrace-login' }, async ($, e) => {
    let requested = e.args.trim();
    if (!requested) {
      try {
        requested = await $.ui.ask('Sign in to which Embrace origin?', {
          options: [defaultOrigin(options), LOCAL_DEV_ORIGIN],
          header: 'Embrace origin',
        });
      } catch {
        return { text: 'Embrace login cancelled.' };
      }
    }
    const origin = normalizeOrigin(requested);
    if (!origin) return { text: `Not a valid Embrace origin: ${requested}` };
    const message = await startLogin($, options, origin);
    return { text: message };
  });

  on('ui.render', { component: 'Pane', requestId: LOGIN_PANE }, async ($, e, next) => {
    // Input exists on terminal, desktop and vscode; mobile cannot paste a code.
    if (e.surface === 'mobile') return next(e);
    const { Box, Button, Input, Text } = $.ui.resolve(e);
    const state = await read($, login);
    return (
      <Box flexDirection="column" gap={1}>
        <Text weight="semibold">Embrace CLI login{state.origin ? ` — ${hostOf(state.origin)}` : ''}</Text>
        {state.phase === 'awaiting-code' && (
          <Box flexDirection="column">
            <Text dimColor>1. Open this URL in any browser and sign in:</Text>
            <Text wrap="wrap">{state.authorizeUrl}</Text>
            <Box flexDirection="row" gap={1}>
              <Button
                key="copy-url"
                label="Copy authorize URL"
                onPress={press => {
                  void $.ui.copy({ text: state.authorizeUrl, surface: press.surface });
                  $.ui.toast('Authorize URL copied');
                }}
              />
            </Box>
            <Text dimColor>2. The finish page shows a one-time code. Paste it below and press Enter:</Text>
            <Input
              key="paste-code"
              label="One-time code"
              placeholder="paste the code here"
              submitLabel="sign in"
              onSubmit={value => void completeLogin($, options, value)}
            />
          </Box>
        )}
        {state.phase === 'completing' && <Text dimColor>{state.message || 'Exchanging the code…'}</Text>}
        {state.phase === 'signed-in' && (
          <Box flexDirection="column">
            <Text color="success">Signed in as {state.email ?? 'unknown email'}</Text>
            <Text dimColor>Use the helper's call command to run tRPC queries as this user.</Text>
          </Box>
        )}
        {state.phase === 'error' && (
          <Box flexDirection="column">
            <Text color="error">Sign-in failed: {state.message}</Text>
            <Button
              key="restart"
              label="Start over"
              onPress={() => void $.command.run({ command: 'embrace-login', args: state.origin })}
            />
          </Box>
        )}
      </Box>
    );
  });
};

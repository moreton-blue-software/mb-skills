// Engine-native tests for pane dismissal and connect/switch; helper calls are
// mocked, never live. Usage: claude plugin test <isolated engine-test fixture
// containing these hooks>.
import { expect, test, mock } from 'claude-code/testing';

const pane = {
  plugin: 'embrace-claude-mod', component: 'Pane', requestId: 'embrace-login',
  props: { title: 'Embrace login', isFocused: true, bodyColumns: 80, placement: 'inline',
    scroll: { offset: 0, bodyRows: 24 }, view: {} },
} as const;
const origin = 'https://review.example.test';
const processResult = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
});

test('connect with no argument switches to a listed instance without starting a login', async ($, on) => {
  const calls: string[][] = [];
  const stored: [string, unknown][] = [];
  const statusTexts: string[] = [];
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
  on('process.run', (_, e) => {
    calls.push([...e.argv]);
    return processResult(JSON.stringify({ sessions: [
      { origin: 'https://a.example.test', email: 'a@example.test', accessTokenValid: true },
      { origin: 'https://b.example.test', email: 'b@example.test', accessTokenValid: false },
    ] }));
  });
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const labels = e.questions[0]!.options.map(option => option.label);
    expect(labels).toContain('b.example.test — b@example.test');
    expect(labels.at(-1)).toBe('Add another instance…');
    return { result: { questions: e.questions, answers: { [e.questions[0]!.question]: 'b.example.test — b@example.test' } } };
  });
  on('store.get', () => ({ value: undefined }));
  on('store.set', (_, e) => { stored.push([e.key, e.value]); return { value: undefined }; });
  on('ui.status', (_, e) => { statusTexts.push(e.text ?? ''); return { value: undefined }; });
  on('ui.toast', () => ({ value: undefined }));
  const result = await $.command.run({ command: 'embrace-connect', args: '',
    origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } });
  expect(calls).toHaveLength(2); // Connect reconciles first, then lists picker sessions.
  expect(calls[0]).toContain('status');
  expect(stored).toEqual([['embrace-cli:origin', 'https://b.example.test']]);
  expect(statusTexts.at(-1)).toContain('b.example.test');
  expect(JSON.stringify(result)).toContain('refresh on the next request');
});

test('connect with no sessions falls back to the origin picker and starts the login pane', async ($, on) => {
  const calls: string[][] = [];
  on('ui.status', () => ({ value: undefined }));
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
  on('process.run', (_, e) => {
    calls.push([...e.argv]);
    return processResult(JSON.stringify(e.argv.includes('status') ? { sessions: [] } : { authorizeUrl: `${origin}/authorize?dummy=public` }));
  });
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => ({
    result: { questions: e.questions, answers: { [e.questions[0]!.question]: origin } },
  }));
  on('store.get', () => ({ value: undefined }));
  on('ui.open', (_, e) => {
    expect(e.id).toBe('embrace-login');
    return { value: { isPlaced: true } };
  });
  await $.command.run({ command: 'embrace-connect', args: '',
    origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } });
  expect(calls.at(-1)).toContain('--url-only');
});

test('login opens with Escape dismissal and explicit close never signs out', async ($, on) => {
  const calls: string[][] = [];
  let closed = false;
  on('ui.status', () => ({ value: undefined }));
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
  on('process.run', (_, e) => {
    calls.push([...e.argv]);
    return processResult(JSON.stringify({ authorizeUrl: `${origin}/authorize?dummy=public` }));
  });
  on('ui.open', (_, e) => {
    expect(e.closeOnEscape).toBe(true);
    return { value: { isPlaced: true } };
  });
  on('ui.close', (_, e) => { expect(e.id).toBe('embrace-login'); closed = true; return { value: undefined }; });
  await $.command.run({ command: 'embrace-login', args: origin,
    origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } });
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' });
  expect((await ui.find({ key: 'close-login' }))?.text).toBe('Close');
  await ui.press({ key: 'close-login' });
  expect(closed).toBe(true);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain('--url-only');
  await ui.unmount();
});

test('successful code submission closes the pane after setting signed-in status', async ($, on) => {
  let closed = false;
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
  on('process.run', (_, e) => processResult(JSON.stringify(e.argv.includes('--complete')
    ? { email: 'fixture@example.test' } : { authorizeUrl: `${origin}/authorize?dummy=public` })));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('store.set', () => ({ value: undefined }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.toast', () => ({ value: undefined }));
  on('ui.close', () => { closed = true; return { value: undefined }; });
  await $.command.run({ command: 'embrace-login', args: origin,
    origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } });
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' });
  await ui.input({ key: 'paste-code', text: 'synthetic-test-code' });
  expect(closed).toBe(true);
  await ui.unmount();
});

test('failed code exchange leaves the pane available to retry or close', async ($, on) => {
  let closed = false;
  on('ui.status', () => ({ value: undefined }));
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
  on('process.run', (_, e) => e.argv.includes('--complete')
    ? processResult(JSON.stringify({ error: 'rejected' }), 1)
    : processResult(JSON.stringify({ authorizeUrl: `${origin}/authorize?dummy=public` })));
  on('prompt.compose', (_, e) => ({ sections: [] }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.close', () => { closed = true; return { value: undefined }; });
  await $.command.run({ command: 'embrace-login', args: origin,
    origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } });
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' });
  await ui.input({ key: 'paste-code', text: 'synthetic-test-code' });
  expect(closed).toBe(false);
  expect(await ui.find({ key: 'close-login' })).toBeDefined();
  await ui.unmount();
});


test('connect with either URL switches one resolved backend session without opening a pane', async ($, on) => {
  const backend = 'https://backend.example.test';
  const frontend = 'https://frontend.example.test';
  const calls: string[][] = [], statuses: string[] = [];
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
  on('process.run', (_, e) => {
    calls.push([...e.argv]);
    return processResult(JSON.stringify({ origin: backend, frontendOrigin: frontend, email: null, connected: true }));
  });
  on('store.set', (_, e) => { expect(e.value).toBe(backend); return { value: undefined }; });
  on('ui.status', (_, e) => { statuses.push(e.text ?? ''); return { value: undefined }; });
  on('ui.toast', () => ({ value: undefined }));
  on('ui.open', () => { throw new Error('Unexpected login pane'); });
  for (const url of [frontend, backend]) {
    const result = await $.command.run({ command: 'embrace-connect', args: url,
      origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } });
    expect(JSON.stringify(result)).toContain('Switched to');
  }
  expect(calls).toHaveLength(4);
  expect(calls.filter(argv => argv.includes('--url-only'))).toHaveLength(2);
  expect(statuses.filter(text => text.includes('frontend.example.test (backend backend.example.test)'))).toHaveLength(2);
});

test('frontend login uses the backend authorize URL and shows both origins after completion', async ($, on) => {
  const backend = 'https://backend.example.test';
  const frontend = 'https://frontend.example.test';
  const calls: string[][] = [], statuses: string[] = [];
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
  on('process.run', (_, e) => {
    calls.push([...e.argv]);
    expect(e.init?.timeoutMs).toBe(e.argv.includes('status') ? 5000 : 360_000); // Durable bounded resolution/exchange budget.
    return processResult(JSON.stringify(e.argv.includes('--complete')
      ? { origin: backend, frontendOrigin: frontend, email: null }
      : { origin: backend, frontendOrigin: frontend, authorizeUrl: `${backend}/authorize?dummy=public` }));
  });
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('store.set', () => ({ value: undefined }));
  on('ui.status', (_, e) => { statuses.push(e.text ?? ''); return { value: undefined }; });
  on('ui.toast', () => ({ value: undefined }));
  on('ui.close', () => ({ value: undefined }));
  await $.command.run({ command: 'embrace-connect', args: frontend,
    origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } });
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' });
  await ui.input({ key: 'paste-code', text: 'synthetic-test-code' });
  expect(calls.at(-1)).toContain(frontend); // Helper re-verifies binding before exchange.
  expect(statuses.at(-1)).toContain('frontend.example.test (backend backend.example.test)');
  await ui.unmount();
});


test('authoritative polling clears mod/external logout and revoked identity but preserves refreshable expiry', async ($, on) => {
  const clock = mock.clock(on);
  mock.store(on, { 'embrace-cli:origin': origin });
  let sessions = [{ origin, email: null, accessTokenValid: true }];
  const statuses: (string | undefined)[] = [];
  let calls = 0;
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.end', () => ({ sessionId: 'fixture-session' }));
  on('command.register', (_, e) => ({ value: { command: e.name } }));
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
  on('process.run', () => { calls++; return processResult(JSON.stringify({ sessions })); });
  on('ui.status', (_, e) => { statuses.push(e.text); return { value: undefined }; });
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  expect(statuses.at(-1)).toContain('review.example.test');
  sessions = [];
  await clock.advance(5000); // Mod helper logout removed authoritative session.
  expect(statuses.at(-1)).toBeUndefined();
  sessions = [{ origin, email: null, accessTokenValid: false }];
  await clock.advance(5000);
  expect(statuses.at(-1)).toContain('review.example.test'); // Refreshable expiry is not logout.
  sessions = [];
  await clock.advance(5000); // External logout or refresh rejection removed session.
  expect(statuses.at(-1)).toBeUndefined();
  await $.session.end({ reason: 'clear', sessionId: 'fixture-session', resume: { id: 'fixture-session' } });
  await clock.advance(5000);
  const before = calls;
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture-session', resume: { id: 'fixture-session' } });
  await clock.advance(10000);
  expect(calls).toBe(before);
});

for (const end of ['completed', 'cancelled', 'timeout', 'replaced', 'session-end']) test(`exact out-of-band watcher ${end}: bounded lifecycle and no prompt secrets`, async ($, on) => {
  const clock = mock.clock(on);
  mock.store(on, {});
  on('session.end', () => ({ sessionId: 'fixture-session' }));
  const backend = 'https://backend.example.test';
  const frontend = 'https://frontend.example.test';
  const marker = '11111111-1111-4111-8111-111111111111';
  let progress = 'pending', closed = false, progressCalls = 0;
  let sessions: { origin: string; email: null; accessTokenValid: boolean }[] = [{ origin: backend, email: null, accessTokenValid: true }];
  const statuses: (string | undefined)[] = [];
  const outputs: string[] = [];
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
  on('ui.status', (_, e) => { statuses.push(e.text); return { value: undefined }; });
  on('prompt.compose', (_, e) => ({ sections: [] }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.close', () => { closed = true; return { value: undefined }; });
  on('process.run', (_, e) => {
    if (e.argv.includes('--login-progress')) {
      progressCalls++;
      expect(e.argv).toContain(backend);
      expect(e.init?.stdin).toBe(marker);
      expect(e.init?.timeoutMs).toBe(5000);
      return processResult(JSON.stringify({ progress, ...(progress === 'completed' ? { session: { origin: backend, frontendOrigin: frontend, email: null, accessTokenValid: true } } : {}) }));
    }
    if (e.argv.includes('status')) return processResult(JSON.stringify({ sessions }));
    return processResult(JSON.stringify({ origin: backend, frontendOrigin: frontend, loginAttemptId: marker, authorizeUrl: `${backend}/authorize?dummy=public` }));
  });
  const result = await $.command.run({ command: 'embrace-connect', args: frontend,
    origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } });
  outputs.push(JSON.stringify(result));
  await clock.advance(5000);
  expect(closed).toBe(false); // A preexisting same-origin session is not this pending completion.
  sessions = [{ origin: 'https://unrelated.example.test', email: null, accessTokenValid: true }];
  await clock.advance(5000);
  expect(closed).toBe(false);
  if (end === 'completed') {
    progress = 'completed';
    await clock.advance(5000);
    expect(closed).toBe(true);
    expect(statuses.at(-1)).toContain('frontend.example.test (backend backend.example.test)');
  } else if (end === 'cancelled') {
    const ui = await $.ui.mount({ ...pane, surface: 'terminal' });
    await ui.press({ key: 'close-login' });
    await ui.unmount();
  } else if (end === 'session-end') {
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'fixture-session', resume: { id: 'fixture-session' } });
  } else if (end === 'replaced') {
    progress = 'ended';
    await clock.advance(5000);
    expect(closed).toBe(true);
  } else {
    await clock.advance(600_000);
    expect(closed).toBe(true);
  }
  const before = progressCalls;
  await clock.advance(10000);
  expect(progressCalls).toBe(before);
  const prompt = await $.prompt.compose({ model: 'fixture', promptModel: 'fixture', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] });
  expect(JSON.stringify(prompt)).not.toContain(marker);
  expect(JSON.stringify(prompt)).not.toContain('authorize?dummy');
  expect(outputs.join()).not.toContain(marker);
  expect(outputs.join()).not.toContain('authorize?');
});


test('logout reconciliation removes signed-in pane identity rather than leaving local atom stale', async ($, on) => {
  const clock = mock.clock(on);
  mock.store(on, {});
  let connected = false;
  const phases: string[] = [];
  on('state.set', (_, e, next) => {
    const value = e.value as { value?: { phase?: string } };
    if (value.value?.phase) phases.push(value.value.phase);
    return next(e);
  });
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('command.register', (_, e) => ({ value: { command: e.name } }));
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
  on('process.run', (_, e) => {
    if (e.argv.includes('status')) return processResult(JSON.stringify({ sessions: connected ? [{ origin, email: null, accessTokenValid: true }] : [] }));
    if (e.argv.includes('--complete')) { connected = true; return processResult(JSON.stringify({ origin, email: null })); }
    return processResult(JSON.stringify({ authorizeUrl: `${origin}/authorize?dummy=public` }));
  });
  on('ui.status', () => ({ value: undefined }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.close', () => ({ value: undefined }));
  on('ui.toast', () => ({ value: undefined }));
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'embrace-connect', args: origin, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } });
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' });
  await ui.input({ key: 'paste-code', text: 'synthetic-test-code' });
  await ui.unmount();
  const signed = await $.ui.mount({ ...pane, surface: 'terminal' });
  expect(phases).toContain('signed-in');
  await signed.unmount();
  connected = false;
  await clock.advance(5000);
  const after = await $.ui.mount({ ...pane, surface: 'terminal' });
  // The UI no longer renders the signed-in identity after authoritative removal.
  expect(phases.at(-1)).toBe('idle');
  expect(await after.find({ key: 'signed-in-identity' })).toBeUndefined();
  await after.unmount();
});

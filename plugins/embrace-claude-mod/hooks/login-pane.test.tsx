// Engine-native tests for pane dismissal and connect/switch; helper calls are
// mocked, never live. Usage: claude plugin test <isolated engine-test fixture
// containing these hooks>.
import { expect, test } from 'claude-code/testing';

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
  on('ui.status', (_, e) => { statusTexts.push(e.text); return { value: undefined }; });
  on('ui.toast', () => ({ value: undefined }));
  const result = await $.command.run({ command: 'embrace-connect', args: '',
    origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } });
  expect(calls).toHaveLength(1); // status --json only: no login/--url-only, no token call.
  expect(calls[0]).toContain('status');
  expect(stored).toEqual([['embrace-cli:origin', 'https://b.example.test']]);
  expect(statusTexts[0]).toContain('b.example.test');
  expect(JSON.stringify(result)).toContain('refresh on the next request');
});

test('connect with no sessions falls back to the origin picker and starts the login pane', async ($, on) => {
  const calls: string[][] = [];
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
  expect(calls[1]).toContain('--url-only');
});

test('login opens with Escape dismissal and explicit close never signs out', async ($, on) => {
  const calls: string[][] = [];
  let closed = false;
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
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('--url-only');
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
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }));
  on('process.run', (_, e) => e.argv.includes('--complete')
    ? processResult(JSON.stringify({ error: 'rejected' }), 1)
    : processResult(JSON.stringify({ authorizeUrl: `${origin}/authorize?dummy=public` })));
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

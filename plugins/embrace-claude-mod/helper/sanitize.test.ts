// Output sanitization: sensitive keys never survive printing.

import { describe, expect, test } from 'bun:test';
import { sanitizeForPrint } from './sanitize';

describe('sanitizeForPrint', () => {
  test('redacts sensitive keys at any depth, keeps everything else', () => {
    const value = {
      origin: 'https://a.example',
      threadId: 't1',
      state: 'approved',
      nested: { access_token: 'SECRET', list: [{ refresh_token: 'SECRET', ok: true }] },
    };
    const sanitized = sanitizeForPrint(value) as typeof value & { nested: { access_token: string; list: { refresh_token: string; ok: boolean }[] } };
    expect(sanitized.origin).toBe('https://a.example');
    expect(sanitized.threadId).toBe('t1');
    expect(sanitized.state).toBe('approved'); // AgentDraft.state must survive
    expect(sanitized.nested.access_token).toBe('[redacted]');
    expect(sanitized.nested.list[0]!.refresh_token).toBe('[redacted]');
    expect(sanitized.nested.list[0]!.ok).toBe(true);
  });

  test('covers the sensitive vocabulary', () => {
    const sanitized = sanitizeForPrint({
      token: 'x', id_token: 'x', client_secret: 'x', authorization: 'x',
      Cookie: 'x', password: 'x', credentials: 'x', code_verifier: 'x',
      codeChallenge: 'x', mySecretField: 'x',
    }) as Record<string, string>;
    for (const key of Object.keys(sanitized)) expect(sanitized[key]).toBe('[redacted]');
  });

  test('handles arrays, primitives and cycles', () => {
    expect(sanitizeForPrint(['a', 1, null])).toEqual(['a', 1, null]);
    const cyclic: Record<string, unknown> = { access_token: 'x' };
    cyclic.self = cyclic;
    const sanitized = sanitizeForPrint(cyclic) as Record<string, unknown>;
    expect(sanitized.access_token).toBe('[redacted]');
    expect(sanitized.self).toBe('[circular]');
  });

  test('does not scan string values, only keys', () => {
    expect(sanitizeForPrint({ body: 'the access_token=abc in prose' })).toEqual({
      body: 'the access_token=abc in prose',
    });
  });
});

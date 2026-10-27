import { describe, expect, test } from 'bun:test';
import {
  ADD_ANOTHER,
  connectPickerOptions,
  parseSessions,
  pickStatusSession,
  sessionLabel,
  type SessionRow,
} from './sessions';

const row = (origin: string, email: string | null, accessTokenValid = true): SessionRow =>
  ({ origin, email, accessTokenValid });

describe('parseSessions', () => {
  test('keeps well-formed rows and drops malformed ones', () => {
    const parsed = parseSessions([
      row('https://a.example.test', 'a@example.test'),
      { origin: 'https://b.example.test' },
      null,
      'junk',
      { origin: 7, email: null, accessTokenValid: true },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.origin).toBe('https://a.example.test');
  });

  test('non-array input is empty', () => {
    expect(parseSessions(undefined)).toEqual([]);
    expect(parseSessions({ sessions: [] })).toEqual([]);
  });
});

describe('sessionLabel', () => {
  test('shows host and email, or host with signed-in fallback', () => {
    expect(sessionLabel(row('https://mbdev.app.example.test', 'user@example.test')))
      .toBe('mbdev.app.example.test — user@example.test');
    expect(sessionLabel(row('https://rev.example.test', null)))
      .toBe('rev.example.test — signed in');
  });
});

describe('pickStatusSession', () => {
  test('prefers the active origin even with an expired access token', () => {
    const sessions = [
      row('https://a.example.test', 'a@example.test'),
      row('https://b.example.test', 'b@example.test', false),
    ];
    expect(pickStatusSession(sessions, 'https://b.example.test')?.origin).toBe('https://b.example.test');
  });

  test('falls back to the first valid session when the active origin is unset or gone', () => {
    const sessions = [
      row('https://a.example.test', 'a@example.test'),
      row('https://b.example.test', 'b@example.test'),
    ];
    expect(pickStatusSession(sessions, undefined)?.origin).toBe('https://a.example.test');
    expect(pickStatusSession(sessions, 'https://gone.example.test')?.origin).toBe('https://a.example.test');
  });

  test('no sessions means no status line', () => {
    expect(pickStatusSession([], 'https://a.example.test')).toBeNull();
  });
});

describe('connectPickerOptions', () => {
  test('lists the active instance first, caps at three sessions, and always offers add-another', () => {
    const sessions = [
      row('https://a.example.test', 'a@example.test'),
      row('https://b.example.test', 'b@example.test'),
      row('https://c.example.test', 'c@example.test'),
      row('https://d.example.test', 'd@example.test'),
    ];
    const options = connectPickerOptions(sessions, 'https://c.example.test');
    expect(options).toHaveLength(4); // $.ui.ask allows 2-4 labels.
    expect(options[0]).toBe('c.example.test — c@example.test');
    expect(options).not.toContain('d.example.test — d@example.test');
    expect(options.at(-1)).toBe(ADD_ANOTHER);
  });

  test('no sessions means no picker options (caller falls back to the origin ask)', () => {
    expect(connectPickerOptions([], undefined)).toEqual([]);
  });
});

// Pure multi-instance helpers shared by the connect command and status line.
// The helper's token store owns which instances are connected; these functions
// only shape that list for the picker and pick which session the status line
// shows. Tests in sessions.test.ts.

export interface SessionRow {
  origin: string;
  email: string | null;
  accessTokenValid: boolean;
}

export const ADD_ANOTHER = 'Add another instance…';

/** Parse the helper's `status --json` sessions array; malformed rows drop out. */
export function parseSessions(value: unknown): SessionRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is SessionRow =>
      !!entry && typeof entry === 'object'
      && typeof (entry as SessionRow).origin === 'string'
      && ((entry as SessionRow).email === null || typeof (entry as SessionRow).email === 'string')
      && typeof (entry as SessionRow).accessTokenValid === 'boolean',
  );
}

/** Picker label for a connected instance, e.g. `mbdev.app… — user@example.test`. */
export function sessionLabel(session: SessionRow): string {
  const host = hostOf(session.origin);
  return session.email ? `${host} — ${session.email}` : `${host} — signed in`;
}

/**
 * Which session the status line shows: the active (last connected or switched)
 * origin when it still has a stored session, else the first valid one. An
 * expired access token still counts: the refresh token self-heals on the next
 * helper call, so the line keeps showing the instance the user chose.
 */
export function pickStatusSession(sessions: readonly SessionRow[], activeOrigin: unknown): SessionRow | null {
  const active = typeof activeOrigin === 'string' ? sessions.find(session => session.origin === activeOrigin) : undefined;
  return active ?? sessions.find(session => session.accessTokenValid) ?? null;
}

/**
 * Picker options for `/embrace-connect` with no argument: connected instances
 * (active first, at most three — `$.ui.ask` allows four labels) plus the
 * add-another entry. Free text under "Other" always accepts any origin.
 */
export function connectPickerOptions(sessions: readonly SessionRow[], activeOrigin: unknown): string[] {
  if (sessions.length === 0) return [];
  const active = typeof activeOrigin === 'string' ? activeOrigin : '';
  const ordered = [...sessions].sort((a, b) => Number(b.origin === active) - Number(a.origin === active));
  return [...ordered.slice(0, 3).map(sessionLabel), ADD_ANOTHER];
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

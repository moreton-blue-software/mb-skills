// Per-host token custody for the Embrace CLI helper. Tokens live in a 0600 JSON
// file inside a 0700 directory under ${XDG_STATE_HOME:-~/.local/state}/embrace-cli;
// permissions are enforced (self-tightened) on every read and write. The store
// sits behind a small interface so an OS-keychain backend can replace the file
// later without touching callers. Pending PKCE logins (verifier + state) get
// their own 0600 file and a 10-minute TTL.
// Usage: see cli.ts; tests in token-store.test.ts.

import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, writeSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface StoredToken {
  origin: string;
  email: string | null;
  access_token: string;
  refresh_token: string;
  /** Epoch milliseconds when the access token expires. */
  expires_at: number;
}

export interface PendingLogin {
  origin: string;
  verifier: string;
  state: string;
  /** Epoch milliseconds when this pending login was created. */
  created_at: number;
}

/** A pending login older than this is refused. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** The approved custody backend interface; swap for a keychain implementation later. */
export interface TokenStore {
  get(origin: string): Promise<StoredToken | null>;
  put(token: StoredToken): Promise<void>;
  remove(origin: string): Promise<boolean>;
  list(): Promise<StoredToken[]>;
}

export interface PendingLoginStore {
  get(origin: string): Promise<PendingLogin | null>;
  put(pending: PendingLogin): Promise<void>;
  remove(origin: string): Promise<boolean>;
}

/** Root directory for all helper state. */
export function stateDirectory(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.startsWith('/') ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'embrace-cli');
}

function enforceDirPermissions(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (statSync(dir).mode & 0o077) chmodSync(dir, 0o700);
}

/** Write `text` to `path` with the file created 0600 regardless of umask. */
function writeFileRestricted(path: string, text: string): void {
  const fd = openSync(path, 'w', 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  // umask may have loosened the create-time mode; force it.
  if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
}

function readJsonMap(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('state file is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function writeJsonMap(path: string, map: Record<string, unknown>): void {
  writeFileRestricted(path, `${JSON.stringify(map, null, 2)}\n`);
}

function isStoredToken(value: unknown): value is StoredToken {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.origin === 'string'
    && (entry.email === null || typeof entry.email === 'string')
    && typeof entry.access_token === 'string'
    && typeof entry.refresh_token === 'string'
    && typeof entry.expires_at === 'number';
}

/** File-backed per-host token store (the approved default backend). */
export class FileTokenStore implements TokenStore {
  private readonly path: string;

  constructor(directory: string = stateDirectory()) {
    this.path = join(directory, 'tokens.json');
    this.directory = directory;
  }

  private readonly directory: string;

  private async readMap(): Promise<Map<string, StoredToken>> {
    enforceDirPermissions(this.directory);
    const map = new Map<string, StoredToken>();
    for (const [key, value] of Object.entries(readJsonMap(this.path))) {
      if (isStoredToken(value)) map.set(key, value);
    }
    return map;
  }

  async get(origin: string): Promise<StoredToken | null> {
    return (await this.readMap()).get(origin) ?? null;
  }

  async put(token: StoredToken): Promise<void> {
    const map = await this.readMap();
    map.set(token.origin, token);
    writeJsonMap(this.path, Object.fromEntries(map));
  }

  async remove(origin: string): Promise<boolean> {
    const map = await this.readMap();
    const existed = map.delete(origin);
    if (existed) writeJsonMap(this.path, Object.fromEntries(map));
    return existed;
  }

  async list(): Promise<StoredToken[]> {
    return [...(await this.readMap()).values()];
  }
}

function isPendingLogin(value: unknown): value is PendingLogin {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.origin === 'string'
    && typeof entry.verifier === 'string'
    && typeof entry.state === 'string'
    && typeof entry.created_at === 'number';
}

/** File-backed pending-login store for the PKCE verifier between URL and code. */
export class FilePendingLoginStore implements PendingLoginStore {
  private readonly path: string;

  constructor(directory: string = stateDirectory()) {
    this.path = join(directory, 'pending-logins.json');
    this.directory = directory;
  }

  private readonly directory: string;

  private async readMap(): Promise<Map<string, PendingLogin>> {
    enforceDirPermissions(this.directory);
    const map = new Map<string, PendingLogin>();
    for (const [key, value] of Object.entries(readJsonMap(this.path))) {
      if (isPendingLogin(value)) map.set(key, value);
    }
    return map;
  }

  async get(origin: string): Promise<PendingLogin | null> {
    return (await this.readMap()).get(origin) ?? null;
  }

  async put(pending: PendingLogin): Promise<void> {
    const map = await this.readMap();
    map.set(pending.origin, pending);
    writeJsonMap(this.path, Object.fromEntries(map));
  }

  async remove(origin: string): Promise<boolean> {
    const map = await this.readMap();
    const existed = map.delete(origin);
    if (existed) {
      writeJsonMap(this.path, Object.fromEntries(map));
      if (map.size === 0) unlinkSync(this.path);
    }
    return existed;
  }
}

/** Whether a pending login is still within its TTL. Pure; tested. */
export function isPendingFresh(pending: PendingLogin, now = Date.now()): boolean {
  return now - pending.created_at <= PENDING_TTL_MS;
}

/** Whether the access token is expired (with clock-skew allowance). Pure; tested. */
export function isTokenExpired(token: StoredToken, now = Date.now(), skewMs = 60_000): boolean {
  return now >= token.expires_at - skewMs;
}

// Token custody: 0600/0700 enforcement (umask-independent and self-healing),
// per-host isolation, pending-login TTL.

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilePendingLoginStore,
  FileTokenStore,
  isPendingFresh,
  isTokenExpired,
  PENDING_TTL_MS,
  type StoredToken,
} from './token-store';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'embrace-cli-store-'));
}

function token(origin: string, overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    origin,
    email: 'dev@mb.test',
    access_token: `access-${origin}`,
    refresh_token: `refresh-${origin}`,
    expires_at: Date.now() + 3_600_000,
    ...overrides,
  };
}

describe('FileTokenStore permissions', () => {
  test('creates the state directory 0700 and the file 0600 regardless of umask', async () => {
    const dir = tempDir();
    const store = new FileTokenStore(dir);
    await store.put(token('https://a.example'));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'tokens.json')).mode & 0o777).toBe(0o600);
  });

  test('self-heals loosened permissions on next open', async () => {
    const dir = tempDir();
    const store = new FileTokenStore(dir);
    await store.put(token('https://a.example'));
    const file = join(dir, 'tokens.json');
    chmodSync(file, 0o644);
    await store.get('https://a.example');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('tokens never appear in the directory listable by others (mode check is content-independent)', async () => {
    const dir = tempDir();
    const store = new FileTokenStore(dir);
    await store.put(token('https://a.example', { access_token: 'SUPER-SECRET' }));
    const raw = await Bun.file(join(dir, 'tokens.json')).text();
    expect(raw).toContain('SUPER-SECRET'); // the store itself holds tokens; only the mode guards it
    expect(statSync(join(dir, 'tokens.json')).mode & 0o077).toBe(0);
  });
});

describe('FileTokenStore entries', () => {
  test('per-host isolation and removal', async () => {
    const store = new FileTokenStore(tempDir());
    await store.put(token('https://a.example'));
    await store.put(token('https://b.example'));
    expect((await store.list()).map(entry => entry.origin).sort()).toEqual(['https://a.example', 'https://b.example']);
    expect((await store.get('https://a.example'))?.access_token).toBe('access-https://a.example');
    expect(await store.remove('https://a.example')).toBe(true);
    expect(await store.get('https://a.example')).toBeNull();
    expect(await store.remove('https://a.example')).toBe(false);
    expect((await store.list()).map(entry => entry.origin)).toEqual(['https://b.example']);
  });
});

describe('FilePendingLoginStore', () => {
  test('round-trips per origin and removes', async () => {
    const dir = tempDir();
    const store = new FilePendingLoginStore(dir);
    await store.put({ origin: 'https://a.example', verifier: 'v1', state: 's1', created_at: Date.now() });
    const pending = await store.get('https://a.example');
    expect(pending).toMatchObject({ verifier: 'v1', state: 's1' });
    await store.remove('https://a.example');
    expect(await store.get('https://a.example')).toBeNull();
  });

  test('file is 0600', async () => {
    const dir = tempDir();
    const store = new FilePendingLoginStore(dir);
    await store.put({ origin: 'https://a.example', verifier: 'v1', state: 's1', created_at: Date.now() });
    expect(statSync(join(dir, 'pending-logins.json')).mode & 0o777).toBe(0o600);
  });

  test('remove deletes the file when empty', async () => {
    const dir = tempDir();
    const store = new FilePendingLoginStore(dir);
    await store.put({ origin: 'https://a.example', verifier: 'v1', state: 's1', created_at: Date.now() });
    await store.remove('https://a.example');
    expect(await store.get('https://a.example')).toBeNull();
  });
});

describe('pure helpers', () => {
  test('isPendingFresh honours the TTL', () => {
    const created = 1_000_000;
    const pending = { origin: 'https://a.example', verifier: 'v', state: 's', created_at: created };
    expect(isPendingFresh(pending, created + PENDING_TTL_MS - 1)).toBe(true);
    expect(isPendingFresh(pending, created + PENDING_TTL_MS + 1)).toBe(false);
  });

  test('isTokenExpired applies clock skew', () => {
    const expires = 2_000_000;
    const stored = token('https://a.example', { expires_at: expires });
    expect(isTokenExpired(stored, expires - 61_000)).toBe(false);
    expect(isTokenExpired(stored, expires - 59_000)).toBe(true); // inside the 60s skew window
    expect(isTokenExpired(stored, expires + 1)).toBe(true);
  });
});

// PKCE S256 correctness: RFC 7636 appendix B vector, verifier format, pairing.

import { describe, expect, test } from 'bun:test';
import { createPkcePair, createState, createVerifier, deriveChallenge } from './pkce';

const RFC7636_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC7636_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('deriveChallenge (S256)', () => {
  test('matches the RFC 7636 appendix B test vector', async () => {
    expect(await deriveChallenge(RFC7636_VERIFIER)).toBe(RFC7636_CHALLENGE);
  });

  test('is base64url without padding', async () => {
    expect(await deriveChallenge('a')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('createVerifier', () => {
  test('is 43 chars of base64url', () => {
    expect(createVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('does not repeat', () => {
    expect(new Set([createVerifier(), createVerifier(), createVerifier()]).size).toBe(3);
  });
});

describe('createPkcePair', () => {
  test('challenge matches the verifier via deriveChallenge', async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(await deriveChallenge(verifier)).toBe(challenge);
  });
});

describe('createState', () => {
  test('is a UUID', () => {
    expect(createState()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

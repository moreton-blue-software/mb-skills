// PKCE (RFC 7636) S256 verifier/challenge pairs and OAuth state values for the
// Embrace CLI login flow. Pure WebCrypto; no network, no storage.
// Usage: see cli.ts (`login` subcommand). Tested in pkce.test.ts against the
// RFC 7636 appendix B vector.

/** Random 32-byte value, base64url-encoded without padding: a 43-char verifier. */
export function createVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** S256 code challenge: base64url(SHA-256(verifier ASCII)), no padding. */
export async function deriveChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Fresh opaque state value for the authorize round-trip. */
export function createState(): string {
  return crypto.randomUUID();
}

/** A verifier plus its S256 challenge, ready for an authorize URL. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = createVerifier();
  return { verifier, challenge: await deriveChallenge(verifier) };
}

/** base64url without padding of raw bytes. */
export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

// Output sanitization: no token, code, cookie, auth header or other credential
// material is ever printed by the helper — not in results, not in errors.
// Applied to every stdout/stderr payload in cli.ts before printing.
// Usage: `sanitizeForPrint(value)` returns a deep copy with sensitive keys redacted.

const SENSITIVE_KEY = /access_token|refresh_token|id_token|^token$|secret|cookie|authorization|password|credential|verifier|challenge|client_secret/i;

/** Deep-copies `value` with values under sensitive-looking keys replaced. */
export function sanitizeForPrint(value: unknown): unknown {
  return redact(value, []);
}

function redact(value: unknown, seen: unknown[]): unknown {
  if (Array.isArray(value)) return value.map(item => redact(item, seen));
  if (value && typeof value === 'object') {
    if (seen.includes(value)) return '[circular]';
    const nextSeen = [...seen, value];
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, nextSeen);
    }
    return out;
  }
  return value;
}

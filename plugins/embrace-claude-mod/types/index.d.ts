// State contract for Embrace Claude Mod: the values it keeps in $.state.
// Schema-guided Date input transport lives solely in the helper. It adds no
// plugin state or token access; see QUERYING.md and MUTATING.md for its contract.
// Fresh v2 connection detection also stays in the helper: no persisted metadata,
// instance identity or new plugin-state fields. V2 queries are GET-only; writes denied.
// The helper session may keep frontendOrigin for display; OAuth/token custody and
// session keys remain backend-origin-only after fresh mutual pointer verification.
// Pending login keeps frontend display metadata. Sessions retain the login-bound
// revocation endpoint for discovery-independent logout; no ID token is persisted.

export type EmbraceLoginPhase = 'idle' | 'awaiting-code' | 'completing' | 'signed-in' | 'error';

export type EmbraceLoginState = {
  phase: EmbraceLoginPhase;
  origin: string;
  /** Public PKCE authorize URL (contains challenge + state only, never the verifier). */
  authorizeUrl: string;
  message: string;
  email: string | null;
};

declare module 'claude-code' {
  interface PluginState {
    'embrace-claude-mod': {
      login: Shaped<EmbraceLoginState>;
    };
  }
}

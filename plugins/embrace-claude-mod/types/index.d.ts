// State contract for Embrace Claude Mod: the values it keeps in $.state.

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

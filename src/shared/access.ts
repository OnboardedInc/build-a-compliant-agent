export interface AccessState {
  wall: boolean;
  ready: boolean;
  clientId: string | null;
  domain: string | null;
  email: string | null;
  /** Cloudflare Turnstile's public site key. Null while Turnstile is off. */
  turnstileSiteKey: string | null;
}

import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** `https://<domain>/dashboard/auth/callback`: registered at the identity provider. */
  redirectUri: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Pending {
  nonce: string;
  verifier: string;
  next: string;
  createdAt: number;
}

export interface Identity {
  email: string;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;
const sha256Base64Url = (value: string): string => createHash('sha256').update(value).digest('base64url');

/**
 * OpenID Connect sign-in with the authorization code flow and PKCE (S256), `state` and `nonce` (docs/plans/17-dashboard.md,
 * section 8). The ID token is verified against the provider's published keys: signature, issuer, audience, expiry and nonce, and the
 * email must be verified. Which accounts may sign in is the identity provider's decision (the Google app's audience); this class
 * adds no allowlist of its own.
 */
export class Oidc {
  private discovery: Promise<Discovery> | undefined;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly settings: OidcSettings,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
    /** The provider's signing keys; tests pass local ones. Default: the provider's published JWKS. */
    private keys?: JWTVerifyGetKey,
  ) {}

  private async metadata(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const response = await this.fetcher(`${this.settings.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
      if (!response.ok) throw new Error(`the identity provider answered ${response.status} to its discovery request`);
      const found = (await response.json()) as Partial<Discovery>;
      if (!found.authorization_endpoint || !found.token_endpoint || !found.jwks_uri)
        throw new Error('the identity provider did not publish the endpoints a sign-in needs');
      return found as Discovery;
    })().catch((error: unknown) => {
      this.discovery = undefined; // try again next time
      throw error;
    });
    return this.discovery;
  }

  /** The URL to send the browser to, and the `state` to remember in a cookie. `reauth` forces the provider to ask again. */
  async begin(next: string, reauth: boolean): Promise<{ url: string; state: string }> {
    const meta = await this.metadata();
    this.sweep();
    if (this.pending.size >= MAX_PENDING) throw new Error('too many sign-ins in progress');
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.pending.set(state, { nonce, verifier, next, createdAt: this.clock() });
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: this.settings.clientId,
      redirect_uri: this.settings.redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state,
      nonce,
      code_challenge: sha256Base64Url(verifier),
      code_challenge_method: 'S256',
      ...(reauth ? { prompt: 'login' } : {}),
    }).toString();
    return { url: url.toString(), state };
  }

  /** Finish a sign-in. Throws with a short reason on anything wrong; the `state` is single use. */
  async complete(code: string, state: string): Promise<Identity & { next: string }> {
    const entry = this.pending.get(state);
    this.pending.delete(state);
    if (entry === undefined || this.clock() - entry.createdAt > PENDING_TTL_MS)
      throw new Error('the sign-in expired or was not started here');
    const meta = await this.metadata();
    const response = await this.fetcher(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.settings.redirectUri,
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
        code_verifier: entry.verifier,
      }),
    });
    if (!response.ok) throw new Error('the identity provider refused the code');
    const tokens = (await response.json()) as { id_token?: unknown };
    if (typeof tokens.id_token !== 'string') throw new Error('the identity provider sent no ID token');
    this.keys ??= createRemoteJWKSet(new URL(meta.jwks_uri));
    const { payload } = await jwtVerify(tokens.id_token, this.keys, {
      issuer: meta.issuer,
      audience: this.settings.clientId,
      algorithms: ['RS256', 'ES256'],
    });
    if (payload['nonce'] !== entry.nonce) throw new Error('the ID token does not match this sign-in');
    const email = payload['email'];
    if (typeof email !== 'string' || email === '') throw new Error('the ID token has no email');
    if (payload['email_verified'] !== true) throw new Error('the email of this account is not verified');
    return { email, next: entry.next };
  }

  private sweep(): void {
    const now = this.clock();
    for (const [state, entry] of this.pending) if (now - entry.createdAt > PENDING_TTL_MS) this.pending.delete(state);
  }
}

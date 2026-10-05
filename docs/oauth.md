# OAuth with Google

The OAuth front ([`babs/mcp-auth-proxy`](https://github.com/babs/mcp-auth-proxy), started by `compose.yml`) signs you in with Google and only forwards calls that carry a valid token. It uses Google only to **authenticate you**; access control is the Google app itself. While the app is in **Testing** status only the test users you list can sign in.

You need this to use the server from Claude on the web or desktop (a public HTTPS URL with sign-in). Without OAuth, run the server on your own machine: `npm run dev`, or `deploy/compose.dev.yml`.

## Set it up

1. Google Cloud Console: create a project, then **APIs & Services → OAuth consent screen**. User type **External**, scopes `openid`, `email`, `profile`, and add **only your own account as a test user**.
2. **Credentials → Create credentials → OAuth client ID → Web application**. Authorized redirect URI: `https://<your domain>/callback`.
3. Fill in the OAuth block of `.env` (see [`deploy/.env.example`](../deploy/.env.example)): the client ID and secret, a `TOKEN_SIGNING_SECRET` generated with `openssl rand -base64 48` (keep it identical across restarts), and your public URL. The front reads `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `TOKEN_SIGNING_SECRET` and `TRUSTED_PROXY_CIDRS` from there (its other settings are in `compose.yml`):

```bash
BASE_URL=https://mcp.example.com
OIDC_ISSUER_URL=https://accounts.google.com
OIDC_CLIENT_ID=<google-oauth-client-id>.apps.googleusercontent.com
OIDC_CLIENT_SECRET=<google-oauth-client-secret>
TOKEN_SIGNING_SECRET=<openssl rand -base64 48>
TRUSTED_PROXY_CIDRS=172.17.0.1/32
```

The router gets the same file, so it also sees these secrets; it uses only the client ID and secret, as the dashboard's default sign-in client.

4. Set up a reverse proxy in front of the front's published port (`127.0.0.1:18931` by default): [`reverse-proxy.md`](reverse-proxy.md).
5. Start the stack (`docker compose up -d`) and test: a second Google account must be refused by Google ("access blocked").

## The operator dashboard

The dashboard signs in with Google too, with the same client by default. Add `https://<your domain>/dashboard/auth/callback` to that client's authorized redirect URIs. To give it a client of its own, set `DASHBOARD_OIDC_CLIENT_ID` and `DASHBOARD_OIDC_CLIENT_SECRET`.

## Rotating the secret

Rotating `TOKEN_SIGNING_SECRET` invalidates every issued token: remove and re-add the connector in Claude afterwards. Rotating the Google client secret: change it in Google Cloud Console, update `OIDC_CLIENT_SECRET` in `.env` and run `docker compose up -d front`.

Details and the threat model: [`plans/10-deployment.md`](plans/10-deployment.md) and [`plans/09-security.md`](plans/09-security.md).

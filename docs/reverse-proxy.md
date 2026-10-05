# Reverse proxy

The OAuth front publishes one port on the host (`PORT`, default `127.0.0.1:18931`). Put any reverse proxy that terminates TLS in front of it and send **every path** of your domain there. Do not rewrite paths and do not buffer responses (MCP uses streamed responses).

Set `TRUSTED_PROXY_CIDRS` in `.env` to the address your proxy has when it reaches the front: the Docker gateway (`172.17.0.1/32`, the default) if the proxy runs on the host, otherwise its LAN IP followed by `/32`. If the proxy runs on another machine or in a container, also change `127.0.0.1` in the front's `ports:` line of `compose.yml` to an address it can reach.

## Nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name mcp.example.com;

    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:18931;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

Complete examples, with the HTTP to HTTPS redirect, a bootstrap site for the certificate and the `/dashboard` location, are in [`deploy/nginx/`](../deploy/nginx/).

## Other proxies

Caddy, Traefik, HAProxy and the like work the same way: terminate TLS, forward everything to the front's port, keep the `Host` header and set `X-Forwarded-For` and `X-Forwarded-Proto`. The operator dashboard is optional and needs its own route: `/dashboard` goes to `DASHBOARD_PORT` (default `127.0.0.1:18933`), before the catch-all route.

The full host setup and the threat model are in [`plans/10-deployment.md`](plans/10-deployment.md) and [`plans/09-security.md`](plans/09-security.md).

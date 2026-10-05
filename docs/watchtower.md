# Updating the router automatically (optional)

The router container carries the label `com.centurylinklabs.watchtower.enable=true`. If you want it kept up to date, run [Watchtower](https://containrrr.dev/watchtower/) (or a maintained fork) yourself. Otherwise update by hand:

```bash
docker compose pull router && docker compose up -d router
```

The router image is named `jobwatch-router:latest` in `compose.yml`. If you pull it from a private registry, prefix it there (`image: registry.example.com/jobwatch-router:latest`) in your copy of the file, after `docker login`.

## Watchtower as a compose service

Add this service to your `compose.yml`, with `WATCHTOWER_IMAGE` set in `.env` to the image you chose (pin it by digest):

```yaml
  watchtower:
    image: ${WATCHTOWER_IMAGE}
    environment:
      DOCKER_HOST: unix:///var/run/docker.sock
      WATCHTOWER_LABEL_ENABLE: "true"          # only the labelled router is updated
      WATCHTOWER_CLEANUP: "true"
      WATCHTOWER_SCHEDULE: "0 30 4 * * *"      # 04:30 daily (6-field cron)
    volumes:
      - "${DOCKER_SOCKET:-${XDG_RUNTIME_DIR}/docker.sock}:/var/run/docker.sock"
      - "${HOME}/.docker/config.json:/config.json:ro"    # registry credentials from `docker login`
    networks: [ jobwatch-core ]
    restart: unless-stopped
```

The router image must be published with `provenance: false`, otherwise Watchtower cannot resolve the new digest (see [`plans/10-deployment.md`](plans/10-deployment.md)). The browser image is spawned by the router and is never updated by Watchtower: pull it by hand.

After an update, reconnect the Claude connector so it reloads the tool list.

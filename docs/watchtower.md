# Updating the router automatically (optional)

If you want the router kept up to date, run [Watchtower](https://containrrr.dev/watchtower/) (or a maintained fork) with the add-on below. Otherwise update by hand:

```bash
docker compose pull router && docker compose up -d router
```

The router image is `notcheu/jobwatch-mcp:latest` in `compose.yml` (Docker Hub, also on GHCR), republished on every release. Watchtower follows the tag you put there: with `latest` it follows every release, with a version tag it never moves.

## Watchtower as a compose add-on

[`deploy/compose.watchtower.yml`](../deploy/compose.watchtower.yml) adds the Watchtower service and the `com.centurylinklabs.watchtower.enable=true` label on the router (the base `compose.yml` has neither). Set `WATCHTOWER_IMAGE` in `.env` to the image you chose (pin it by digest), then:

```bash
docker compose -f compose.yml -f compose.watchtower.yml up -d
```

It checks daily at 04:30 and updates only labelled containers (the router), cleaning up old images. Edit the schedule in the file. It mounts the same Docker socket as the router and your `~/.docker/config.json` for registry credentials (remove that line if you pull anonymously). With rootless Docker, add `compose.rootless.yml` as well and change the left side of Watchtower's socket mount to `${XDG_RUNTIME_DIR}/docker.sock` ([`rootless-docker.md`](rootless-docker.md)).

The router image must be published with `provenance: false`, otherwise Watchtower cannot resolve the new digest (see [`plans/10-deployment.md`](plans/10-deployment.md)). The browser image is spawned by the router and is never updated by Watchtower: pull it by hand.

After an update, reconnect the Claude connector so it reloads the tool list.

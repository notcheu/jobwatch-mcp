# Rootless Docker (recommended on a server)

The router controls the Docker daemon it is given: it spawns, stops and removes the browser containers. Whoever owns that socket owns what the router can do, so on a server run the stack against **the rootless Docker daemon of a dedicated user** (no sudo, not in the `docker` group). A compromised router then reaches that user's containers and nothing else. Never give it a root daemon's socket on a shared host.

The base `compose.yml` mounts `/var/run/docker.sock`, which is what Docker Desktop (macOS) and a default install expose. For rootless Docker, add `compose.rootless.yml` on top:

```bash
docker compose -f compose.yml -f compose.rootless.yml up -d
```

It only replaces the socket mount with `${XDG_RUNTIME_DIR}/docker.sock` (`/run/user/<uid>/docker.sock`), so run Compose as the rootless user from a real login session. To use any other socket, edit the left side of that mount in `compose.yml`: it is not an environment variable.

The router runs as `user: "0:0"` in both cases. Under rootless Docker, uid 0 in the container is the Docker user on the host, which is what lets it open the socket and write `./data`; the container stays unprivileged (`cap_drop: ALL`, `no-new-privileges`, read-only root).

## Host setup (Ubuntu LTS)

See the host prerequisites in [`plans/10-deployment.md`](plans/10-deployment.md#host-prerequisites-ubuntu-lts) for the full procedure (packages, `subuid`/`subgid`, `loginctl enable-linger`, the Ubuntu 24.04 AppArmor profile for `rootlesskit`, `dockerd-rootless-setuptool.sh install`). Things to know:

- No ports below 1024 (the defaults are above), and slower networking than a rootful daemon.
- Memory limits need cgroup v2 delegation to the user's services: check `cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers` lists `memory` (`plans/06-memory-and-lifecycle-policy.md`).
- Use a dedicated user, so its `DOCKER_HOST` never interferes with another Docker on the machine. Measurements on the reference host: [`measurements.md`](measurements.md).
- The Watchtower add-on mounts the socket too: see [`watchtower.md`](watchtower.md).

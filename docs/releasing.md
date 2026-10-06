# Releasing

Versions follow [semantic versioning](https://semver.org). The project is **0.x: not production ready**. Anything can change between minor versions, including configuration, environment variables and tool schemas; there is no compatibility promise until 1.0.0. While 0.x, a breaking change bumps the **minor** version (0.1.0 to 0.2.0), a feature or a fix the next minor or patch as below.

## How a release happens

1. Work lands on `main` through squash-merged pull requests. **The pull request title is the commit message**, so it must be a conventional commit (`pr-title.yml` checks it): `<type>(<optional scope>): <summary>`, lowercase after the colon.

   | Type | Effect |
   |---|---|
   | `feat` | minor bump, listed under "Features" |
   | `fix` | patch bump, "Bug fixes" |
   | `perf`, `refactor`, `docs` | patch bump, listed |
   | `build`, `ci`, `test`, `chore`, `wip` | not listed, no bump on their own |
   | any type with `!` (`feat!:`) or a `BREAKING CHANGE:` footer | major bump (minor while 0.x) |

2. Every push to `main` makes [release-please](https://github.com/googleapis/release-please) open or update a **release pull request**: it bumps the version in `package.json` (and `apps/mcp/package.json`, which the server reports) and writes the new section of `CHANGELOG.md`. Never edit the version or the changelog by hand.
3. **Merging the release pull request is the release.** release-please tags `vX.Y.Z`, creates the GitHub Release with the changelog, and the same workflow builds the router image for `linux/amd64` and `linux/arm64` and pushes it:

   | Registry | Image | Tags |
   |---|---|---|
   | Docker Hub | `notcheu/jobwatch-mcp` | `X.Y.Z`, `X.Y`, `latest` |
   | GHCR | `ghcr.io/notcheu/jobwatch-mcp` | the same |

   The browser image is not published yet.

## First release (0.1.0)

`release-please-config.json` has `"release-as": "0.1.0"` so the first release is 0.1.0 whatever the commits say. **Remove that line right after the first release is published**, otherwise the next release pull request would propose 0.1.0 again.

## One-time setup

- **Docker Hub:** create the access token (Account settings, Personal access tokens, read and write) and add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` as GitHub Actions secrets. The `notcheu/jobwatch-mcp` repository can be created on Docker Hub in advance or by the first push.
- **GitHub namespace:** the repository lives in the `notcheu` organization, so the GHCR image is `ghcr.io/notcheu/jobwatch-mcp` (the workflow names it after the repository owner). Release-please needs *Settings, Actions, General, Allow GitHub Actions to create and approve pull requests* switched on, for the organization and for the repository.
- **Release pull request checks:** a pull request opened with the default `GITHUB_TOKEN` does not trigger other workflows, so CI does not run on the release pull request. If `main` requires the checks, add a personal access token (or GitHub App token) with `contents` and `pull requests` write access as the secret `RELEASE_PLEASE_TOKEN`.
- **Package visibility:** GHCR packages are private on first push: make the package public in its settings (organization, Packages, `jobwatch-mcp`, Package settings, Change visibility), and link it to the repository.

## Notes

- `provenance: false` is kept on the image build because Watchtower cannot resolve an image with a provenance attestation (see [`plans/10-deployment.md`](plans/10-deployment.md)). Without Watchtower in the picture it can be turned on, together with an SBOM.
- Images are not signed yet.
- The licence is [AGPL-3.0](../LICENSE): anyone running a modified version as a network service has to offer its source to the users of that service.

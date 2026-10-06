# Releasing

Versions follow [semantic versioning](https://semver.org). The project is **0.x: not production ready**. Anything can change between minor versions, including configuration, environment variables and tool schemas; there is no compatibility promise until 1.0.0. While 0.x, a breaking change bumps the **minor** version (0.1.0 to 0.2.0), a feature or a fix the next minor or patch as below.

## Two releases, two versions

The router and the browser image are released separately: each has its own version, tag, changelog, release pull request and image.

| | Router | Browser image |
|---|---|---|
| What | the server, the CLI, the dashboard | `images/browser` (headful Chrome, noVNC login mode) |
| Changes counted | everything except `images/browser` | only `images/browser` |
| Git tag | `jobwatch-router-vX.Y.Z` | `jobwatch-browser-vX.Y.Z` |
| Changelog | `CHANGELOG.md` | `images/browser/CHANGELOG.md` |
| Release PR title | `chore(main): release jobwatch-router X.Y.Z` | `chore(main): release jobwatch-browser X.Y.Z` |
| Docker Hub | `notcheu/jobwatch-mcp` | `notcheu/jobwatch-browser` |
| GHCR | `ghcr.io/notcheu/jobwatch-mcp` | `ghcr.io/notcheu/jobwatch-browser` |

Which one a change belongs to is decided by the files it touches, not by its scope. Use the `browser` scope (`fix(browser): ...`) for changes under `images/browser` so the history reads well. A pull request that touches both appears in both changelogs, so keep them apart when you can. A router release does not need a browser release, and the other way round.

## How a release happens

1. Work lands on `main` through squash-merged pull requests. **The pull request title is the commit message**, so it must be a conventional commit (`pr-title.yml` checks it): `<type>(<optional scope>): <summary>`, lowercase after the colon.

   | Type | Effect |
   |---|---|
   | `feat` | minor bump, listed under "Features" |
   | `fix` | patch bump, "Bug fixes" |
   | `perf`, `refactor`, `docs` | patch bump, listed |
   | `build`, `ci`, `test`, `chore`, `wip` | not listed, no bump on their own |
   | any type with `!` (`feat!:`) or a `BREAKING CHANGE:` footer | major bump (minor while 0.x) |

2. **Releases are on demand.** An ordinary merge to `main` does nothing. When you want to release, run the workflow by hand (`gh workflow run release.yml`, or Actions, Release, Run workflow): [release-please](https://github.com/googleapis/release-please) opens or updates a **release pull request**, and running it again refreshes that pull request with what has been merged since. There is one release pull request per release type. The router's bumps the version in `package.json` (and `apps/mcp/package.json`, which the server reports) and writes the new section of `CHANGELOG.md`; the browser's bumps `images/browser/version.txt` and writes `images/browser/CHANGELOG.md`. Never edit a version or a changelog by hand.
3. **Merging the release pull request is the release.** Its squash commit is titled `chore(main): release jobwatch-router X.Y.Z` (router) or `chore(main): release jobwatch-browser X.Y.Z` (browser), which is what starts the workflow by itself this time (if it was merged with another title, run the workflow by hand). release-please tags the release, creates the GitHub Release with the changelog, and the same workflow builds the image for `linux/amd64` and `linux/arm64` and pushes it:

   | Registry | Image | Tags |
   |---|---|---|
   | Docker Hub | `notcheu/jobwatch-mcp`, `notcheu/jobwatch-browser` | `X.Y.Z`, `X.Y`, `latest` |
   | GHCR | `ghcr.io/notcheu/jobwatch-mcp`, `ghcr.io/notcheu/jobwatch-browser` | the same |

   The browser image's `arm64` build uses Chromium, not Google Chrome, and is not for the LinkedIn session (see [`plans/10-deployment.md`](plans/10-deployment.md)).

## First release

The first router release was `0.1.0` (forced with `release-as` in `release-please-config.json`, since removed). From now on the version comes from the commits: a `feat` bumps the minor, a `fix` the patch, and a breaking change also the minor while the project is 0.x.

The browser image starts at `0.1.0` (`initial-version`). Its first release pull request lists every earlier commit that touched `images/browser`.

## One-time setup

- **Docker Hub:** create the access token (Account settings, Personal access tokens, read and write) and add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` as GitHub Actions secrets. The `notcheu/jobwatch-mcp` and `notcheu/jobwatch-browser` repositories can be created on Docker Hub in advance or by the first push.
- **GitHub namespace:** the repository lives in the `notcheu` organization, so the GHCR image is `ghcr.io/notcheu/jobwatch-mcp` (the workflow names it after the repository owner). Release-please needs *Settings, Actions, General, Allow GitHub Actions to create and approve pull requests* switched on, for the organization and for the repository.
- **Release pull request checks:** a pull request opened with the default `GITHUB_TOKEN` does not trigger other workflows, so CI does not run on the release pull request. If `main` requires the checks, add a personal access token (or GitHub App token) with `contents` and `pull requests` write access as the secret `RELEASE_PLEASE_TOKEN`.
- **Package visibility:** GHCR packages are private on first push: make the package public in its settings (organization, Packages, `jobwatch-mcp` and `jobwatch-browser`, Package settings, Change visibility), and link it to the repository.

## Notes

- `provenance: false` is kept on the router image build because Watchtower cannot resolve an image with a provenance attestation (see [`plans/10-deployment.md`](plans/10-deployment.md)). The browser image is built the same way, for a plain index. Without Watchtower in the picture it can be turned on, together with an SBOM.
- Images are not signed yet.
- The licence is [AGPL-3.0](../LICENSE): anyone running a modified version as a network service has to offer its source to the users of that service.

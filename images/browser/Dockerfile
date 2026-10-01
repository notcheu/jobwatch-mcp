# The browser image (05-browser-runtime.md): Xvfb + Google Chrome stable on amd64, Debian Chromium on arm64 (development only).
# Promoted from the Phase 0 spikes; build: docker build -t jobwatch-browser:dev images/browser
FROM debian:bookworm-slim
ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH
# amd64: Google Chrome stable. arm64 (e.g. Apple Silicon): Google ships no Linux arm64 Chrome, so Debian Chromium (development only, see 05).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg xvfb socat tzdata fonts-liberation procps x11vnc novnc websockify jq \
 && if [ "${TARGETARCH:-amd64}" = "amd64" ]; then \
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
      && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
      && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
      && ln -s /usr/bin/google-chrome-stable /usr/local/bin/chrome-bin; \
    else \
      apt-get install -y --no-install-recommends chromium && ln -s /usr/bin/chromium /usr/local/bin/chrome-bin; \
    fi \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 chrome && mkdir /profile && chown chrome:chrome /profile
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
USER chrome
ENV DISPLAY=:99 TZ=Europe/Paris SCREEN=1366x800x24 MODE=run CHROME_LANG=fr-FR ACCEPT_LANGS=fr-FR,fr,en-US,en
# No tini here: the runtime starts the container with --init.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Phase 0 spike S3/S7 image: Xvfb + Google Chrome stable (amd64). Not the production browser image (see 05-…).
FROM debian:bookworm-slim
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg xvfb socat tzdata fonts-liberation procps \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 chrome && mkdir /profile && chown chrome:chrome /profile
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
USER chrome
ENV DISPLAY=:99 TZ=Europe/Paris SCREEN=1366x800x24
# No tini here: the runtime starts the container with --init.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

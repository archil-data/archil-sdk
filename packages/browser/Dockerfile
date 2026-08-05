FROM node:24.18.0-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

COPY launcher.mjs /opt/archil-browser/launcher.mjs

ENV CHROMIUM_PATH=/usr/bin/chromium

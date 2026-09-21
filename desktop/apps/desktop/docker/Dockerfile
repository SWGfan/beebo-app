# Beebo Entertainment media server, headless. Build from desktop/apps/desktop:
#   docker buildx build -f docker/Dockerfile -t beebo-server .
# Multi-arch: --platform linux/amd64,linux/arm64
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --workspaces=false --ignore-scripts --no-audit --no-fund
WORKDIR /app/resources/beebo-rtc-host
COPY resources/beebo-rtc-host/package.json resources/beebo-rtc-host/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ffmpeg/ffprobe: the same LGPL build family as the Windows and Linux desktop apps
# (THIRD_PARTY_LICENSES/FFMPEG-SETUP.md). Pinned to a BtbN month-end autobuild,
# which the project keeps, and verified by SHA-256. To update, change the four
# FFMPEG_* values below (asset names and digests are on the release page).
FROM ${NODE_IMAGE} AS ffmpeg
ARG TARGETARCH
ARG FFMPEG_TAG=autobuild-2026-08-31-13-27
ARG FFMPEG_AMD64_FILE=ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-lgpl-8.1.tar.xz
ARG FFMPEG_AMD64_SHA256=7d6d93e9c39e0e461feb13c118e91e4eec2515e4da3a01d4ad6790996731bbee
ARG FFMPEG_ARM64_FILE=ffmpeg-n8.1.2-50-g1a748fe2cd-linuxarm64-lgpl-8.1.tar.xz
ARG FFMPEG_ARM64_SHA256=56b37b6f2832ba37bd4979ae5c4521ae718efa41846a0d3ecfbbe492137c66f6
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) file="${FFMPEG_AMD64_FILE}"; sha="${FFMPEG_AMD64_SHA256}" ;; \
      arm64) file="${FFMPEG_ARM64_FILE}"; sha="${FFMPEG_ARM64_SHA256}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o /tmp/ffmpeg.tar.xz "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_TAG}/${file}"; \
    echo "${sha}  /tmp/ffmpeg.tar.xz" | sha256sum -c -; \
    mkdir /ffmpeg; \
    tar -xJf /tmp/ffmpeg.tar.xz -C /ffmpeg --strip-components=1; \
    /ffmpeg/bin/ffmpeg -hide_banner -version | head -1; \
    /ffmpeg/bin/ffmpeg -hide_banner -encoders | grep -i openh264

FROM ${NODE_IMAGE}
ARG TARGETARCH
ARG BEEBO_VERSION=dev
LABEL org.opencontainers.image.title="Beebo Entertainment media server (headless)" \
      org.opencontainers.image.description="Home media server: movies, TV, music and photos, with a web viewer and admin." \
      org.opencontainers.image.version="${BEEBO_VERSION}" \
      org.opencontainers.image.licenses="LicenseRef-Proprietary; bundled FFmpeg is LGPL-2.1+"

# tini: init that forwards SIGTERM and reaps children (ffmpeg, the remote-access agent).
# util-linux gives setpriv for the PUID/PGID drop in docker-entrypoint.sh.
# Intel/AMD VA-API drivers (amd64 only) are what make --device /dev/dri hardware
# transcoding work; the BtbN ffmpeg loads libva at run time.
RUN set -eux; \
    apt-get update; \
    pkgs="tini ca-certificates util-linux"; \
    if [ "${TARGETARCH}" = "amd64" ]; then pkgs="${pkgs} libva2 libva-drm2 intel-media-va-driver mesa-va-drivers libmfx-gen1.2"; fi; \
    apt-get install -y --no-install-recommends ${pkgs}; \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOME=/tmp \
    BEEBO_IN_CONTAINER=1 \
    BEEBO_DATA_DIR=/config \
    BEEBO_MEDIA_ROOT=/media \
    BEEBO_PORT=47811 \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/resources/beebo-rtc-host/node_modules ./resources/beebo-rtc-host/node_modules
COPY package.json ./
COPY electron ./electron
COPY headless ./headless
COPY resources/beebo-rtc-host/beebo-rtc-host.js resources/beebo-rtc-host/beebo-game-client.js resources/beebo-rtc-host/package.json ./resources/beebo-rtc-host/
COPY resources/voice-samples ./resources/voice-samples
COPY resources/welcome-to-beebo.mp4 ./resources/
# (No mirror-app/ here any more: that folder is not part of the public source, so a COPY of it broke the
# public image build. GET /privacy serves the built-in generic notice when the policy file is absent.)
COPY android-app/version.json ./android-app/
COPY auto-app/version.json ./auto-app/
COPY THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES
COPY --from=ffmpeg /ffmpeg/bin/ffmpeg /ffmpeg/bin/ffprobe ./resources/ffmpeg/
COPY --from=ffmpeg /ffmpeg/LICENSE.txt ./THIRD_PARTY_LICENSES/ffmpeg/FFMPEG-BUILD-LICENSE.txt
COPY docker/docker-entrypoint.sh docker/healthcheck.js ./docker/
RUN chmod 0755 ./docker/docker-entrypoint.sh ./resources/ffmpeg/ffmpeg ./resources/ffmpeg/ffprobe \
    && mkdir -p /config /media \
    && chown node:node /config \
    && rm -rf /root/.npm

VOLUME ["/config"]
EXPOSE 47811/tcp
EXPOSE 47820-47829/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 CMD ["node", "/app/docker/healthcheck.js"]

USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/docker-entrypoint.sh"]
CMD ["node", "headless/main.js"]

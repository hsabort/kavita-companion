# Official 7-Zip static build: reads zip/rar/7z (Alpine's 7zip package has no RAR support) and
# writes zip. Version and checksum pinned; RAR code is under the unRAR license (extract only).
FROM node:24.21.0-alpine AS sevenzip
ARG SEVENZIP_URL=https://www.7-zip.org/a/7z2601-linux-x64.tar.xz
ARG SEVENZIP_SHA256=8ea0fc8a135e7b848e80a4116fe22dff56c8c4518dde1f43cce67f4e340b437a
RUN apk add --no-cache tar xz \
 && wget -qO /tmp/7z.tar.xz "$SEVENZIP_URL" \
 && echo "$SEVENZIP_SHA256  /tmp/7z.tar.xz" | sha256sum -c - \
 && mkdir /7z && tar -xJf /tmp/7z.tar.xz -C /7z 7zzs License.txt

FROM node:24.21.0-alpine AS build
WORKDIR /app
COPY kavita-companion/package.json kavita-companion/package-lock.json ./
RUN npm ci --ignore-scripts
COPY kavita-companion/tsconfig.json kavita-companion/build-web.mjs ./
COPY kavita-companion/src ./src
COPY kavita-companion/web ./web
COPY kavita-companion/public ./public
RUN npm run build

FROM node:24.21.0-alpine
# The image is a combined work, so this label names every licence it actually contains — it is NOT
# "Apache-2.0" alone. Apache-2.0 is this repository's own code; GPL-3.0-only is KindleUnpack and
# LGPL-2.1-or-later (with the unRAR restriction) is 7-Zip, both bundled below; OFL-1.1 is the fonts.
LABEL org.opencontainers.image.title="kavita-companion" \
      org.opencontainers.image.licenses="Apache-2.0 AND GPL-3.0-only AND LGPL-2.1-or-later AND OFL-1.1"
WORKDIR /app
ENV NODE_ENV=production
# Apache-2.0 section 4(a) requires the licence to travel with a distribution, and the GPL-3.0-only
# KindleUnpack below requires its own licence text. The build context is the repository root so both
# can be copied from their single source of truth; 7-Zip's and the fonts' texts come with their own
# payloads.
COPY LICENSE NOTICE.md /usr/local/share/doc/kavita-companion/
COPY --from=sevenzip /7z/7zzs /usr/local/bin/7zzs
COPY --from=sevenzip /7z/License.txt /usr/local/share/doc/7zip/License.txt
# KindleUnpack (the `mobi` package, GPL-3.0) converts MOBI/AZW book uploads to EPUB; see NOTICE.md.
# It goes into its own venv (Alpine's system pip is externally-managed, PEP 668) and onto PATH so the
# server can spawn `mobiunpack`. mobi imports only the stdlib plus loguru and standard-imghdr, so after
# the install the
# venv drops pip, setuptools and the packages pip seeds: none are used at runtime, and Trivy flags the
# advisories in pip's and setuptools' own vendored copies (msgpack, urllib3, jaraco.context, wheel).
# The system pip goes too, so the runtime image carries no pip at all.
RUN apk add --no-cache python3 py3-pip \
 && python3 -m venv /opt/kindleunpack \
 && /opt/kindleunpack/bin/pip install --no-cache-dir mobi==0.4.1 \
 && mkdir -p /usr/local/share/doc/kindleunpack \
 && cp /opt/kindleunpack/lib/python*/site-packages/mobi-0.4.1.dist-info/licenses/LICENSE \
       /usr/local/share/doc/kindleunpack/LICENSE \
 && rm -rf /opt/kindleunpack/lib/python*/site-packages/pip* \
           /opt/kindleunpack/lib/python*/site-packages/setuptools* \
           /opt/kindleunpack/lib/python*/site-packages/wheel* \
           /opt/kindleunpack/lib/python*/site-packages/msgpack* \
           /opt/kindleunpack/lib/python*/site-packages/urllib3* \
           /opt/kindleunpack/bin/pip* \
 && apk del py3-pip \
 && rm -rf /root/.cache /tmp/*
ENV PATH=/opt/kindleunpack/bin:$PATH
COPY kavita-companion/package.json kavita-companion/package-lock.json ./
# npm is only needed to install dependencies; the server runs `node dist/server.js`. Dropping the CLI
# after the install takes the base image's bundled npm (and its own dependencies) out of the runtime
# image, which is what Trivy otherwise flags as HIGH.
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "dist/server.js"]

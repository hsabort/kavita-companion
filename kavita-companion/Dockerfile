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
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json build-web.mjs ./
COPY src ./src
COPY web ./web
COPY public ./public
RUN npm run build

FROM node:24.21.0-alpine
LABEL org.opencontainers.image.title="kavita-companion" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=sevenzip /7z/7zzs /usr/local/bin/7zzs
COPY --from=sevenzip /7z/License.txt /usr/local/share/doc/7zip/License.txt
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "dist/server.js"]

# photomap has no dependencies to install and nothing to build, so this is
# just Node plus the source.
FROM node:22-alpine

RUN apk add --no-cache wget

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

# Writable spot for the geocode cache; owned by the user we drop to below.
RUN mkdir -p /data && chown -R node:node /data /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    CACHE_DIR=/data

USER node
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["node", "server.js"]

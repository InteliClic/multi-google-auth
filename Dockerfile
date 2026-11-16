# multi-google-auth in hub mode: read-only MCP over Streamable HTTP, served on
# 127.0.0.1 behind a Cloudflare Tunnel. Nothing is exposed by default; run it with
# host networking (see deploy/docker-compose.example.yml).
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY accounts.json ./

# Tokens, keys and logs live under HUB_DATA_DIR (a bind mount), never in the image.
ENV HUB_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data

USER node
CMD ["node", "src/index.js", "--http"]

# Node 24 ships a stable built-in node:sqlite, so there's no native module to
# compile — a single slim stage is all we need. Works on amd64 and arm64 NUCs.

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/logs.db
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]

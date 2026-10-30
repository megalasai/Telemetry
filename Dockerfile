# Standalone image. Build from this repo root (not Digi-Switchride):
#   docker compose up -d --build
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=768
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=512
ENV TELEMETRY_HTTP_HOST=0.0.0.0
ENV TELEMETRY_HTTP_PORT=4200
ENV TELEMETRY_TCP_HOST=0.0.0.0
ENV TELEMETRY_SQLITE=/data/telemetry.sqlite
ENV WANWAY_TCP_ENABLED=true
ENV WANWAY_TCP_HOST=0.0.0.0
ENV WANWAY_TCP_PORTS=21100,5001,8821
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
VOLUME ["/data"]
EXPOSE 4200 4210 21100 5001 8821
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TELEMETRY_HTTP_PORT||4200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/entrypoint.js"]

# Droplet build: copies precompiled dist (no TypeScript, no npm ci).
#   git clone https://github.com/megalasai/Telemetry.git && docker compose up -d --build
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_MAXSOCKETS=1
ENV NODE_OPTIONS=--max-old-space-size=384
ENV TELEMETRY_HTTP_HOST=0.0.0.0
ENV TELEMETRY_HTTP_PORT=4200
ENV TELEMETRY_TCP_HOST=0.0.0.0
ENV TELEMETRY_SQLITE=/data/telemetry.sqlite
ENV WANWAY_TCP_ENABLED=true
ENV WANWAY_TCP_HOST=0.0.0.0
ENV WANWAY_TCP_PORTS=21100,5001,8821
COPY package.runtime.json package.json
RUN npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --maxsockets=1
COPY dist ./dist
VOLUME ["/data"]
EXPOSE 4200 4210 21100 5001 8821
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TELEMETRY_HTTP_PORT||4200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/entrypoint.js"]

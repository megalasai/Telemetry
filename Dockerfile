FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV TELEMETRY_HTTP_HOST=0.0.0.0
ENV TELEMETRY_HTTP_PORT=4200
ENV TELEMETRY_TCP_HOST=0.0.0.0
ENV TELEMETRY_SQLITE=/data/telemetry.sqlite
ENV WANWAY_TCP_ENABLED=true
ENV WANWAY_TCP_HOST=0.0.0.0
ENV WANWAY_TCP_PORTS=21100,5001,8821
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
VOLUME ["/data"]
EXPOSE 4200 4210 21100 5001 8821
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TELEMETRY_HTTP_PORT||4200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/entrypoint.js"]

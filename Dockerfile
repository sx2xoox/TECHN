# ISOMORPH 컨테이너
#   docker build -t isomorph .
#   docker run --rm -p 4000:4000 -e ISOMORPH_TOKEN=<운영자 토큰> isomorph connect postgres://user:pass@db:5432/app --host 0.0.0.0
#   docker run --rm -p 4000:4000 -p 4318:4318 -e ISOMORPH_TOKEN=<토큰> -e ISOMORPH_OTLP_TOKEN=<수신 토큰> isomorph   (기본: OpenTelemetry 수신)
# 컨테이너 밖에서 보려면 0.0.0.0 으로 들어야 하고, 그러면 접근 토큰이 필수다(없으면 시작을 거부한다).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/compiler/package.json packages/compiler/
COPY packages/adapters/package.json packages/adapters/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/assets/package.json packages/assets/
COPY apps/demo-shop/package.json apps/demo-shop/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 4000 4318 4100
ENTRYPOINT ["node", "--import", "tsx", "packages/server/src/cli.ts"]
CMD ["connect", "otel", "--host", "0.0.0.0"]

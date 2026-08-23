# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS web-build
WORKDIR /workspace/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
RUN npm run build

FROM gradle:8.14.3-jdk21 AS backend-build
WORKDIR /workspace
COPY settings.gradle.kts build.gradle.kts gradle.properties ./
COPY backend/build.gradle.kts backend/build.gradle.kts
RUN --mount=type=cache,target=/home/gradle/.gradle/caches,uid=1000,gid=1000 \
    gradle --no-daemon :backend:dependencies
COPY backend/ backend/
COPY --from=web-build /workspace/web/dist/ backend/src/main/resources/web/
RUN --mount=type=cache,target=/home/gradle/.gradle/caches,uid=1000,gid=1000 \
    gradle --no-daemon :backend:buildFatJar

FROM eclipse-temurin:21-jre-noble AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 review-engine \
    && useradd --system --uid 10001 --gid review-engine --home-dir /app --shell /usr/sbin/nologin review-engine \
    && mkdir -p /app /data \
    && chown -R review-engine:review-engine /app /data

WORKDIR /app
COPY --from=backend-build --chown=review-engine:review-engine \
    /workspace/backend/build/libs/review-engine.jar /app/review-engine.jar

ENV REVIEW_HTTP_HOST=0.0.0.0 \
    REVIEW_HTTP_PORT=8080 \
    REVIEW_DATABASE_PATH=/data/review-engine.db \
    REVIEW_PICTURE_PATH=/data/review-pictures \
    REVIEW_UI_ENABLED=true

USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD curl --fail --silent --show-error http://127.0.0.1:8080/api/v1/health/ready || exit 1

ENTRYPOINT ["java", "-jar", "/app/review-engine.jar"]

# Build from the repository root: `docker build -f service/Dockerfile .`
# The service needs only its own folder plus two files from app/ (shared code and the sandbox module).
FROM node:24-slim AS build
WORKDIR /src/service
COPY service/package.json service/package-lock.json ./
# Optional deps stay so esbuild gets its linux binary.
RUN npm ci --ignore-scripts
COPY service/src ./src
COPY app/shared ./shared
COPY app/electron/sandbox.ts ./electron/sandbox.ts
RUN npx esbuild src/main.ts --bundle --platform=node --target=node22 --format=cjs --outfile=/out/farol-service.cjs

FROM node:24-slim
# The service reads .farol/pipelines.json out of each upload with tar, and drives Railway Sandboxes through the CLI.
RUN apt-get update && apt-get install -y --no-install-recommends tar ca-certificates && rm -rf /var/lib/apt/lists/* \
  && npm install -g @railway/cli && npm cache clean --force
WORKDIR /srv
COPY --from=build /out/farol-service.cjs ./
ENV FAROL_KEYS_FILE=/data/farol-keys.json FAROL_USERS_FILE=/data/farol-users.json
EXPOSE 8787
CMD ["node", "farol-service.cjs"]

# Build from app/: `docker build .` Railway auto-detects this file at the upload root.
FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Optional deps stay so esbuild gets its linux binary.
RUN npm ci --ignore-scripts
COPY shared ./shared
COPY electron ./electron
COPY service ./service
RUN npx esbuild service/main.ts --bundle --platform=node --target=node22 --format=cjs --outfile=/out/farol-service.cjs

FROM node:24-slim
# The service reads .farol/pipelines.json out of each upload with tar, and drives Railway Sandboxes through the CLI.
RUN apt-get update && apt-get install -y --no-install-recommends tar ca-certificates && rm -rf /var/lib/apt/lists/* \
  && npm install -g @railway/cli && npm cache clean --force
WORKDIR /srv
COPY --from=build /out/farol-service.cjs ./
ENV FAROL_KEYS_FILE=/data/farol-keys.json FAROL_USERS_FILE=/data/farol-users.json
EXPOSE 8787
CMD ["node", "farol-service.cjs"]

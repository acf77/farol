# Build the bundle first: `npm run service:build` (from app/), then build with app/service as the context.
FROM node:24-slim
# The service reads .farol/pipelines.json out of each upload with tar.
RUN apt-get update && apt-get install -y --no-install-recommends tar && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY dist/farol-service.cjs ./
ENV FAROL_KEYS_FILE=/data/farol-keys.json
VOLUME /data
EXPOSE 8787
CMD ["node", "farol-service.cjs"]

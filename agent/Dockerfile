FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends tar \
  && rm -rf /var/lib/apt/lists/*

COPY agent/package.json ./package.json
RUN npm install --omit=dev

COPY agent/src ./src
COPY eggs ./eggs

ENV NODE_ENV=production
ENV EGGS_FILE=/app/eggs/index.json
EXPOSE 8080

CMD ["node", "src/index.js"]

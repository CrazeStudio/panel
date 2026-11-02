FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY panel/package.json ./package.json
RUN npm install --omit=dev

COPY panel/src ./src
COPY panel/public ./public
COPY eggs ./eggs

ENV NODE_ENV=production
ENV EGGS_FILE=/app/eggs/index.json
EXPOSE 3000

CMD ["node", "src/index.js"]

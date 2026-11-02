FROM node:22-bookworm-slim

WORKDIR /app

COPY agent/package.json ./package.json
RUN npm install --omit=dev

COPY agent/src ./src
COPY eggs ./eggs

ENV NODE_ENV=production
ENV EGGS_FILE=/app/eggs/index.json
EXPOSE 8080

CMD ["node", "src/index.js"]

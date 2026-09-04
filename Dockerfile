FROM node:22-slim

ENV NODE_ENV=production \
    DOWNLOAD_DIR=/tmp/tg-downloads

WORKDIR /srv

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 8000
CMD ["node", "src/server.js"]

FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV PORT=5230
EXPOSE 5230
CMD ["node", "server.js"]

FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /app/data

ENV PORT=3456
ENV DATA_DIR=/app/data

EXPOSE 3456

CMD ["node", "server.js"]

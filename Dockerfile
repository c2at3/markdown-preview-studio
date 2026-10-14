FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /app/data/uploads

ENV PORT=3456
EXPOSE 3456

CMD ["node", "server.js"]

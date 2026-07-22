FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY public ./public

RUN mkdir -p /app/data

ENV PORT=3456
ENV DB_PATH=/app/data/markdown.db

EXPOSE 3456

CMD ["node", "server.js"]

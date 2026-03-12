FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src/ ./src/
COPY .env ./

# Apps directory will be mounted as a shared volume
RUN mkdir -p /var/www/apps

ENV APPS_DIR=/var/www/apps
ENV STATE_FILE=/app/state.json

CMD ["node", "src/index.js"]

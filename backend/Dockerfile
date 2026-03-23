FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY src ./src
RUN chown -R 1000:1000 /app
EXPOSE 3000
CMD ["node", "src/server.js"]

FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app
COPY package.json server.js ./
RUN npm install

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]

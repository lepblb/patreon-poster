FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app
COPY package.json server.js ./
RUN npm install

# Chromium is already installed in this base image
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]

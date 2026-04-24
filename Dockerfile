FROM node:20-alpine

WORKDIR /app

# Copy dependency files
COPY package*.json ./

RUN npm install --omit=dev --legacy-peer-deps


# Copy source code
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]

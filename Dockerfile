FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=6009
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Secrets không nằm trong image: .env qua --env-file, private key + data qua volume
RUN mkdir -p keys data
EXPOSE 6009
CMD ["node", "dist/server.js"]

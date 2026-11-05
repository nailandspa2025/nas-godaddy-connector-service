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
# config.ts nạp .env.${NODE_ENV} → .env.production (biến truyền qua --env-file/-e vẫn được ưu tiên)
# .env.production chỉ chứa cấu hình không bí mật. Secrets (POYNT_APPLICATION_ID, ADMIN_API_KEY, DATABASE_URL)
# truyền qua --env-file; private key Poynt mount qua volume ./keys (xem .github/workflows/deploy.yml)
COPY .env.production ./
RUN mkdir -p keys data
EXPOSE 6009
CMD ["node", "dist/server.js"]

FROM node:22-bookworm-slim

WORKDIR /app
RUN npm install --global pnpm@9.12.0

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=demo-bank

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

EXPOSE 3000
WORKDIR /app/apps/demo-bank
CMD ["pnpm", "start"]

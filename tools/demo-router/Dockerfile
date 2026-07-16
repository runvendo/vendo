FROM node:22-bookworm-slim

# Build context is the REPO ROOT: `railway up` archives the git root, and the
# service's RAILWAY_DOCKERFILE_PATH points here. Copy only the router.
WORKDIR /app
COPY tools/demo-router/ .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["node", "server.mjs"]

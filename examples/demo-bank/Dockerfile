FROM node:22-bookworm-slim

WORKDIR /app
# The npm bundled in this base image (10.9.8) carries tar 7.5.11 —
# CVE-2026-59873, critical, patched in 7.5.19. Bumping the base image tag does
# NOT fix it: node 22/24/25 on bookworm and trixie bundle 7.5.11 or 7.5.16, all
# below the patch. npm 10.9.9 is one patch up on the image's own line and
# bundles tar 7.5.22 — the version this repo's lockfile already resolves.
# Drop this line once a node:22 tag ships npm >=10.9.9.
RUN npm install --global npm@10.9.9 && npm install --global pnpm@11.10.0

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=demo-bank

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

EXPOSE 3000
WORKDIR /app/examples/demo-bank
CMD ["pnpm", "start"]

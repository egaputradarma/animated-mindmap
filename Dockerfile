# Production image: build the SPA, then serve the static output from nginx.
#
# Two stages so the runtime image carries no Node, no npm and no source — just nginx and the
# built assets, which is the difference between roughly 60 MB and 1.2 GB. It also means starting
# the container is only nginx booting, with no build or install step, which is the point of
# running it this way at all.

# ── Stage 1: build ──
# node:22 rather than 24 to match the toolchain in the sibling ea-architecture-app repo. Vite 8
# needs 20.19+/22.12+, which this satisfies.
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Manifests first, as their own layer. Docker then reuses the (slow) install whenever only
# source has changed, which is the common case.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# `npm run build` is `tsc -b && vite build`, so a type error fails the image build rather than
# shipping a broken bundle. Worth the extra seconds here.
RUN npm run build

# ── Stage 2: serve ──
FROM nginx:1.27-alpine AS serve

# Replaces the stock server block; see nginx.conf for the SPA fallback and caching rules.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# Health is "does the app's entry point actually serve", not "is the process alive" — nginx can
# be running happily with a broken root. wget comes from BusyBox in the alpine base; there is no
# curl in this image.
#
# 127.0.0.1 rather than `localhost`: inside the container `localhost` resolves to ::1 first, but
# nginx's `listen 80` binds IPv4 only, so the probe gets ECONNREFUSED and the container reports
# unhealthy while serving external traffic perfectly well.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1

# The official image's own CMD already runs nginx in the foreground as PID 1, so it receives
# SIGTERM directly and shuts down cleanly on `docker compose stop`.
CMD ["nginx", "-g", "daemon off;"]

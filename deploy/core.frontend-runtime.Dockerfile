# Org Pulse Core — Frontend Runtime
#
# Hardened nginx image with default config. No app code — consumers
# COPY their built dist/ into /usr/share/nginx/html.
#
# Used as the final stage in multi-stage frontend builds:
#
#   FROM quay.io/org-pulse/org-pulse-core-frontend-runtime:v1.x
#   COPY --from=build /app/dist /usr/share/nginx/html

FROM registry.access.redhat.com/hi/nginx:latest

COPY deploy/nginx-default.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

FROM nginxinc/nginx-unprivileged:1.27-alpine

ENV WAHA_UPSTREAM=waha:3000

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY index.html app.js styles.css /usr/share/nginx/html/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

FROM mcr.microsoft.com/playwright:v1.55.0-noble

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      dbus-x11 dumb-init fluxbox fonts-noto-cjk novnc websockify x11vnc xvfb \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_PATH=/app/storage \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY start-collector.sh /usr/local/bin/start-collector.sh
RUN mkdir -p /app/storage/browser-profile /app/storage/captures \
    && chmod 0755 /usr/local/bin/start-collector.sh \
    && chown -R pwuser:pwuser /app

USER pwuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/usr/local/bin/start-collector.sh"]

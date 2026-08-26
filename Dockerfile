FROM mcr.microsoft.com/playwright:v1.55.0-noble

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_PATH=/app/storage \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
RUN mkdir -p /app/storage/browser-profile /app/storage/captures \
    && chown -R pwuser:pwuser /app

USER pwuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]

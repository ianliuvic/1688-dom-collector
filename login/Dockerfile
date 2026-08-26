FROM mcr.microsoft.com/playwright:v1.55.0-noble

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    XDG_RUNTIME_DIR=/tmp/browser-runtime \
    PROFILE_PATH=/app/storage/browser-profile

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      apache2-utils \
      curl \
      dbus-x11 \
      dumb-init \
      fluxbox \
      fonts-noto-cjk \
      nginx \
      novnc \
      websockify \
      x11vnc \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY nginx.conf /etc/nginx/nginx.conf
COPY start-login.sh /usr/local/bin/start-login.sh
RUN chmod 0755 /usr/local/bin/start-login.sh \
    && mkdir -p /app/storage /tmp/browser-runtime \
    && chown -R pwuser:pwuser /app/storage /tmp/browser-runtime

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/start-login.sh"]

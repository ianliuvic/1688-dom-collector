import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { startProxyAdapter } from './proxy.js';

function waitForExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

export function createLoginManager({
  storagePath,
  navigationTimeoutMs,
  proxyServer,
  proxyUsername,
  proxyPassword,
  display = process.env.DISPLAY || ':99',
  startUrl = process.env.LOGIN_START_URL || 'https://login.1688.com/member/signin.htm',
}) {
  const profilePath = path.join(storagePath, 'browser-profile');
  const storageStatePath = path.join(storagePath, 'storage-state.json');
  let context = null;
  let proxyAdapter = null;
  let stateTimer = null;
  let children = [];
  let state = 'stopped';
  let lastError = null;

  function spawnService(command, args) {
    const child = spawn(command, args, {
      env: { ...process.env, DISPLAY: display },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) process.stderr.write(`[login:${path.basename(command)}] ${message}\n`);
    });
    children.push(child);
    return child;
  }

  async function saveStorageState() {
    if (context) await context.storageState({ path: storageStatePath });
  }

  async function start() {
    if (state === 'running') return;
    if (state !== 'stopped') throw new Error(`Login browser cannot start while state is ${state}.`);
    state = 'starting';
    lastError = null;
    try {
      await fs.mkdir(profilePath, { recursive: true });
      await Promise.all(['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map((name) =>
        fs.rm(path.join(profilePath, name), { force: true, recursive: true })));

      spawnService('fluxbox', []);
      spawnService('x11vnc', [
        '-display', display, '-rfbport', '5900', '-localhost', '-forever', '-shared', '-nopw',
      ]);
      spawnService('websockify', [
        '--web=/usr/share/novnc', '127.0.0.1:6080', '127.0.0.1:5900',
      ]);

      proxyAdapter = await startProxyAdapter(proxyServer, proxyUsername, proxyPassword);
      context = await chromium.launchPersistentContext(profilePath, {
        headless: false,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        viewport: { width: 1400, height: 940 },
        args: ['--disable-dev-shm-usage', '--password-store=basic'],
        ...(proxyAdapter ? { proxy: proxyAdapter.playwrightProxy } : {}),
      });
      const page = context.pages()[0] ?? await context.newPage();
      page.setDefaultNavigationTimeout(navigationTimeoutMs);
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch((error) => {
        lastError = `Initial page navigation failed: ${error.message}`;
      });
      stateTimer = setInterval(() => saveStorageState().catch((error) => {
        lastError = `Storage state export failed: ${error.message}`;
      }), 10000);
      state = 'running';
    } catch (error) {
      lastError = error.message;
      await stop();
      throw error;
    }
  }

  async function stop() {
    if (state === 'stopped') return;
    state = 'stopping';
    clearInterval(stateTimer);
    stateTimer = null;
    await saveStorageState().catch(() => {});
    await context?.close().catch(() => {});
    context = null;
    await proxyAdapter?.close().catch(() => {});
    proxyAdapter = null;
    await Promise.all(children.reverse().map((child) => waitForExit(child)));
    children = [];
    state = 'stopped';
  }

  function getStatus() {
    return { state, ready: state === 'running', startUrl, lastError };
  }

  return { start, stop, getStatus };
}

import crypto from 'node:crypto';
import Fastify from 'fastify';
import { createDatabase } from './db.js';
import { createCollector, isAllowed1688Url } from './collector.js';

const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  adminApiKey: process.env.ADMIN_API_KEY,
  storagePath: process.env.STORAGE_PATH ?? '/app/storage',
  minCaptureIntervalMs: Number(process.env.MIN_CAPTURE_INTERVAL_MS ?? 15000),
  navigationTimeoutMs: Number(process.env.NAVIGATION_TIMEOUT_MS ?? 45000),
};

if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
if (!config.adminApiKey) throw new Error('ADMIN_API_KEY is required');

const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 1024 * 1024 });
const db = createDatabase(config.databaseUrl);
const collector = createCollector(config);
let workerRunning = true;

function requireApiKey(request, reply, done) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const expected = config.adminApiKey;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length
      || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  done();
}

app.get('/', async () => ({
  name: '1688 DOM Collector',
  status: 'framework-ready',
  session: collector.getSessionStatus(),
}));

app.get('/health', async (_request, reply) => {
  try {
    await db.ping();
    return { ok: true };
  } catch (error) {
    reply.code(503);
    return { ok: false, error: error.message };
  }
});

app.get('/api/session', { preHandler: requireApiKey }, async () => collector.getSessionStatus());

app.post('/api/jobs', { preHandler: requireApiKey }, async (request, reply) => {
  const url = request.body?.url;
  if (typeof url !== 'string' || !isAllowed1688Url(url)) {
    return reply.code(400).send({ error: 'A valid HTTPS URL under 1688.com is required.' });
  }
  const job = await db.createJob(crypto.randomUUID(), url);
  return reply.code(202).send(job);
});

app.get('/api/jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = await db.getJob(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

async function workerLoop() {
  while (workerRunning) {
    const job = await db.claimNextJob();
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    try {
      const result = await collector.capture(job);
      await db.completeJob(job.id, result);
    } catch (error) {
      app.log.error({ err: error, jobId: job.id }, 'capture failed');
      await db.completeJob(job.id, {
        status: 'failed', title: null, finalUrl: null, domPath: null,
        screenshotPath: null, error: error.message,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, config.minCaptureIntervalMs));
  }
}

async function shutdown() {
  workerRunning = false;
  await collector.stop();
  await db.pool.end();
  await app.close();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await db.migrate();
await collector.start();
await app.listen({ port: config.port, host: '0.0.0.0' });
workerLoop().catch((error) => {
  app.log.fatal(error, 'worker stopped');
  process.exitCode = 1;
});

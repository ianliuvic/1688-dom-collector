import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PLUGIN_VERSION = '1.1.9';

const AES_KEY = Buffer.from('ABCD16881688ABCD', 'ascii');
const AES_IV = Buffer.from('1688168816881688', 'ascii');
const TOKEN_REFRESH_AGE_MS = 18 * 60 * 1000;

export function encryptPluginPayload(payload) {
  const cipher = crypto.createCipheriv('aes-128-ofb', AES_KEY, AES_IV);
  return Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]).toString('base64');
}

export function buildHeartbeatRequest(uuid, version = PLUGIN_VERSION, timestamp = Date.now()) {
  return encryptPluginPayload({ uuid, version, timestamp });
}

export function buildExtensionSecret({ token, version, uuid }, dataText) {
  const digestCode = crypto.createHmac('sha256', token).update(dataText).digest('base64');
  return encryptPluginPayload({ token, version, uuid, digestCode });
}

function newPluginUuid() {
  return crypto.randomBytes(8).toString('hex');
}

export function createPluginCrypto({ storagePath, refreshToken }) {
  const identityPath = path.join(storagePath, 'plugin-crypto-identity.json');
  let identityPromise;
  let tokenState = null;

  async function loadIdentity() {
    if (!identityPromise) {
      identityPromise = (async () => {
        try {
          const stored = JSON.parse(await fs.readFile(identityPath, 'utf8'));
          if (typeof stored.uuid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(stored.uuid)) {
            return { uuid: stored.uuid, version: PLUGIN_VERSION };
          }
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }

        const identity = { uuid: newPluginUuid(), version: PLUGIN_VERSION };
        await fs.mkdir(storagePath, { recursive: true });
        await fs.writeFile(identityPath, JSON.stringify(identity, null, 2), { mode: 0o600 });
        return identity;
      })();
    }
    return identityPromise;
  }

  async function getToken({ context, page, force = false }) {
    const identity = await loadIdentity();
    const now = Date.now();
    if (!force && tokenState && now - tokenState.issuedAt < TOKEN_REFRESH_AGE_MS) {
      return { ...identity, token: tokenState.token };
    }

    const issuedAt = Date.now();
    const heartbeatRequest = buildHeartbeatRequest(identity.uuid, identity.version, issuedAt);
    const token = await refreshToken({ context, page, heartbeatRequest });
    if (typeof token !== 'string' || token.length < 32) {
      throw new Error('The 1688 plugin heartbeat response did not contain a valid token.');
    }
    tokenState = { token, issuedAt };
    return { ...identity, token };
  }

  function clearToken() {
    tokenState = null;
  }

  return { getToken, clearToken };
}

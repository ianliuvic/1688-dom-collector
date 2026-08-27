import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  buildExtensionSecret,
  buildHeartbeatRequest,
  encryptPluginPayload,
} from '../src/plugin-crypto.js';

const KEY = Buffer.from('ABCD16881688ABCD', 'ascii');
const IV = Buffer.from('1688168816881688', 'ascii');

function decrypt(value) {
  const decipher = crypto.createDecipheriv('aes-128-ofb', KEY, IV);
  return Buffer.concat([
    decipher.update(Buffer.from(value, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

test('heartbeat request encrypts the ordered uuid/version/timestamp payload', () => {
  const encrypted = buildHeartbeatRequest('KCRBCUff8aV3vKu3', '1.1.9', 1787837325280);
  assert.deepEqual(JSON.parse(decrypt(encrypted)), {
    uuid: 'KCRBCUff8aV3vKu3',
    version: '1.1.9',
    timestamp: 1787837325280,
  });
});

test('extension secret contains the request-bound HMAC digest', () => {
  const dataText = JSON.stringify({
    memberId: 'b2b-2216582411549dd3f3',
    sortType: 'wangpu_score',
    pageNum: 1,
    pageSize: 300,
  });
  const meta = {
    token: 'temporary-token-value',
    version: '1.1.9',
    uuid: 'KCRBCUff8aV3vKu3',
  };
  const decrypted = JSON.parse(decrypt(buildExtensionSecret(meta, dataText)));
  assert.deepEqual(decrypted, {
    ...meta,
    digestCode: crypto.createHmac('sha256', meta.token).update(dataText).digest('base64'),
  });
});

test('plugin encryption is deterministic for an identical payload', () => {
  const payload = { uuid: 'abc12345', version: '1.1.9', timestamp: 1 };
  assert.equal(encryptPluginPayload(payload), encryptPluginPayload(payload));
});

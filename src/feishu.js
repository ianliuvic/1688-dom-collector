// Minimal Feishu (Lark) notifier: tenant_access_token + text messages to one
// configured group chat. Credentials come from the runtime environment.

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
let tokenCache = { token: '', expiresAt: 0 };

export function feishuConfigured(config = {}) {
  return Boolean(config.feishuAppId && config.feishuAppSecret && config.feishuChatId);
}

async function tenantToken(config) {
  if (tokenCache.token && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.token;
  const response = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: config.feishuAppId, app_secret: config.feishuAppSecret }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || Number(body.code) !== 0 || !body.tenant_access_token) {
    throw new Error(`Feishu token failed (HTTP ${response.status}, code ${body?.code ?? '?'}).`);
  }
  tokenCache = {
    token: String(body.tenant_access_token),
    expiresAt: Date.now() + (Number(body.expire) || 7200) * 1000,
  };
  return tokenCache.token;
}

export async function sendFeishuText({ text, config }) {
  if (!feishuConfigured(config)) throw new Error('Feishu is not configured.');
  const token = await tenantToken(config);
  const response = await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      receive_id: config.feishuChatId,
      msg_type: 'text',
      content: JSON.stringify({ text: String(text || '').slice(0, 4000) }),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || Number(body.code) !== 0) {
    throw new Error(`Feishu send failed (HTTP ${response.status}, code ${body?.code ?? '?'}).`);
  }
  return { messageId: body.data?.message_id ?? null };
}

/** Notify the group that a newly captured product was judged a bundle. */
export async function notifyBundleCapture({ detailId, title, options, reason, config }) {
  const colourText = (options ?? []).map((value) => String(value)).filter(Boolean).slice(0, 12).join(' / ');
  const lines = [
    '⚠️ 新采集商品判定为「捆绑」（LLM 语义判定）',
    `标题：${String(title || '(无标题)').slice(0, 90)}`,
    colourText ? `颜色选项：${colourText}` : null,
    reason ? `理由：${String(reason).slice(0, 180)}` : null,
    `商品列表：#${detailId} · https://collector.yiswim.cloud/products`,
  ].filter(Boolean);
  return sendFeishuText({ text: lines.join('\n'), config });
}

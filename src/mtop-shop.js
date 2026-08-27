import crypto from 'node:crypto';

const APP_KEY = '12574478';
const PLUGIN_ORIGIN = 'https://air.1688.com';
const SHOP_API = 'mtop.1688.pc.plugin.shop.offerlist.query';
const SHOP_VERSION = '1.1';
const LOGIN_API = 'mtop.1688.pc.plugin.user.login.get';
const LOGIN_VERSION = '1.0';

function tokenValue(cookies) {
  const cookie = cookies.find((item) => item.name === '_m_h5_tk');
  return cookie?.value?.split('_')[0] ?? '';
}

function signedUrl(token, api, version, data) {
  const timestamp = String(Date.now());
  const dataText = JSON.stringify(data);
  const sign = crypto.createHash('md5')
    .update(`${token}&${timestamp}&${APP_KEY}&${dataText}`)
    .digest('hex');
  const params = new URLSearchParams({
    jsv: '2.7.2', appKey: APP_KEY, t: timestamp, sign,
    dataType: 'json', api, v: version, type: 'originaljson', data: dataText,
  });
  return `https://h5api.m.1688.com/h5/${api}/${version}/?${params}`;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The 1688 MTop endpoint returned a non-JSON response.');
  }
}

function retMessages(payload) {
  return Array.isArray(payload?.ret) ? payload.ret.map(String) : [];
}

function isSuccess(payload) {
  const messages = retMessages(payload);
  return messages.length === 0 || messages.some((message) => message.startsWith('SUCCESS'));
}

function shouldRefreshToken(payload) {
  return retMessages(payload).some((message) => /TOKEN|ILLEGAL_ACCESS|SESSION/i.test(message));
}

async function callMtop({ context, page, api, version, data, extraHeaders = {} }) {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  let payload;
  let httpStatus;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cookies = await context.cookies('https://h5api.m.1688.com');
    const response = await context.request.get(
      signedUrl(tokenValue(cookies), api, version, data),
      {
        headers: {
          accept: '*/*',
          origin: PLUGIN_ORIGIN,
          referer: `${PLUGIN_ORIGIN}/`,
          'user-agent': userAgent,
          ...extraHeaders,
        },
        timeout: 30000,
      },
    );
    httpStatus = response.status();
    payload = parseJson(await response.text());
    if (isSuccess(payload)) return payload;
    if (attempt === 0 && shouldRefreshToken(payload)) continue;
    throw new Error(`1688 MTop rejected the request: ${retMessages(payload).join('; ') || httpStatus}`);
  }

  throw new Error(`1688 MTop request failed: ${retMessages(payload).join('; ') || httpStatus}`);
}

function findOfferArray(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    if (value.some((item) => item && typeof item === 'object' && 'offerId' in item)) return value;
    for (const item of value) {
      const found = findOfferArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const child of Object.values(value)) {
    const found = findOfferArray(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function findTotal(value, depth = 0) {
  if (depth > 8 || value == null || typeof value !== 'object') return null;
  for (const key of ['totalCount', 'total', 'offerCount', 'totalNum']) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  for (const child of Object.values(value)) {
    const found = findTotal(child, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

export async function fetchShopOfferPage({
  context, page, extensionSecret, memberId, pageNum, pageSize, sortType,
}) {
  if (!extensionSecret) {
    throw new Error('PLUGIN_EXTENSION_SECRET is required for the official plugin shop API.');
  }
  const data = { memberId, sortType, pageNum, pageSize };
  const payload = await callMtop({
    context,
    page,
    api: SHOP_API,
    version: SHOP_VERSION,
    data,
    extraHeaders: { 'x-1688extension-secret': extensionSecret },
  });
  const offers = findOfferArray(payload) ?? [];
  return {
    payload,
    result: {
      schemaVersion: 1,
      pageType: 'shop-offer-batch',
      source: '1688',
      request: { memberId, pageNum, pageSize, sortType },
      totalCount: findTotal(payload),
      offerCount: offers.length,
      offerFields: [...new Set(offers.flatMap((item) => Object.keys(item ?? {})))].sort(),
      offers,
      mtopRet: retMessages(payload),
      parsedAt: new Date().toISOString(),
    },
  };
}

export async function fetchPluginLogin({ context, page }) {
  const payload = await callMtop({
    context, page, api: LOGIN_API, version: LOGIN_VERSION, data: {},
  });
  const data = payload?.data ?? {};
  const result = {
    schemaVersion: 1,
    pageType: 'plugin-session',
    source: '1688',
    isLogin: data.isLogin === true || data.isLogin === 'true',
    loginId: data.loginId ?? null,
    userId: data.userId != null ? String(data.userId) : null,
    mtopRet: retMessages(payload),
    checkedAt: new Date().toISOString(),
  };
  return { payload, result };
}

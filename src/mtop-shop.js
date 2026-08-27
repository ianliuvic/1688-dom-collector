import crypto from 'node:crypto';
import { buildExtensionSecret } from './plugin-crypto.js';

const APP_KEY = '12574478';
const PLUGIN_ORIGIN = 'https://air.1688.com';
const SHOP_API = 'mtop.1688.pc.plugin.shop.offerlist.query';
const SHOP_VERSION = '1.1';
const LOGIN_API = 'mtop.1688.pc.plugin.user.login.get';
const LOGIN_VERSION = '1.0';
const HEARTBEAT_API = 'mtop.1688.pc.plugin.safe.heartbeat.key.get';
const HEARTBEAT_VERSION = '1.0';

function tokenValue(cookies) {
  const cookie = cookies.find((item) => item.name === '_m_h5_tk');
  return cookie?.value?.split('_')[0] ?? '';
}

function signedUrl(token, api, version, dataText, query = {}) {
  const timestamp = String(Date.now());
  const sign = crypto.createHash('md5')
    .update(`${token}&${timestamp}&${APP_KEY}&${dataText}`)
    .digest('hex');
  const params = new URLSearchParams({
    jsv: '2.7.2', appKey: APP_KEY, t: timestamp, sign,
    dataType: 'json', api, v: version, type: 'originaljson', ...query, data: dataText,
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

async function callMtop({ context, page, api, version, data, extraHeaders = {}, query = {} }) {
  let payload;
  let httpStatus;
  const dataText = JSON.stringify(data);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cookies = await context.cookies('https://h5api.m.1688.com');
    const response = await page.evaluate(async ({ url, headers }) => {
      const fetched = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        signal: AbortSignal.timeout(30000),
        headers: { accept: '*/*', ...headers },
      });
      return { status: fetched.status, text: await fetched.text() };
    }, {
      url: signedUrl(tokenValue(cookies), api, version, dataText, query),
      headers: extraHeaders,
    });
    httpStatus = response.status;
    payload = parseJson(response.text);
    if (isSuccess(payload)) return payload;
    if (attempt === 0 && shouldRefreshToken(payload)) continue;
    throw new Error(`1688 MTop rejected the request: ${retMessages(payload).join('; ') || httpStatus}`);
  }

  throw new Error(`1688 MTop request failed: ${retMessages(payload).join('; ') || httpStatus}`);
}

export async function refreshPluginHeartbeat({ context, page, heartbeatRequest }) {
  const payload = await callMtop({
    context,
    page,
    api: HEARTBEAT_API,
    version: HEARTBEAT_VERSION,
    data: { heartbeatRequest },
    query: { prefix: 'h5api' },
  });
  return payload?.data?.result;
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
  context, page, pluginCrypto, memberId, pageNum, pageSize, sortType,
}) {
  const data = { memberId, sortType, pageNum, pageSize };
  const dataText = JSON.stringify(data);
  let payload;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const metaInfo = await pluginCrypto.getToken({ context, page, force: attempt > 0 });
    const extensionSecret = buildExtensionSecret(metaInfo, dataText);
    try {
      payload = await callMtop({
        context,
        page,
        api: SHOP_API,
        version: SHOP_VERSION,
        data,
        extraHeaders: { 'x-1688extension-secret': extensionSecret },
      });
      break;
    } catch (error) {
      pluginCrypto.clearToken();
      if (attempt > 0) throw error;
    }
  }
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchAllShopOffers({
  context, page, pluginCrypto, memberId, pageNum = 1, pageSize = 300,
  sortType = 'wangpu_score', maxPages = 1000,
}) {
  const startedAt = Date.now();
  const offers = [];
  const seenOfferIds = new Set();
  const pagePayloads = [];
  const pages = [];
  let totalCount = null;
  let truncated = false;

  for (let offset = 0; offset < maxPages; offset += 1) {
    const currentPage = pageNum + offset;
    const pageResult = await fetchShopOfferPage({
      context, page, pluginCrypto, memberId, pageNum: currentPage, pageSize, sortType,
    });
    pagePayloads.push(pageResult.payload);
    totalCount ??= pageResult.result.totalCount;
    let added = 0;
    for (const offer of pageResult.result.offers) {
      const id = offer?.offerId != null ? String(offer.offerId) : null;
      if (id && seenOfferIds.has(id)) continue;
      if (id) seenOfferIds.add(id);
      offers.push(offer);
      added += 1;
    }
    pages.push({
      pageNum: currentPage,
      received: pageResult.result.offerCount,
      added,
    });

    const received = pageResult.result.offerCount;
    if (received === 0
        || (offset > 0 && added === 0)
        || (totalCount !== null && offers.length >= totalCount)
        || received < pageSize) break;
    if (offset === maxPages - 1) {
      truncated = true;
      break;
    }
    await delay(900 + Math.floor(Math.random() * 701));
  }

  return {
    payload: { pages: pagePayloads },
    result: {
      schemaVersion: 1,
      pageType: 'shop-offer-collection',
      source: '1688',
      request: { memberId, pageNum, pageSize, sortType, maxPages },
      totalCount,
      offerCount: offers.length,
      offerFields: [...new Set(offers.flatMap((item) => Object.keys(item ?? {})))].sort(),
      offers,
      pages,
      requestCount: pages.length,
      truncated,
      durationMs: Date.now() - startedAt,
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

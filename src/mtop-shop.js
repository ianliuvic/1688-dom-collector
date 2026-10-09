import crypto from 'node:crypto';

const APP_KEY = '12574478';
const LOGIN_API = 'mtop.1688.pc.plugin.user.login.get';
const LOGIN_VERSION = '1.0';
const HEARTBEAT_API = 'mtop.1688.pc.plugin.safe.heartbeat.key.get';
const HEARTBEAT_VERSION = '1.0';

function tokenValue(cookies) {
  const cookie = cookies.find((item) => item.name === '_m_h5_tk');
  return cookie?.value?.split('_')[0] ?? '';
}

function signedUrl(token, api, version, dataText, query = {}, includeDataInQuery = true) {
  const timestamp = String(Date.now());
  const sign = crypto.createHash('md5')
    .update(`${token}&${timestamp}&${APP_KEY}&${dataText}`)
    .digest('hex');
  const params = new URLSearchParams({
    jsv: '2.7.2', appKey: APP_KEY, t: timestamp, sign,
    dataType: 'json', api, v: version, type: 'originaljson', ...query,
  });
  if (includeDataInQuery) params.set('data', dataText);
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

async function callMtop({
  context, page, api, version, data, extraHeaders = {}, query = {},
  method = 'GET', includeDataInQuery = true,
}) {
  let payload;
  let httpStatus;
  const dataText = JSON.stringify(data);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cookies = await context.cookies('https://h5api.m.1688.com');
    const response = await page.evaluate(async ({ url, headers, method: requestMethod, body }) => {
      const fetched = await fetch(url, {
        method: requestMethod,
        credentials: 'include',
        cache: 'no-store',
        signal: AbortSignal.timeout(30000),
        headers: { accept: '*/*', ...headers },
        ...(body ? { body } : {}),
      });
      return { status: fetched.status, text: await fetched.text() };
    }, {
      url: signedUrl(tokenValue(cookies), api, version, dataText, query, includeDataInQuery),
      headers: extraHeaders,
      method,
      body: method === 'POST' ? `data=${encodeURIComponent(dataText)}` : null,
    });
    httpStatus = response.status;
    payload = parseJson(response.text);
    if (isSuccess(payload)) return payload;
    if (attempt === 0 && shouldRefreshToken(payload)) continue;
    throw new Error(`1688 MTop rejected the request: ${retMessages(payload).join('; ') || httpStatus}`
      + ` | response=${JSON.stringify(payload).slice(0, 400)}`);
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

// The shop offerlist page loads its data through the page's own mtop module
// API (no plugin extension secret involved). 1688 retired the previous plugin
// API (mtop.1688.pc.plugin.shop.offerlist.query rejected every caller from
// 2026-10-09) and upgraded the official extension to 1.2.0, which enumerates a
// store through this module endpoint as well.
const SHOP_MODULE_API = 'mtop.alibaba.alisite.cbu.server.ModuleAsyncService';
const SHOP_MODULE_VERSION = '1.0';
const SHOP_MODULE_COUNT_MAX = 30;

function tryParseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function offerItemScore(keys) {
  let score = 0;
  if (keys.some((key) => /^offer.*id$/i.test(key))) score += 3;
  else if (keys.some((key) => /^id$/i.test(key))) score += 1;
  if (keys.some((key) => /^(subject|title)$/i.test(key))) score += 2;
  if (keys.some((key) => /price/i.test(key))) score += 1;
  if (keys.some((key) => /(detailurl|offerurl|offerpic|url)/i.test(key))) score += 1;
  return score;
}

function findOfferArrayDeep(value, depth = 0) {
  if (depth > 12 || value == null) return null;
  if (typeof value === 'string') {
    const parsed = tryParseJson(value);
    return parsed ? findOfferArrayDeep(parsed, depth + 1) : null;
  }
  if (Array.isArray(value)) {
    if (value.length >= 3 && value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
      const score = offerItemScore(Object.keys(value[0]));
      if (score >= 4) return value;
    }
    for (const item of value) {
      const found = findOfferArrayDeep(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findOfferArrayDeep(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function collectCandidateArrays(value, out = [], depth = 0, path = '$', limit = 40) {
  if (depth > 12 || value == null || out.length >= limit) return out;
  if (typeof value === 'string') {
    const parsed = tryParseJson(value);
    if (parsed) collectCandidateArrays(parsed, out, depth + 1, `${path}(json)`, limit);
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length && value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
      const keys = Object.keys(value[0]);
      out.push({
        path, count: value.length, keys: keys.slice(0, 30),
        score: offerItemScore(keys),
        sample: JSON.stringify(value[0]).slice(0, 500),
      });
    }
    value.forEach((item, index) => collectCandidateArrays(item, out, depth + 1, `${path}[${index}]`, limit));
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectCandidateArrays(item, out, depth + 1, `${path}.${key}`, limit);
    }
  }
  return out;
}

export async function fetchShopOfferPage({
  context, page, memberId, pageNum, pageSize, sortType,
}) {
  const count = Math.min(Math.max(Number(pageSize) || SHOP_MODULE_COUNT_MAX, 1), SHOP_MODULE_COUNT_MAX);
  const data = {
    componentKey: 'Wp_pc_common_offerlist',
    params: JSON.stringify({
      memberId,
      appdata: {
        sortType: sortType || 'wangpu_score',
        sellerRecommendFilter: false,
        mixFilter: false,
        tradenumFilter: false,
        quantityBegin: null,
        pageNum,
        count,
      },
    }),
  };
  const payload = await callMtop({
    context,
    page,
    api: SHOP_MODULE_API,
    version: SHOP_MODULE_VERSION,
    data,
    method: 'POST',
    includeDataInQuery: false,
    extraHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
    query: { type: 'json', valueType: 'string', dataType: 'json', timeout: '10000' },
  });
  let offers = findOfferArray(payload.data ?? payload) ?? [];
  let matchedBy = offers.length ? 'offerId' : null;
  if (!offers.length) {
    offers = findOfferArrayDeep(payload.data ?? payload) ?? [];
    matchedBy = offers.length ? 'scored' : null;
  }
  const candidates = offers.length
    ? []
    : collectCandidateArrays(payload.data ?? payload, [])
      .sort((a, b) => (b.score - a.score) || (b.count - a.count))
      .slice(0, 12);
  return {
    payload,
    result: {
      schemaVersion: 1,
      pageType: 'shop-offer-batch',
      source: '1688',
      request: { memberId, pageNum, pageSize: count, sortType },
      totalCount: findTotal(payload),
      offerCount: offers.length,
      offerFields: [...new Set(offers.flatMap((item) => Object.keys(item ?? {})))].sort(),
      offers,
      matchedBy,
      ...(offers.length ? {} : {
        candidates,
        payloadPeek: JSON.stringify(payload).slice(0, 3000),
      }),
      mtopRet: retMessages(payload),
      parsedAt: new Date().toISOString(),
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shopOfferId(offer) {
  if (!offer || typeof offer !== 'object') return null;
  for (const key of ['offerId', 'offerID', 'id', 'itemId']) {
    const value = offer[key];
    if (value != null && /^\d{6,}$/.test(String(value))) return String(value);
  }
  return null;
}

export async function fetchAllShopOffers({
  context, page, memberId, pageNum = 1, pageSize = 300,
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
      context, page, memberId, pageNum: currentPage, pageSize, sortType,
    });
    pagePayloads.push(pageResult.payload);
    totalCount ??= pageResult.result.totalCount;
    let added = 0;
    for (const offer of pageResult.result.offers) {
      const id = shopOfferId(offer);
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
    const effectivePageSize = pageResult.result.request?.pageSize || pageSize;
    if (received === 0
        || (offset > 0 && added === 0)
        || (totalCount !== null && offers.length >= totalCount)
        || received < effectivePageSize) break;
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

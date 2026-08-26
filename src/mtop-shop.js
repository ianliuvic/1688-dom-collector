import crypto from 'node:crypto';

const API = 'mtop.1688.pc.plugin.shop.offerlist.query';
const VERSION = '1.1';
const APP_KEY = '12574478';

function tokenValue(cookies) {
  const cookie = cookies.find((item) => item.name === '_m_h5_tk');
  return cookie?.value?.split('_')[0] ?? '';
}

function signedUrl(token, data) {
  const timestamp = String(Date.now());
  const dataText = JSON.stringify(data);
  const sign = crypto.createHash('md5')
    .update(`${token}&${timestamp}&${APP_KEY}&${dataText}`)
    .digest('hex');
  const params = new URLSearchParams({
    jsv: '2.7.2', appKey: APP_KEY, t: timestamp, sign,
    dataType: 'json', api: API, v: VERSION, type: 'originaljson', data: dataText,
  });
  return `https://h5api.m.1688.com/h5/${API}/${VERSION}/?${params}`;
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

export async function fetchShopOfferPage({ context, page, memberId, pageNum, pageSize, sortType }) {
  const data = { memberId, sortType, pageNum, pageSize };
  const userAgent = await page.evaluate(() => navigator.userAgent);
  let payload;
  let httpStatus;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cookies = await context.cookies('https://h5api.m.1688.com');
    const response = await context.request.get(signedUrl(tokenValue(cookies), data), {
      headers: {
        accept: 'application/json, text/plain, */*',
        referer: page.url(),
        'user-agent': userAgent,
      },
      timeout: 30000,
    });
    httpStatus = response.status();
    payload = parseJson(await response.text());
    if (isSuccess(payload)) break;
    if (attempt === 0 && shouldRefreshToken(payload)) continue;
    throw new Error(`1688 MTop rejected the request: ${retMessages(payload).join('; ') || httpStatus}`);
  }

  if (!isSuccess(payload)) {
    throw new Error(`1688 MTop request failed: ${retMessages(payload).join('; ') || httpStatus}`);
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


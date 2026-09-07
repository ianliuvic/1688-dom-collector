const STYLE_RE = /^[A-Za-z0-9_-]{2,40}$/;

export function parseProductResolverQuery(query = {}, wordpressBaseUrl = '') {
  const supplied = [
    ['styleNo', query.styleNo],
    ['wpPostId', query.wpPostId],
    ['slug', query.slug],
    ['url', query.url],
  ].filter(([, value]) => value !== undefined && String(value).trim() !== '');
  if (supplied.length !== 1) {
    throw new Error('Provide exactly one of styleNo, wpPostId, slug, or url.');
  }
  const [kind, raw] = supplied[0];
  const value = String(raw).trim();
  if (kind === 'styleNo') {
    if (!STYLE_RE.test(value)) throw new Error('styleNo is invalid.');
    return { kind, value: value.toUpperCase(), wordpressQuery: { style_no: value } };
  }
  if (kind === 'wpPostId') {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('wpPostId is invalid.');
    return { kind, value: id, wordpressQuery: { post_id: id } };
  }
  if (kind === 'slug') {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value)) throw new Error('slug is invalid.');
    return { kind, value: value.toLowerCase(), wordpressQuery: { slug: value } };
  }
  let parsed;
  let allowed;
  try {
    parsed = new URL(value);
    allowed = new URL(wordpressBaseUrl);
  } catch {
    throw new Error('url is invalid.');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== allowed.hostname.toLowerCase()) {
    throw new Error('url must be an HTTPS URL on the configured WordPress site.');
  }
  parsed.hash = '';
  parsed.search = '';
  return { kind, value: parsed.toString(), wordpressQuery: { url: parsed.toString() } };
}

export function localResolverLookup(identifier) {
  if (identifier.kind === 'styleNo') return { styleNo: identifier.value };
  if (identifier.kind === 'wpPostId') return { wpPostId: identifier.value };
  if (identifier.kind === 'url') return { wpUrl: identifier.value };
  return null;
}

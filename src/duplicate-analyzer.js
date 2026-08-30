import crypto from 'node:crypto';

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeImageUrl(value) {
  const normalized = clean(value).replace(/^http:/i, 'https:');
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    url.hash = '';
    return url.toString();
  } catch {
    return normalized;
  }
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function buildGalleryFingerprint(data, imageFiles = []) {
  const orderedSourceUrls = unique([data?.mainImage, ...(data?.images ?? [])]
    .map(normalizeImageUrl));
  const hashesByUrl = new Map();
  for (const image of imageFiles) {
    if (!['main', 'gallery'].includes(image?.type) || !image?.contentSha256) continue;
    hashesByUrl.set(normalizeImageUrl(image.sourceUrl), clean(image.contentSha256));
  }
  const orderedHashes = orderedSourceUrls.map((url) => hashesByUrl.get(url)).filter(Boolean);
  const distinctHashes = unique(orderedHashes);
  const gallery = data?.gallery ?? {};
  const verifiedComplete = gallery.source === 'exact_dom_gallery'
    && gallery.complete === true
    && gallery.stable === true
    && Number(gallery.unresolvedSlotCount || 0) === 0
    && orderedSourceUrls.length > 0
    && orderedHashes.length === orderedSourceUrls.length;
  const sortedHashes = [...orderedHashes].sort();
  return {
    schemaVersion: 1,
    fingerprint: verifiedComplete && sortedHashes.length
      ? sha256(sortedHashes.join('\n')) : null,
    verifiedComplete,
    sourceImageCount: orderedSourceUrls.length,
    downloadedImageCount: orderedHashes.length,
    distinctImageCount: distinctHashes.length,
    contentHashes: sortedHashes,
    sourceUrls: orderedSourceUrls,
    galleryDiagnostics: {
      source: gallery.source ?? null,
      complete: Boolean(gallery.complete),
      stable: Boolean(gallery.stable),
      unresolvedSlotCount: Number(gallery.unresolvedSlotCount || 0),
    },
  };
}

function exactCandidate(candidate) {
  return {
    productDetailId: Number(candidate.product_detail_id),
    offerId: clean(candidate.offer_id),
    sourceUrl: clean(candidate.canonical_url || candidate.source_url),
    title: clean(candidate.title),
    decision: 'same_product',
    confidence: 1,
    evidence: {
      fullGalleryContentHashMatch: true,
      matchedImageCount: Number(candidate.matched_image_count || candidate.gallery_image_count || 0),
      galleryFingerprint: clean(candidate.gallery_fingerprint),
    },
  };
}

function hashCandidate(candidate) {
  const overlap = Number(candidate.matched_image_count || 0);
  const currentCount = Number(candidate.current_image_count || 0);
  const candidateCount = Number(candidate.gallery_image_count || 0);
  const denominator = Math.max(currentCount, candidateCount, 1);
  return {
    productDetailId: Number(candidate.product_detail_id),
    offerId: clean(candidate.offer_id),
    sourceUrl: clean(candidate.canonical_url || candidate.source_url),
    title: clean(candidate.title),
    decision: 'manual_review',
    confidence: Number((overlap / denominator).toFixed(4)),
    evidence: {
      exactImageContentOverlap: true,
      matchedImageCount: overlap,
      currentImageCount: currentCount,
      candidateImageCount: candidateCount,
      overlapRatio: Number((overlap / denominator).toFixed(4)),
    },
  };
}

function ragCandidate(candidate) {
  return {
    productDetailId: Number(candidate.productDetailId) || null,
    offerId: clean(candidate.sourceProductId),
    sourceUrl: clean(candidate.metadata?.sourceUrl),
    title: clean(candidate.title),
    decision: 'manual_review',
    confidence: Number(Number(candidate.score || 0).toFixed(4)),
    evidence: {
      multimodalEmbeddingSimilarity: true,
      visualScore: Number(Number(candidate.visualScore || candidate.channelScores?.visual || 0).toFixed(4)),
      textScore: Number(Number(candidate.textScore || candidate.channelScores?.text || 0).toFixed(4)),
      matchedQueryImageCount: Number(candidate.matchedQueryImageCount || 0),
    },
  };
}

function mergeCandidates(candidates) {
  const merged = new Map();
  for (const candidate of candidates) {
    const key = candidate.productDetailId ? `detail:${candidate.productDetailId}`
      : candidate.offerId ? `offer:${candidate.offerId}` : candidate.sourceUrl;
    if (!key) continue;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, candidate);
      continue;
    }
    current.confidence = Math.max(current.confidence || 0, candidate.confidence || 0);
    current.evidence = { ...current.evidence, ...candidate.evidence };
    current.productDetailId ||= candidate.productDetailId;
    current.offerId ||= candidate.offerId;
    current.sourceUrl ||= candidate.sourceUrl;
    current.title ||= candidate.title;
  }
  return [...merged.values()].sort((left, right) => (right.confidence || 0) - (left.confidence || 0));
}

export async function analyzeProductDuplicates({ data, imageFiles, database, ragClient }) {
  const checkedAt = new Date().toISOString();
  const galleryProfile = buildGalleryFingerprint(data, imageFiles);
  const exactMatches = galleryProfile.fingerprint && galleryProfile.verifiedComplete
    && galleryProfile.sourceImageCount >= 2
    ? await database.findExactGalleryDuplicates({
      offerId: data.offerId,
      fingerprint: galleryProfile.fingerprint,
      imageCount: galleryProfile.sourceImageCount,
    }) : [];

  if (exactMatches.length) {
    return {
      schemaVersion: 1,
      checkedAt,
      status: 'exact_duplicate',
      isSimilarProduct: true,
      decision: 'reject',
      confidence: 'certain',
      reason: 'A different 1688 offer has the same verified complete Gallery image bytes.',
      galleryProfile,
      candidates: exactMatches.map(exactCandidate),
      checks: { exactContentHash: 'completed', multimodalEmbedding: 'skipped_exact_match' },
    };
  }

  const hashMatches = galleryProfile.contentHashes.length
    ? await database.findGalleryHashCandidates({
      offerId: data.offerId,
      contentHashes: galleryProfile.contentHashes,
      currentImageCount: galleryProfile.sourceImageCount,
      limit: 10,
    }) : [];

  let ragMatches = [];
  let ragStatus = ragClient?.enabled ? 'completed' : 'not_configured';
  if (ragClient?.enabled && galleryProfile.sourceUrls.length) {
    try {
      const response = await ragClient.findSimilarProducts({
        sourceProductId: data.offerId,
        title: data.title,
        imageUrls: galleryProfile.sourceUrls.slice(0, 3),
        topK: 10,
        minScore: 0.78,
      });
      ragMatches = Array.isArray(response?.items) ? response.items : [];
    } catch (error) {
      ragStatus = 'failed';
      // Similarity analysis is advisory. Exact byte matching still completes and the capture remains usable.
    }
  }

  const candidates = mergeCandidates([
    ...hashMatches.map(hashCandidate),
    ...ragMatches.map(ragCandidate),
  ]).filter((candidate) => candidate.offerId !== clean(data.offerId)).slice(0, 10);
  return {
    schemaVersion: 1,
    checkedAt,
    status: candidates.length ? 'similar_candidates' : 'no_similar_products',
    isSimilarProduct: candidates.length > 0,
    decision: candidates.length ? 'manual_review' : 'accept',
    confidence: candidates.length ? 'candidate_only' : 'none_found',
    reason: candidates.length
      ? 'One or more non-conclusive visual or exact-image-overlap candidates require human review.'
      : 'No existing product met the configured exact-image or embedding similarity thresholds.',
    galleryProfile,
    candidates,
    checks: { exactContentHash: 'completed', multimodalEmbedding: ragStatus },
  };
}

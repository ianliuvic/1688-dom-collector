import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeProductDuplicates, buildGalleryFingerprint } from '../src/duplicate-analyzer.js';

function product(imageCount = 2) {
  const images = Array.from({ length: imageCount }, (_, index) => `https://img.example.com/${index + 1}.jpg`);
  return {
    offerId: '1000000000001', title: 'Test swimsuit', mainImage: images[0], images,
    gallery: { source: 'exact_dom_gallery', complete: true, stable: true, unresolvedSlotCount: 0 },
  };
}

function files(data) {
  return data.images.map((sourceUrl, index) => ({
    type: index === 0 ? 'main' : 'gallery', sourceUrl,
    contentSha256: String(index + 1).padStart(64, '0'),
  }));
}

test('builds a deterministic fingerprint only for a complete downloaded Gallery', () => {
  const data = product(3);
  const profile = buildGalleryFingerprint(data, files(data));
  assert.equal(profile.verifiedComplete, true);
  assert.equal(profile.distinctImageCount, 3);
  assert.match(profile.fingerprint, /^[a-f0-9]{64}$/);

  const incomplete = buildGalleryFingerprint({ ...data, gallery: { ...data.gallery, stable: false } }, files(data));
  assert.equal(incomplete.verifiedComplete, false);
  assert.equal(incomplete.fingerprint, null);
});

test('rejects a different offer only when at least two complete Gallery files match exactly', async () => {
  const data = product(2);
  const result = await analyzeProductDuplicates({
    data, imageFiles: files(data),
    database: {
      findExactGalleryDuplicates: async () => [{
        product_detail_id: 9, offer_id: '1000000000002', title: 'Existing product',
        gallery_image_count: 2, matched_image_count: 2, gallery_fingerprint: 'abc',
      }],
      findGalleryHashCandidates: async () => [],
    },
    ragClient: { enabled: false },
  });
  assert.equal(result.status, 'exact_duplicate');
  assert.equal(result.decision, 'reject');
  assert.equal(result.confidence, 'certain');
});

test('a single identical image or embedding similarity is advisory and never auto-rejected', async () => {
  const data = product(1);
  let exactCalled = false;
  const result = await analyzeProductDuplicates({
    data, imageFiles: files(data),
    database: {
      findExactGalleryDuplicates: async () => { exactCalled = true; return []; },
      findGalleryHashCandidates: async () => [{
        product_detail_id: 8, offer_id: '1000000000003', title: 'Possible match',
        matched_image_count: 1, gallery_image_count: 1, current_image_count: 1,
      }],
    },
    ragClient: {
      enabled: true,
      findSimilarProducts: async () => ({ items: [{
        productDetailId: 8, sourceProductId: '1000000000003', title: 'Possible match',
        score: 0.96, visualScore: 0.96, textScore: 0.8, matchedQueryImageCount: 1,
      }] }),
    },
  });
  assert.equal(exactCalled, false);
  assert.equal(result.status, 'similar_candidates');
  assert.equal(result.decision, 'manual_review');
  assert.equal(result.isSimilarProduct, true);
});

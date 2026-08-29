import assert from 'node:assert/strict';
import test from 'node:test';
import { parse1688Product } from '../src/parsers/1688-product.js';

test('uses the exact product carousel and does not append unrelated page candidates', async () => {
  const page = {
    evaluate: async () => ({
      url: 'https://detail.1688.com/offer/1234567890123.html',
      canonicalUrl: null,
      title: 'Test product',
      description: '',
      mainImage: 'https://cbu01.alicdn.com/img/ibank/main.jpg',
      images: [
        'https://cbu01.alicdn.com/img/ibank/main.jpg_.webp',
        'https://cbu01.alicdn.com/img/ibank/product-two.jpg_.webp',
      ],
      jsonLd: [],
      embeddedCandidates: {
        prices: [], tiers: [], skuRows: [], dimensions: [], attributes: [],
        images: ['https://cbu01.alicdn.com/img/ibank/unrelated-review-avatar.jpg'],
      },
      attributes: [], skuOptions: [], priceTexts: [], bodyText: '', sellerLinks: [], sellerTexts: [],
    }),
  };

  const product = await parse1688Product(page);
  assert.deepEqual(product.images, [
    'https://cbu01.alicdn.com/img/ibank/main.jpg',
    'https://cbu01.alicdn.com/img/ibank/product-two.jpg_.webp',
  ]);
  assert.equal(product.images.some((url) => url.includes('review-avatar')), false);
});

test('prefers a hydrated exact Gallery snapshot and exposes completeness diagnostics', async () => {
  const page = {
    locator: () => ({
      first: () => ({
        waitFor: async () => {},
        scrollIntoViewIfNeeded: async () => {},
      }),
      count: async () => 0,
    }),
    waitForTimeout: async () => {},
    evaluate: async (fn, argument) => {
      if (argument) return {
        urls: ['https://cbu01.alicdn.com/img/ibank/one.jpg'],
        domImageCount: 1,
        expectedSlotCount: 1,
        unresolvedSlotCount: 0,
      };
      return {
        url: 'https://detail.1688.com/offer/1234567890123.html',
        canonicalUrl: null,
        title: 'Test product',
        description: '',
        mainImage: 'https://cbu01.alicdn.com/img/ibank/one.jpg',
        images: ['https://cbu01.alicdn.com/img/ibank/one.jpg'],
        gallerySnapshot: {
          source: 'exact_dom_gallery', complete: true, stable: true,
          urls: ['https://cbu01.alicdn.com/img/ibank/one.jpg'],
          expectedSlotCount: 1, unresolvedSlotCount: 0, rounds: 4,
        },
        jsonLd: [],
        embeddedCandidates: { prices: [], tiers: [], skuRows: [], dimensions: [], attributes: [], images: [] },
        attributes: [], skuOptions: [], priceTexts: [], bodyText: '', sellerLinks: [], sellerTexts: [],
      };
    },
  };

  const product = await parse1688Product(page);
  assert.equal(product.gallery.complete, true);
  assert.equal(product.gallery.source, 'exact_dom_gallery');
  assert.equal(product.gallery.imageCount, 1);
});

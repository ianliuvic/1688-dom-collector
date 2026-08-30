import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveVerifiedProductPrice, extractPriceTiers,
  parse1688Product } from '../src/parsers/1688-product.js';

test('extracts the current offer tiers from compact 1688 price text', () => {
  assert.deepEqual(extractPriceTiers([
    '券后¥27.00首件预估到手价¥28.001套起批 60天老客价¥27.0050-99套 ¥26.00≥100套',
  ]), [
    { minQuantity: 1, maxQuantity: null, price: 28 },
    { minQuantity: 50, maxQuantity: 99, price: 27 },
    { minQuantity: 100, maxQuantity: null, price: 26 },
  ]);
});

test('ignores unrelated global prices when exact DOM SKU prices exist', () => {
  assert.deepEqual(deriveVerifiedProductPrice({
    skuPrices: [28, 28, 28, 28],
    jsonLdPrices: [23, 74, 999],
    scopedPriceTexts: ['¥28.001套起批 ¥27.0050-99套 ¥26.00≥100套'],
  }), {
    min: 26, max: 28,
    tiers: [
      { minQuantity: 1, maxQuantity: null, price: 28 },
      { minQuantity: 50, maxQuantity: 99, price: 27 },
      { minQuantity: 100, maxQuantity: null, price: 26 },
    ],
    source: 'exact_dom_sku_and_offer_tiers', verified: true,
  });
});

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
      domSkuRows: [
        { dimensionName: '尺码', text: 'S', priceText: '¥28.00', stockText: '库存999' },
        { dimensionName: '尺码', text: 'M', priceText: '¥28.00', stockText: '库存999' },
      ],
      scopedPriceTexts: ['¥28.001套起批 ¥27.0050-99套 ¥26.00≥100套'],
    }),
  };

  const product = await parse1688Product(page);
  assert.deepEqual(product.images, [
    'https://cbu01.alicdn.com/img/ibank/main.jpg_.webp',
    'https://cbu01.alicdn.com/img/ibank/product-two.jpg_.webp',
  ]);
  assert.equal(product.images.some((url) => url.includes('review-avatar')), false);
  assert.equal(product.price.max, 28);
  assert.equal(product.price.min, 26);
  assert.equal(product.price.verified, true);
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

test('uses the first exact Gallery image as main image and excludes unrelated og:image', async () => {
  const page = {
    evaluate: async () => ({
      url: 'https://detail.1688.com/offer/1234567890123.html',
      canonicalUrl: null,
      title: 'Test product',
      description: '',
      mainImage: 'https://cbu01.alicdn.com/img/ibank/unrelated-cat.jpg',
      images: [
        'https://cbu01.alicdn.com/img/ibank/product-front.jpg_.webp',
        'https://cbu01.alicdn.com/img/ibank/product-back.jpg_.webp',
      ],
      gallerySnapshot: {
        source: 'exact_dom_gallery', complete: true, stable: true,
        expectedSlotCount: 2, unresolvedSlotCount: 0, rounds: 4,
      },
      jsonLd: [],
      embeddedCandidates: {
        prices: [], tiers: [], skuRows: [], dimensions: [], attributes: [], images: [],
      },
      attributes: [], skuOptions: [], priceTexts: [], bodyText: '', sellerLinks: [], sellerTexts: [],
    }),
  };

  const product = await parse1688Product(page);
  assert.equal(product.mainImage, 'https://cbu01.alicdn.com/img/ibank/product-front.jpg_.webp');
  assert.deepEqual(product.images, [
    'https://cbu01.alicdn.com/img/ibank/product-front.jpg_.webp',
    'https://cbu01.alicdn.com/img/ibank/product-back.jpg_.webp',
  ]);
  assert.equal(product.images.some((url) => url.includes('unrelated-cat')), false);
});

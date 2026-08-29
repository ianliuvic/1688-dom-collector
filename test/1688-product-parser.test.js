import assert from 'node:assert/strict';
import test from 'node:test';
import { parse1688Product } from '../src/parsers/1688-product.js';

test('prioritizes gallery candidates even when they originate from small lazy thumbnails', async () => {
  const page = {
    evaluate: async () => ({
      url: 'https://detail.1688.com/offer/1234567890123.html',
      canonicalUrl: null,
      title: 'Test product',
      description: '',
      mainImage: 'https://cbu01.alicdn.com/img/ibank/main.jpg',
      galleryImages: [
        'https://cbu01.alicdn.com/img/ibank/main.jpg_60x60.jpg',
        'https://cbu01.alicdn.com/img/ibank/second.jpg_60x60.jpg',
        'https://cbu01.alicdn.com/img/ibank/third.jpg_60x60.jpg',
      ],
      images: [],
      jsonLd: [],
      embeddedCandidates: { prices: [], tiers: [], skuRows: [], dimensions: [], attributes: [], images: [] },
      attributes: [],
      skuOptions: [],
      priceTexts: [],
      bodyText: '',
      sellerLinks: [],
      sellerTexts: [],
    }),
  };

  const product = await parse1688Product(page);
  assert.equal(product.mainImage, 'https://cbu01.alicdn.com/img/ibank/main.jpg');
  assert.deepEqual(product.images, [
    'https://cbu01.alicdn.com/img/ibank/main.jpg',
    'https://cbu01.alicdn.com/img/ibank/second.jpg',
    'https://cbu01.alicdn.com/img/ibank/third.jpg',
  ]);
});

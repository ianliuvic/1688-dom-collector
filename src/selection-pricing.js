export const SELECTION_PRICING_RATE = 6.5;
export const SELECTION_SAMPLE_MARKUP_CNY = 15;
export const SELECTION_BULK_MARKUP_CNY = 5;

const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export function selectionPricingFor(sourceMaxPrice) {
  const sourceMax = Number(sourceMaxPrice);
  if (!Number.isFinite(sourceMax) || sourceMax <= 0) return null;
  const bulkPrice = round((sourceMax + SELECTION_BULK_MARKUP_CNY) / SELECTION_PRICING_RATE);
  const onePiecePrice = round((sourceMax + SELECTION_SAMPLE_MARKUP_CNY) / SELECTION_PRICING_RATE);
  const formula = '1 pc = (source maximum CNY price + 15) / 6.5; 50+ pcs = (source maximum + 5) / 6.5; 1-49 pcs decrease linearly';
  const tier = {
    label: '50+ pcs',
    minQuantity: 50,
    maxQuantity: null,
    cnyMarkup: SELECTION_BULK_MARKUP_CNY,
    price: bulkPrice,
  };
  return {
    currency: 'USD',
    sourceCurrency: 'CNY',
    sourceMaxPrice: sourceMax,
    exchangeRate: SELECTION_PRICING_RATE,
    formula,
    sampleStartMarkupCny: SELECTION_SAMPLE_MARKUP_CNY,
    bulkMarkupCny: SELECTION_BULK_MARKUP_CNY,
    tiers: [tier],
    priceTiers: [{ label: tier.label, minQuantity: tier.minQuantity, maxQuantity: tier.maxQuantity, price: tier.price, sortOrder: 0 }],
    priceMin: bulkPrice,
    priceMax: onePiecePrice,
    moq: 50,
    pricingRule: {
      formula,
      sourceMaxPrice: sourceMax,
      exchangeRate: SELECTION_PRICING_RATE,
      sampleStartMarkupCny: SELECTION_SAMPLE_MARKUP_CNY,
      bulkMarkupCny: SELECTION_BULK_MARKUP_CNY,
      tiers: [tier],
    },
  };
}

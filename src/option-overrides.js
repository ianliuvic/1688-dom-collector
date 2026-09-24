// Manual option-label overrides.
//
// A captured 1688 listing can carry a source option label that is a bare
// merchant code (for example `9007`) rather than a name a customer can read.
// The published label is rebuilt from the source SKU options on every
// translation and every publication, so correcting the WordPress product alone
// is not durable: the next capture, translation refresh, or SKU-swatch repair
// writes the code straight back.
//
// An override records the corrected display name for one
// (product detail, dimension, source option text) triple. It is applied while
// the WordPress payload is assembled, which every publication path shares
// (preview, publish, bulk synchronization, and the repair scripts that call the
// publication API), so no later capture can silently revert it. The raw 1688
// text is never rewritten: `source_options` keeps the exact captured value and
// only the display label changes.

const COLOR_DIMENSIONS = new Set(['color', '颜色']);

export const DEFAULT_OPTION_DIMENSION = 'color';
export const MAX_OPTION_LABEL_LENGTH = 120;

export function normalizeDimensionName(value) {
  const cleaned = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^color\s*:\s*/i, '')
    .trim();
  if (!cleaned) return DEFAULT_OPTION_DIMENSION;
  return COLOR_DIMENSIONS.has(cleaned) ? DEFAULT_OPTION_DIMENSION : cleaned;
}

export function normalizeOptionText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function cleanOptionLabel(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_OPTION_LABEL_LENGTH);
}

// Builds the lookup the publisher uses. Rows may come straight from Postgres
// (snake_case) or from a caller that already normalized them (camelCase).
export function buildOptionOverrideIndex(rows = []) {
  const index = new Map();
  if (!Array.isArray(rows)) return index;
  for (const row of rows) {
    if (!row) continue;
    const dimension = normalizeDimensionName(row.dimension_name ?? row.dimensionName);
    if (dimension !== DEFAULT_OPTION_DIMENSION) continue;
    const key = normalizeOptionText(row.source_text ?? row.sourceText);
    const label = cleanOptionLabel(row.display_label ?? row.displayLabel);
    if (!key || !label || key === normalizeOptionText(label)) continue;
    index.set(key, label);
  }
  return index;
}

// Resolves the display name for one captured/source option text.
export function resolveOptionDisplayLabel(index, sourceText) {
  if (!index || index.size === 0) return '';
  return index.get(normalizeOptionText(sourceText)) ?? '';
}

// Renames only the color entry of an option map, leaving size and every other
// dimension untouched.
export function applyOptionMapOverrides(options, index) {
  if (!options || typeof options !== 'object' || !index || index.size === 0) return options;
  const renamed = { ...options };
  for (const [key, value] of Object.entries(renamed)) {
    const dimension = normalizeDimensionName(key);
    if (dimension !== DEFAULT_OPTION_DIMENSION) continue;
    const label = resolveOptionDisplayLabel(index, value);
    if (label) renamed[key] = label;
  }
  return renamed;
}

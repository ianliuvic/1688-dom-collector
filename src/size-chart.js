import sharp from 'sharp';

const MAX_COLUMNS = 10;
const MAX_ROWS = 50;
const MAX_NAME = 120;
const MAX_LABEL = 80;
const MAX_UNIT = 24;
const MAX_CELL = 120;

const clean = (value, maxLength = MAX_CELL) => String(value ?? '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength);

const cleanKey = (value, fallback) => {
  const key = clean(value, 80).replace(/[^a-z0-9_-]/gi, '_').replace(/^_+|_+$/g, '');
  return key || fallback;
};

function column(key, label, unit = '') {
  return { key, label, unit };
}

function row(size, values) {
  return { size, values };
}

export const SIZE_CHART_PRESETS = [
  {
    id: 'wp-us-regular',
    name: 'US Regular',
    source: 'WordPress size guide',
    columns: [
      column('bust', 'Bust', 'in'),
      column('waist', 'Waist', 'in'),
      column('hip', 'Hip', 'in'),
      column('cup', 'Cup'),
    ],
    rows: [
      row('XS', { bust: '32', waist: '26', hip: '34', cup: '30C-30D 32A-32B' }),
      row('S', { bust: '34', waist: '28', hip: '36', cup: '32C-32D 34A-34B' }),
      row('M', { bust: '36', waist: '30', hip: '38', cup: '34C-34D 36A-36B' }),
      row('L', { bust: '38', waist: '32', hip: '40', cup: '36C-36D 38A-38B' }),
      row('XL', { bust: '42', waist: '36', hip: '44', cup: '38C-38D 40A-40C' }),
      row('2XL', { bust: '42', waist: '36', hip: '44', cup: '40C-40D 42B-42C' }),
      row('3XL', { bust: '44', waist: '38', hip: '46', cup: '42C-42D 44B-44C' }),
      row('4XL', { bust: '46', waist: '40', hip: '48', cup: '44C-44D 46B-46C' }),
    ],
  },
  {
    id: 'wp-girls-swimwear',
    name: "Girls' Swimwear",
    source: 'WordPress size guide',
    columns: [
      column('age', 'Age'),
      column('height', 'Height'),
      column('chest', 'Chest'),
      column('waist', 'Waist'),
      column('hip', 'Hip'),
    ],
    rows: [
      row('2', {
        age: '2Y',
        height: '33-35 in / 84-89 cm',
        chest: '20-21 in / 51-53 cm',
        waist: '19-20 in / 48-51 cm',
        hip: '21-22 in / 53-56 cm',
      }),
      row('4', {
        age: '4Y',
        height: '39-41 in / 99-104 cm',
        chest: '22-23 in / 56-58 cm',
        waist: '20-21 in / 51-53 cm',
        hip: '23-24 in / 58-61 cm',
      }),
      row('6', {
        age: '6Y',
        height: '45-47 in / 114-119 cm',
        chest: '24-25 in / 61-64 cm',
        waist: '21-22 in / 53-56 cm',
        hip: '25-26 in / 64-66 cm',
      }),
      row('8', {
        age: '8Y',
        height: '51-53 in / 130-135 cm',
        chest: '26-27 in / 66-69 cm',
        waist: '22-23 in / 56-58 cm',
        hip: '27-28 in / 69-71 cm',
      }),
      row('10', {
        age: '10Y',
        height: '55-57 in / 140-145 cm',
        chest: '28-29 in / 71-74 cm',
        waist: '23-24 in / 58-61 cm',
        hip: '29-30 in / 74-76 cm',
      }),
    ],
  },
];

export function normalizeSizeChart(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_size_chart');
  }
  const name = clean(input.name, MAX_NAME) || 'Size chart';
  const rawColumns = Array.isArray(input.columns) ? input.columns : [];
  if (!rawColumns.length || rawColumns.length > MAX_COLUMNS) {
    throw new Error('invalid_size_chart_columns');
  }
  const usedKeys = new Set();
  const columns = rawColumns.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid_size_chart_columns');
    const baseKey = cleanKey(entry.key || entry.label, `column_${index + 1}`);
    let key = baseKey;
    let suffix = 2;
    while (usedKeys.has(key)) key = `${baseKey}_${suffix++}`;
    usedKeys.add(key);
    return {
      key,
      label: clean(entry.label, MAX_LABEL) || `Column ${index + 1}`,
      unit: clean(entry.unit, MAX_UNIT),
    };
  });
  const rawRows = Array.isArray(input.rows) ? input.rows : [];
  if (!rawRows.length || rawRows.length > MAX_ROWS) {
    throw new Error('invalid_size_chart_rows');
  }
  const rows = rawRows.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid_size_chart_rows');
    const values = {};
    for (const column of columns) {
      values[column.key] = clean(entry.values?.[column.key] ?? entry[column.key], MAX_CELL);
    }
    return {
      size: clean(entry.size, MAX_LABEL) || `Size ${index + 1}`,
      values,
    };
  });
  return {
    presetId: clean(input.presetId, 80) || null,
    name,
    columns,
    rows,
  };
}

const escapeXml = (value) => String(value ?? '')
  .replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[character]));

const hasInchUnit = (value) => /(^|[^a-z])(in|inch|inches)([^a-z]|$)/i.test(String(value ?? ''));
const hasCentimeterUnit = (value) => /(^|[^a-z])(cm|centimeter|centimeters)([^a-z]|$)/i.test(String(value ?? ''));

function measurementUnit(value) {
  const inch = hasInchUnit(value);
  const centimeter = hasCentimeterUnit(value);
  if (inch && !centimeter) return 'in';
  if (centimeter && !inch) return 'cm';
  return '';
}

function formatNumber(value) {
  return String(Number(value.toFixed(1)));
}

export function formatMeasurement(value, unit) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const sourceUnit = measurementUnit(unit);
  if (!sourceUnit) return text;
  const valueHasInch = hasInchUnit(text);
  const valueHasCentimeter = hasCentimeterUnit(text);
  if (valueHasInch && valueHasCentimeter) return text;
  const targetUnit = sourceUnit === 'in' ? 'cm' : 'in';
  const numbers = text.match(/\d+(?:\.\d+)?/g);
  if (!numbers?.length) return text;
  const converted = text.replace(/\d+(?:\.\d+)?/g, (number) => {
    const amount = Number(number);
    return formatNumber(sourceUnit === 'in' ? amount * 2.54 : amount / 2.54);
  });
  return `${text} ${valueHasInch || valueHasCentimeter ? '' : sourceUnit} / ${converted} ${targetUnit}`.replace(/\s+/g, ' ').trim();
}

function measurementHeader(column) {
  const unit = measurementUnit(column.unit);
  if (unit === 'cm') return `${column.label} (cm / in)`;
  if (unit === 'in') return `${column.label} (in / cm)`;
  return column.unit ? `${column.label} (${column.unit})` : column.label;
}

const textWidthLimit = (text, fontSize, maxWidth) => {
  const estimated = String(text ?? '').length * fontSize * 0.56;
  if (estimated <= maxWidth) return '';
  return ` textLength="${maxWidth}" lengthAdjust="spacingAndGlyphs"`;
};

function renderSizeChartSvg(chart) {
  const width = chart.columns.length > 6 ? 2100 : 1600;
  const margin = 70;
  const tableTop = 135;
  const headerHeight = 68;
  const rowHeight = 60;
  const footerHeight = 64;
  const tableWidth = width - margin * 2;
  const sizeColumnWidth = 180;
  const dataColumnWidth = (tableWidth - sizeColumnWidth) / chart.columns.length;
  const tableHeight = headerHeight + chart.rows.length * rowHeight;
  const height = tableTop + tableHeight + footerHeight;
  const headerY = tableTop + headerHeight / 2;
  const cellFontSize = chart.columns.length > 5 ? 19 : 21;
  const headerFontSize = chart.columns.length > 5 ? 18 : 20;

  const line = (x1, y1, x2, y2, strokeWidth = 1) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="${strokeWidth}"/>`;

  const centeredText = (text, x, y, fontSize, maxWidth) =>
    `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" fill="#000"${textWidthLimit(text, fontSize, maxWidth)}>${escapeXml(text)}</text>`;

  const headerLines = [
    line(margin, tableTop + headerHeight, margin + tableWidth, tableTop + headerHeight, 2),
    line(margin + sizeColumnWidth, tableTop, margin + sizeColumnWidth, tableTop + tableHeight, 1),
  ];
  for (let index = 1; index < chart.columns.length; index += 1) {
    const x = margin + sizeColumnWidth + dataColumnWidth * index;
    headerLines.push(line(x, tableTop, x, tableTop + tableHeight, 1));
  }
  for (let index = 1; index <= chart.rows.length; index += 1) {
    const y = tableTop + headerHeight + rowHeight * index;
    headerLines.push(line(margin, y, margin + tableWidth, y, 1));
  }

  const headerCells = [
    centeredText('Size', margin + sizeColumnWidth / 2, headerY, headerFontSize, sizeColumnWidth - 20),
    ...chart.columns.map((column, index) => {
      const label = measurementHeader(column);
      return centeredText(
        label,
        margin + sizeColumnWidth + dataColumnWidth * index + dataColumnWidth / 2,
        headerY,
        headerFontSize,
        dataColumnWidth - 20,
      );
    }),
  ];

  const bodyRows = chart.rows.map((row, rowIndex) => {
    const y = tableTop + headerHeight + rowHeight * rowIndex + rowHeight / 2;
    return [
      centeredText(row.size, margin + sizeColumnWidth / 2, y, cellFontSize, sizeColumnWidth - 20),
      ...chart.columns.map((column, columnIndex) => centeredText(
        formatMeasurement(row.values[column.key] ?? '', column.unit),
        margin + sizeColumnWidth + dataColumnWidth * columnIndex + dataColumnWidth / 2,
        y,
        cellFontSize,
        dataColumnWidth - 20,
      )),
    ].join('');
  }).join('');

  const titleFontSize = 42;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#fff"/>
  <text x="${margin}" y="70" font-family="Arial, Helvetica, sans-serif" font-size="${titleFontSize}" font-weight="700" fill="#000"${textWidthLimit(chart.name, titleFontSize, tableWidth)}>${escapeXml(chart.name)}</text>
  <rect x="${margin}" y="${tableTop}" width="${tableWidth}" height="${tableHeight}" fill="#fff" stroke="#000" stroke-width="2"/>
  ${headerLines.join('')}
  ${headerCells.join('')}
  ${bodyRows}
  <text x="${margin}" y="${height - 26}" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="#000">Measurements are for reference. Please allow 1-2 cm tolerance.</text>
</svg>`;
}

export async function renderSizeChartPng(input) {
  const chart = normalizeSizeChart(input);
  const svg = renderSizeChartSvg(chart);
  const png = await sharp(Buffer.from(svg, 'utf8'))
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { chart, png, svg };
}

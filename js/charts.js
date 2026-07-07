/* ============================================================================
   Gráficos SVG inline, sem biblioteca externa
   ============================================================================ */

const CHART_COLORS = { brand: '#0B416B', accent: '#1E9A95', warn: '#B8792B', bad: '#B8433A', good: '#1E8A5F', line: '#DCE2DF' };

function lineChartSVG(series, opts = {}) {
  const w = opts.width || 600, h = opts.height || 200, pad = 28;
  const values = series.map((p) => p.value);
  const max = Math.max(1, ...values) * 1.1;
  const min = Math.min(0, ...values);
  const x = (i) => pad + (i / Math.max(1, series.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);

  const path = series.map((p, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1)).join(' ');
  const area = path + ` L${x(series.length - 1).toFixed(1)} ${h - pad} L${x(0).toFixed(1)} ${h - pad} Z`;

  const gridLines = [0, 0.5, 1].map((f) => {
    const yy = pad + f * (h - pad * 2);
    return `<line x1="${pad}" y1="${yy.toFixed(1)}" x2="${w - pad}" y2="${yy.toFixed(1)}" stroke="${CHART_COLORS.line}" stroke-width="1"/>`;
  }).join('');

  const labels = series.map((p, i) => {
    if (series.length > 10 && i % Math.ceil(series.length / 8) !== 0) return '';
    return `<text x="${x(i).toFixed(1)}" y="${h - 6}" font-size="10" fill="#5B6B74" text-anchor="middle">${escapeHtml(p.label || '')}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px">
    ${gridLines}
    <path d="${area}" fill="${opts.color || CHART_COLORS.accent}" opacity="0.08"/>
    <path d="${path}" fill="none" stroke="${opts.color || CHART_COLORS.accent}" stroke-width="2.2" stroke-linejoin="round"/>
    ${series.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.6" fill="${opts.color || CHART_COLORS.accent}"/>`).join('')}
    ${labels}
  </svg>`;
}

function barChartSVG(series, opts = {}) {
  const w = opts.width || 600, h = opts.height || 200, pad = 28;
  const max = Math.max(1, ...series.map((p) => p.value)) * 1.15;
  const barW = (w - pad * 2) / series.length * 0.6;
  const gap = (w - pad * 2) / series.length;

  const bars = series.map((p, i) => {
    const bh = ((p.value / max) * (h - pad * 2));
    const bx = pad + i * gap + (gap - barW) / 2;
    const by = h - pad - bh;
    return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${p.color || opts.color || CHART_COLORS.brand}"/>`;
  }).join('');

  const labels = series.map((p, i) => {
    const bx = pad + i * gap + gap / 2;
    return `<text x="${bx.toFixed(1)}" y="${h - 6}" font-size="10" fill="#5B6B74" text-anchor="middle">${escapeHtml(p.label || '')}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px">
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${CHART_COLORS.line}"/>
    ${bars}${labels}
  </svg>`;
}

function donutChartSVG(segments, opts = {}) {
  const size = opts.size || 180, thickness = opts.thickness || 26;
  const r = (size - thickness) / 2, cx = size / 2, cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let acc = 0;
  const arcs = segments.filter((s) => s.value > 0).map((s) => {
    const len = (s.value / total) * circumference;
    const dasharray = `${len.toFixed(2)} ${(circumference - len).toFixed(2)}`;
    const dashoffset = (-acc).toFixed(2);
    acc += len;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${thickness}" stroke-dasharray="${dasharray}" stroke-dashoffset="${dashoffset}" transform="rotate(-90 ${cx} ${cy})"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${CHART_COLORS.line}" stroke-width="${thickness}"/>
    ${arcs}
  </svg>`;
}

function donutLegendHtml(segments) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return segments.map((s) => `
    <div class="flex items-center gap-8" style="font-size:12.5px">
      <span style="width:10px;height:10px;border-radius:50%;background:${s.color};display:inline-block;flex:none"></span>
      <span>${escapeHtml(s.label)}</span>
      <span class="text-soft mono" style="margin-left:auto">${formatNumber((s.value / total) * 100, 0)}%</span>
    </div>
  `).join('');
}

/* ============================================================================
   Gráficos SVG inline, sem biblioteca externa
   Todos os pontos têm <title> (tooltip nativo do navegador ao passar o mouse)
   e, quando cabe no espaço, um rótulo estático com o valor.
   ============================================================================ */

// Referenciam --chart-* (style.css), não --brand/--accent direto: um azul-marinho
// quase preto (--brand) funciona bem como fundo de botão mas some como LINHA de
// gráfico sobre um painel escuro — os tokens de gráfico são otimizados à parte
// e ganham uma variante mais clara em modo escuro sem mexer nos botões/links.
const CHART_COLORS = {
  brand: 'var(--chart-brand)', accent: 'var(--chart-accent)', warn: 'var(--chart-warn)',
  bad: 'var(--chart-bad)', good: 'var(--chart-good)', purple: 'var(--chart-purple)', line: 'var(--chart-line)',
};

// SVG usa viewBox fixo + width:100% — isso ESCALA o texto junto quando o
// container encolhe. Um viewBox pensado pra desktop (ex: 1180) fica com
// rótulo ilegível quando o CSS aperta ele num card de celular de ~320px.
// A correção é usar um viewBox MENOR em telas pequenas (perto de 1:1 com o
// container real), não só deixar o CSS encolher o mesmo desenho. Chame isso
// antes de montar `opts` de qualquer chart que apareça num card full-width.
function chartSize(desktopW, desktopH, mobileW, mobileH) {
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 640;
  return isMobile ? { width: mobileW, height: mobileH } : { width: desktopW, height: desktopH };
}

function lineChartSVG(series, opts = {}) {
  const w = opts.width || 600, h = opts.height || 200, pad = 28;
  const fmt = opts.valueFormatter || formatMoney;
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

  const showStaticLabels = series.length <= 14;

  const labels = series.map((p, i) => {
    if (series.length > 10 && i % Math.ceil(series.length / 8) !== 0) return '';
    return `<text x="${x(i).toFixed(1)}" y="${h - 6}" font-size="10" fill="var(--ink-soft)" text-anchor="middle">${escapeHtml(p.label || '')}</text>`;
  }).join('');

  const points = series.map((p, i) => `
    <circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.2" fill="${opts.color || CHART_COLORS.accent}">
      <title>${escapeHtml(p.label || '')}: ${escapeHtml(fmt(p.value))}</title>
    </circle>
    ${showStaticLabels ? `<text x="${x(i).toFixed(1)}" y="${(y(p.value) - 8).toFixed(1)}" font-size="9.5" fill="${opts.color || CHART_COLORS.accent}" text-anchor="middle" font-weight="700">${escapeHtml(fmt(p.value))}</text>` : ''}
  `).join('');

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px">
    ${gridLines}
    <path d="${area}" fill="${opts.color || CHART_COLORS.accent}" opacity="0.08"/>
    <path d="${path}" fill="none" stroke="${opts.color || CHART_COLORS.accent}" stroke-width="2.2" stroke-linejoin="round"/>
    ${points}
    ${labels}
  </svg>`;
}

// Curva suave (Q por ponto médio) com área preenchida — usada em projeções
// (poucos pontos, valores sempre visíveis, sem depender só do tooltip).
function areaChartSVG(series, opts = {}) {
  const w = opts.width || 600, h = opts.height || 220, pad = 32;
  const fmt = opts.valueFormatter || formatMoney;
  const color = opts.color || CHART_COLORS.purple;
  const values = series.map((p) => p.value);
  const max = Math.max(1, ...values) * 1.25;
  const min = 0;
  const x = (i) => pad + (i / Math.max(1, series.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
  const points = series.map((p, i) => ({ x: x(i), y: y(p.value) }));

  const smoothPath = (pts) => {
    if (pts.length < 2) return `M ${pts[0].x} ${pts[0].y}`;
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const midX = (pts[i].x + pts[i + 1].x) / 2;
      const midY = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q ${pts[i].x} ${pts[i].y} ${midX} ${midY}`;
    }
    const last = pts[pts.length - 1];
    d += ` Q ${last.x} ${last.y} ${last.x} ${last.y}`;
    return d;
  };

  const linePath = smoothPath(points);
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${h - pad} L ${points[0].x} ${h - pad} Z`;

  const gridLines = [0, 0.5, 1].map((f) => {
    const yy = pad + f * (h - pad * 2);
    return `<line x1="${pad}" y1="${yy.toFixed(1)}" x2="${w - pad}" y2="${yy.toFixed(1)}" stroke="${CHART_COLORS.line}" stroke-width="1"/>`;
  }).join('');

  // Mesmo critério de esparsamento do barChartSVG/lineChartSVG — com séries
  // longas (ex: 30 dias) mostrar rótulo em todo ponto vira poluição visual
  // ilegível, então só 1 a cada N pontos ganha rótulo estático (o valor
  // continua acessível via <title> no ponto, ao passar o mouse).
  const shouldShowLabel = (i) => series.length <= 10 || i % Math.ceil(series.length / 8) === 0;

  const labels = series.map((p, i) => shouldShowLabel(i) ? `<text x="${x(i).toFixed(1)}" y="${h - 8}" font-size="10" fill="var(--ink-soft)" text-anchor="middle">${escapeHtml(p.label || '')}</text>` : '').join('');
  // Rótulo de valor: sempre acima do ponto, com halo branco atrás e cor fixa
  // (--ink), nunca a mesma cor da linha — testado com valores caindo exatamente
  // sobre a linha e ficando ilegíveis quando usavam a mesma cor.
  //
  // Critério diferente do esparsamento por índice usado no eixo X: aqui o
  // rótulo aparece em TODO ponto com valor > 0 (ex: dia com recebimento),
  // pulando só pontos zerados (sem informação nenhuma pra mostrar) — e só
  // deixa de mostrar um ponto não-zero se ele cair perto demais do último
  // rótulo já desenhado (evita sobrepor texto quando há muitos dias
  // seguidos com valor). Antes disso o critério era "1 a cada N pontos"
  // fixo, que podia pular exatamente os dias com pico de valor e mostrar
  // só zeros — motivo real da reclamação "muitos picos sem número".
  const valueLabelMinGap = 46;
  let lastValueLabelX = -Infinity;
  const valueLabels = series.map((p, i) => {
    if (p.value <= 0) return '';
    const xi = x(i);
    if (xi - lastValueLabelX < valueLabelMinGap) return '';
    lastValueLabelX = xi;
    const ly = Math.max(12, y(p.value) - 12).toFixed(1);
    const txt = escapeHtml(fmt(p.value));
    return `
      <text x="${xi.toFixed(1)}" y="${ly}" font-size="10.5" fill="none" stroke="var(--panel)" stroke-width="3" text-anchor="middle" font-weight="700" paint-order="stroke">${txt}</text>
      <text x="${xi.toFixed(1)}" y="${ly}" font-size="10.5" fill="var(--ink)" text-anchor="middle" font-weight="700">${txt}</text>
    `;
  }).join('');
  const dots = series.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${series.length > 15 ? 2.2 : 3.5}" fill="var(--panel)" stroke="${color}" stroke-width="2"><title>${escapeHtml(p.label || '')}: ${escapeHtml(fmt(p.value))}</title></circle>`).join('');

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px">
    <defs>
      <linearGradient id="areaGrad${opts.gradId || ''}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${gridLines}
    <path d="${areaPath}" fill="url(#areaGrad${opts.gradId || ''})"/>
    <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>
    ${dots}
    ${valueLabels}
    ${labels}
  </svg>`;
}

function barChartSVG(series, opts = {}) {
  const w = opts.width || 600, h = opts.height || 200, pad = 28;
  const fmt = opts.valueFormatter || formatMoney;
  const max = Math.max(1, ...series.map((p) => p.value)) * 1.15;
  const barW = (w - pad * 2) / series.length * 0.6;
  const gap = (w - pad * 2) / series.length;
  // Com muitas barras (ex: 30 dias), mostrar rótulo em toda barra vira uma
  // faixa ilegível de texto sobreposto — mesmo padrão de espaçamento do
  // lineChartSVG: só mostra 1 a cada N pontos quando a série é longa. Usa o
  // MESMO critério pro rótulo de valor (em cima da barra) e pro rótulo do
  // eixo X, senão um mostraria mais pontos que o outro sem razão.
  const shouldShowLabel = (i) => series.length <= 10 || i % Math.ceil(series.length / 8) === 0;

  const bars = series.map((p, i) => {
    const bh = ((p.value / max) * (h - pad * 2));
    const bx = pad + i * gap + (gap - barW) / 2;
    const by = h - pad - bh;
    const color = p.color || opts.color || CHART_COLORS.brand;
    return `
      <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(bh, 1).toFixed(1)}" rx="3" fill="${color}">
        <title>${escapeHtml(p.label || '')}: ${escapeHtml(fmt(p.value))}</title>
      </rect>
      ${shouldShowLabel(i) ? `<text x="${(bx + barW / 2).toFixed(1)}" y="${Math.max(by - 5, 10).toFixed(1)}" font-size="9.5" fill="${color}" text-anchor="middle" font-weight="700">${escapeHtml(fmt(p.value))}</text>` : ''}
    `;
  }).join('');

  const labels = series.map((p, i) => {
    if (!shouldShowLabel(i)) return '';
    const bx = pad + i * gap + gap / 2;
    return `<text x="${bx.toFixed(1)}" y="${h - 6}" font-size="10" fill="var(--ink-soft)" text-anchor="middle">${escapeHtml(p.label || '')}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px">
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${CHART_COLORS.line}"/>
    ${bars}${labels}
  </svg>`;
}

function donutChartSVG(segments, opts = {}) {
  const size = opts.size || 180, thickness = opts.thickness || 26;
  const fmt = opts.valueFormatter || formatMoney;
  const r = (size - thickness) / 2, cx = size / 2, cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let acc = 0;
  const arcs = segments.filter((s) => s.value > 0).map((s) => {
    const len = (s.value / total) * circumference;
    const dasharray = `${len.toFixed(2)} ${(circumference - len).toFixed(2)}`;
    const dashoffset = (-acc).toFixed(2);
    acc += len;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${thickness}" stroke-dasharray="${dasharray}" stroke-dashoffset="${dashoffset}" transform="rotate(-90 ${cx} ${cy})"><title>${escapeHtml(s.label)}: ${escapeHtml(fmt(s.value))} (${formatNumber((s.value / total) * 100, 0)}%)</title></circle>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${CHART_COLORS.line}" stroke-width="${thickness}"/>
    ${arcs}
  </svg>`;
}

function donutLegendHtml(segments, opts = {}) {
  const fmt = opts.valueFormatter || formatMoney;
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return segments.map((s) => `
    <div class="flex items-center gap-8" style="font-size:12.5px">
      <span style="width:10px;height:10px;border-radius:50%;background:${s.color};display:inline-block;flex:none"></span>
      <span>${escapeHtml(s.label)}</span>
      <span class="text-soft mono" style="margin-left:8px">${escapeHtml(fmt(s.value))}</span>
      <span class="text-soft mono" style="margin-left:auto">${formatNumber((s.value / total) * 100, 0)}%</span>
    </div>
  `).join('');
}

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

// `width:100%` combinado com `max-width:${w}px` deixa o SVG estreito sempre
// que o card é mais largo que o viewBox pensado pro desktop (ex: 600px de
// gráfico dentro de um card de 900px+ em Relatórios) — sem `margin:0 auto`,
// um elemento mais estreito que o pai gruda na borda ESQUERDA por padrão
// (bug real reportado pelo usuário com print, 2026-08-03: barras de "Lucro
// por período" visualmente coladas no canto esquerdo do card). Todo SVG de
// gráfico abaixo (bar/line/area) precisa de `display:block;margin:0 auto`
// junto do `max-width` pra centralizar quando sobra espaço — replique isso
// em qualquer chart novo que use esse mesmo padrão de viewBox+max-width.

// Sparkline compacto (sem eixo, sem hover) — pensado pra ficar ao lado de um
// número "hero" grande, dando contexto de tendência sem competir por espaço
// com um gráfico completo. Cor fixa (default branco), porque hoje só é usado
// sobre fundo --hero-dark, que não muda entre os temas claro/escuro.
function sparklineSVG(series, opts = {}) {
  const w = opts.width || 110, h = opts.height || 34, pad = 3;
  const color = opts.color || '#fff';
  const values = series.map((p) => p.value);
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const x = (i) => pad + (i / Math.max(1, series.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
  const points = series.map((p, i) => ({ x: x(i), y: y(p.value) }));
  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${h - pad} L ${points[0].x.toFixed(1)} ${h - pad} Z`;
  const last = points[points.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:block">
    <path d="${areaPath}" fill="${color}" opacity="0.15"/>
    <path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.4" fill="${color}"/>
  </svg>`;
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

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px;display:block;margin:0 auto">
    ${gridLines}
    <path d="${area}" fill="${opts.color || CHART_COLORS.accent}" opacity="0.08"/>
    <path d="${path}" fill="none" stroke="${opts.color || CHART_COLORS.accent}" stroke-width="2.2" stroke-linejoin="round"/>
    ${points}
    ${labels}
  </svg>`;
}

// Área preenchida com crosshair + tooltip no hover — usada em projeções e
// tendências (Dashboard). Chame initAreaCharts(root) depois de inserir o
// HTML no DOM pra ligar a interação (mesmo padrão de attachMoneyMask/
// wirePasswordToggles: função de wiring chamada explicitamente pela tela).
let areaChartSeq = 0;
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

  // Segmentos retos ligando os pontos reais — a curva Bézier-por-ponto-médio
  // usada antes "cortava o canto" de qualquer pico isolado (a linha desenhada
  // nunca passava pelo ponto em si, só perto dele), fazendo o ponto/rótulo
  // parecerem flutuar acima da linha em picos altos — bug real reportado
  // pelo usuário com print (2026-07-31). Reta é a garantia mais simples de
  // que a linha SEMPRE toca cada dado.
  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${h - pad} L ${points[0].x.toFixed(1)} ${h - pad} Z`;

  const gridLines = [0, 0.5, 1].map((f) => {
    const yy = pad + f * (h - pad * 2);
    return `<line x1="${pad}" y1="${yy.toFixed(1)}" x2="${w - pad}" y2="${yy.toFixed(1)}" stroke="${CHART_COLORS.line}" stroke-width="1"/>`;
  }).join('');

  // Mesmo critério de esparsamento do barChartSVG/lineChartSVG pro eixo X —
  // com séries longas (ex: 30 dias), rótulo em todo ponto vira ilegível.
  const shouldShowLabel = (i) => series.length <= 10 || i % Math.ceil(series.length / 8) === 0;
  const labels = series.map((p, i) => shouldShowLabel(i) ? `<text x="${x(i).toFixed(1)}" y="${h - 8}" font-size="10" fill="var(--ink-soft)" text-anchor="middle">${escapeHtml(p.label || '')}</text>` : '').join('');

  // Rótulo de VALOR estático: só no pico do período e no último ponto — o
  // resto vive no hover (crosshair + tooltip, initAreaCharts abaixo). Antes
  // disso, quase todo ponto não-zero ganhava um número (só evitava sobrepor
  // por distância em X), lotando a tela de valores competindo entre si numa
  // série de 30 dias — a reclamação real era exatamente essa poluição
  // visual. Halo (stroke branco) atrás do texto continua, pros 2 rótulos
  // que sobram nunca ficarem ilegíveis em cima da linha/grade.
  let peakIdx = 0;
  series.forEach((p, i) => { if (p.value > series[peakIdx].value) peakIdx = i; });
  const lastIdx = series.length - 1;
  const staticLabelIdxs = new Set([peakIdx, lastIdx]);
  const valueLabels = series.map((p, i) => {
    if (!staticLabelIdxs.has(i) || p.value <= 0) return '';
    const xi = x(i);
    const ly = Math.max(12, y(p.value) - 12).toFixed(1);
    const anchor = i === lastIdx && i !== peakIdx ? 'end' : 'middle';
    const txt = escapeHtml(fmt(p.value));
    return `
      <text x="${xi.toFixed(1)}" y="${ly}" font-size="11" fill="none" stroke="var(--panel)" stroke-width="3" text-anchor="${anchor}" font-weight="700" paint-order="stroke">${txt}</text>
      <text x="${xi.toFixed(1)}" y="${ly}" font-size="11" fill="var(--ink)" text-anchor="${anchor}" font-weight="700">${txt}</text>
    `;
  }).join('');

  // Ponto = "superfície" (preenchido com a cor do painel) + anel na cor da
  // série — some no hover como um marcador maior, nunca some/aparece do zero.
  const dotR = series.length > 15 ? 2.6 : 3.6;
  const dots = series.map((p, i) => `<circle class="area-chart-dot" data-x="${points[i].x.toFixed(1)}" data-y="${points[i].y.toFixed(1)}" data-value="${p.value}" data-label="${escapeHtml(p.label || '')}" cx="${points[i].x.toFixed(1)}" cy="${points[i].y.toFixed(1)}" r="${dotR}" fill="var(--panel)" stroke="${color}" stroke-width="2"><title>${escapeHtml(p.label || '')}: ${escapeHtml(fmt(p.value))}</title></circle>`).join('');

  const chartId = 'ac' + (++areaChartSeq);
  return `<div class="area-chart" data-chart-id="${chartId}" data-dot-r="${dotR}" data-dot-r-active="${dotR + 1.8}" data-fmt="${opts.valueFormatterName === 'number' ? 'number' : 'money'}">
    <svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px;display:block;margin:0 auto" class="area-chart-svg">
      <defs>
        <linearGradient id="areaGrad${opts.gradId || ''}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <path d="${areaPath}" fill="url(#areaGrad${opts.gradId || ''})"/>
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <line class="area-chart-crosshair" x1="0" y1="${pad}" x2="0" y2="${h - pad}" stroke="var(--ink-soft)" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
      <g>${dots}</g>
      ${valueLabels}
      ${labels}
    </svg>
    <div class="area-chart-tooltip"><span class="area-chart-tooltip-key" style="background:${color}"></span><span class="area-chart-tooltip-val"></span><div class="area-chart-tooltip-lbl"></div></div>
  </div>`;
}

// Liga o crosshair + tooltip de hover em todo .area-chart dentro de `root`
// (chame depois de inserir o HTML no DOM — o innerHTML não preserva
// listeners, então isso precisa rodar a cada render, igual attachMoneyMask/
// wirePasswordToggles). Sem gate de "já ligado": cada render recria os
// elementos do zero (novo innerHTML), então os listeners antigos já foram
// descartados junto com os nós antigos — não há o que vazar.
function initAreaCharts(root) {
  (root || document).querySelectorAll('.area-chart').forEach((wrap) => {
    const svg = wrap.querySelector('.area-chart-svg');
    const crosshair = wrap.querySelector('.area-chart-crosshair');
    const dots = Array.from(wrap.querySelectorAll('.area-chart-dot'));
    const tooltip = wrap.querySelector('.area-chart-tooltip');
    if (!svg || !dots.length || !tooltip) return;
    const valEl = tooltip.querySelector('.area-chart-tooltip-val');
    const lblEl = tooltip.querySelector('.area-chart-tooltip-lbl');
    const baseR = Number(wrap.dataset.dotR);
    const activeR = Number(wrap.dataset.dotRActive);
    const fmtFn = wrap.dataset.fmt === 'number' ? formatNumber : formatMoney;
    const vb = svg.viewBox.baseVal;

    const move = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * vb.width;
      let nearest = dots[0], bestDist = Infinity;
      dots.forEach((d) => {
        const dist = Math.abs(Number(d.dataset.x) - px);
        if (dist < bestDist) { bestDist = dist; nearest = d; }
      });
      const px2 = Number(nearest.dataset.x), py = Number(nearest.dataset.y);
      crosshair.setAttribute('x1', px2); crosshair.setAttribute('x2', px2); crosshair.setAttribute('opacity', 1);
      dots.forEach((d) => d.setAttribute('r', d === nearest ? activeR : baseR));
      valEl.textContent = fmtFn(Number(nearest.dataset.value));
      lblEl.textContent = nearest.dataset.label;
      tooltip.style.left = ((px2 / vb.width) * 100) + '%';
      tooltip.style.top = ((py / vb.height) * 100) + '%';
      tooltip.style.opacity = '1';
    };
    const leave = () => {
      crosshair.setAttribute('opacity', 0);
      tooltip.style.opacity = '0';
      dots.forEach((d) => d.setAttribute('r', baseR));
    };
    wrap.addEventListener('mousemove', (e) => move(e.clientX));
    wrap.addEventListener('mouseleave', leave);
    wrap.addEventListener('touchmove', (e) => { if (e.touches[0]) move(e.touches[0].clientX); e.preventDefault(); }, { passive: false });
    wrap.addEventListener('touchend', leave);
  });
}

function barChartSVG(series, opts = {}) {
  const w = opts.width || 600, h = opts.height || 200, pad = 28;
  const fmt = opts.valueFormatter || formatMoney;
  const values = series.map((p) => p.value);
  // Diverging: quando a série tem valor negativo (ex: um período com
  // prejuízo, agora possível com o recurso de perda), a barra precisa
  // crescer PRA BAIXO a partir de uma linha de base real (y do valor 0),
  // não só travar numa altura mínima de 1px acima do zero — senão um mês
  // negativo aparecia como "quase zero" positivo em vez de prejuízo de
  // verdade (bug real reportado pelo usuário, 2026-08-03). Quando todos os
  // valores são >= 0 (caso mais comum), min fica 0 e o resultado é idêntico
  // ao comportamento antigo (baseline no rodapé, barra sempre pra cima).
  const hasNegative = values.some((v) => v < 0);
  const max = Math.max(1, ...values) * (hasNegative ? 1.25 : 1.15);
  const min = hasNegative ? Math.min(0, ...values) * 1.25 : 0;
  const range = max - min || 1;
  const y = (v) => h - pad - ((v - min) / range) * (h - pad * 2);
  const y0 = y(0); // linha de base (onde valor = 0)
  const barW = (w - pad * 2) / series.length * 0.6;
  const gap = (w - pad * 2) / series.length;
  // Com muitas barras (ex: 30 dias), mostrar rótulo em toda barra vira uma
  // faixa ilegível de texto sobreposto — mesmo padrão de espaçamento do
  // lineChartSVG: só mostra 1 a cada N pontos quando a série é longa. Usa o
  // MESMO critério pro rótulo de valor (em cima da barra) e pro rótulo do
  // eixo X, senão um mostraria mais pontos que o outro sem razão.
  const shouldShowLabel = (i) => series.length <= 10 || i % Math.ceil(series.length / 8) === 0;

  const bars = series.map((p, i) => {
    const yVal = y(p.value);
    const bh = Math.abs(y0 - yVal);
    const by = Math.min(y0, yVal);
    const bx = pad + i * gap + (gap - barW) / 2;
    const color = p.color || (p.value < 0 ? CHART_COLORS.bad : (opts.color || CHART_COLORS.brand));
    const labelY = p.value >= 0 ? Math.max(by - 5, 10) : Math.min(by + bh + 14, h - 4);
    return `
      <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(bh, 1).toFixed(1)}" rx="3" fill="${color}">
        <title>${escapeHtml(p.label || '')}: ${escapeHtml(fmt(p.value))}</title>
      </rect>
      ${shouldShowLabel(i) ? `<text x="${(bx + barW / 2).toFixed(1)}" y="${labelY.toFixed(1)}" font-size="9.5" fill="${color}" text-anchor="middle" font-weight="700">${escapeHtml(fmt(p.value))}</text>` : ''}
    `;
  }).join('');

  const labels = series.map((p, i) => {
    if (!shouldShowLabel(i)) return '';
    const bx = pad + i * gap + gap / 2;
    return `<text x="${bx.toFixed(1)}" y="${h - 6}" font-size="10" fill="var(--ink-soft)" text-anchor="middle">${escapeHtml(p.label || '')}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px;display:block;margin:0 auto">
    <line x1="${pad}" y1="${y0.toFixed(1)}" x2="${w - pad}" y2="${y0.toFixed(1)}" stroke="${CHART_COLORS.line}"/>
    ${bars}${labels}
  </svg>`;
}

function donutChartSVG(segments, opts = {}) {
  // Diferente dos outros charts (linha/barra/área), esse nunca recebia
  // chartSize() dos chamadores — o SVG saía sempre 180x180 fixo, mesmo width/
  // height (não percentual), então nunca encolhia de verdade no celular. Um
  // card estreito (~300px) com viewBox 180 ainda "cabe" tecnicamente, mas
  // fica desproporcional/grande perto dos outros elementos compactos da
  // tela — default menor no celular replica o mesmo cuidado que chartSize()
  // já dá aos outros tipos de gráfico.
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 640;
  const size = opts.size || (isMobile ? 128 : 180);
  const thickness = opts.thickness || Math.round(size / 6.9);
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
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="max-width:100%;height:auto;flex:none">
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

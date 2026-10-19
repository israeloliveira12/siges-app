/* ============================================================================
   Gráficos — Chart.js 4 (carregado por <script> no index.html, com SRI)

   Cada função pública devolve HTML (um <canvas> dentro de um contêiner + a
   tabela equivalente para leitor de tela), exatamente como os antigos
   desenhos em SVG faziam — por isso as telas continuam montando o gráfico
   dentro de um template string, sem mudar o fluxo de render.

   Diferente do SVG, o canvas precisa de JavaScript DEPOIS de entrar no DOM.
   Isso é feito sozinho: um MutationObserver enxerga qualquer
   <canvas data-chart-id> novo e instancia o gráfico, e destrói os gráficos
   cujo canvas saiu da página (um innerHTML novo descarta os nós antigos mas
   NÃO o objeto Chart, que ficaria vivo com seu ResizeObserver). Nenhuma tela
   precisa lembrar de "ligar" nada nem de limpar nada.

   Por que as cores são resolvidas aqui e não deixadas em var(--x): o canvas
   não entende var(). E o modo escuro é escopado em #app (ver style.css), então
   a leitura é feita A PARTIR DO CANVAS, nunca do <html> — senão um gráfico
   no tema escuro pegaria as cores do claro.
   ============================================================================ */

// Referenciam --chart-* (style.css), não --brand/--accent direto: um azul-marinho
// quase preto (--brand) funciona bem como fundo de botão mas some como LINHA de
// gráfico sobre um painel escuro — os tokens de gráfico são otimizados à parte
// e ganham uma variante mais clara em modo escuro sem mexer nos botões/links.
// Continuam como string 'var(--x)': são resolvidos em resolveChartColor().
const CHART_COLORS = {
  brand: 'var(--chart-brand)', accent: 'var(--chart-accent)', warn: 'var(--chart-warn)',
  bad: 'var(--chart-bad)', good: 'var(--chart-good)', purple: 'var(--chart-purple)', line: 'var(--chart-line)',
};

// Altura (e, por compatibilidade, largura) conforme o tamanho da tela. No
// Chart.js só a ALTURA importa: a largura é sempre a do contêiner, o que
// resolve de vez o problema antigo de gráfico estreito "concentrado no meio"
// de um card largo. Os chamadores continuam espalhando `...chartSize(...)`
// em `opts`, então nenhum deles precisou mudar.
function chartSize(desktopW, desktopH, mobileW, mobileH, tabletW, tabletH) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  if (vw <= 640) return { width: mobileW, height: mobileH };
  if (tabletW && vw <= 1024) return { width: tabletW, height: tabletH || desktopH };
  return { width: desktopW, height: desktopH };
}

// Série vazia: sem isto o Chart.js criaria um quadro em branco. Hoje nenhuma
// tela chega a passar array vazio (as séries nascem de generate-series de
// datas), mas é uma armadilha para o próximo gráfico que alguém adicionar.
function emptyChartHtml(msg) {
  return `<p class="text-soft text-sm" style="text-align:center;padding:18px 0;margin:0">${escapeHtml(msg || 'Sem dados no período.')}</p>`;
}

// Tabela equivalente ao gráfico, escondida visualmente mas lida por leitor de
// tela e alcançável por teclado (UX-05). Um <canvas> é uma imagem opaca para
// tecnologia assistiva — esta tabela é o que carrega os números de verdade.
function chartDataTable(series, opts = {}) {
  const fmt = opts.valueFormatter || formatMoney;
  const caption = opts.caption || 'Dados do gráfico';
  return `
    <table class="sr-only-table">
      <caption>${escapeHtml(caption)}</caption>
      <thead><tr><th scope="col">${escapeHtml(opts.labelHeader || 'Período')}</th><th scope="col">${escapeHtml(opts.valueHeader || 'Valor')}</th></tr></thead>
      <tbody>${series.map((p) => `<tr><td>${escapeHtml(p.label || '')}</td><td>${escapeHtml(fmt(p.value))}</td></tr>`).join('')}</tbody>
    </table>`;
}

/* ---------------------------------------------------------------------------
   Infraestrutura: registro, tema, montagem e limpeza
--------------------------------------------------------------------------- */

// id -> { build(animate) -> config do Chart.js, chart, canvas, createdAt }
const CHART_REGISTRY = new Map();
let chartSeq = 0;

// Lê um token de cor a partir de um elemento (o canvas), respeitando o tema
// escopado em #app.
function resolveChartColor(color, el) {
  if (typeof color !== 'string' || !color.startsWith('var(')) return color;
  const name = color.slice(4, -1).split(',')[0].trim();
  const v = getComputedStyle(el || document.documentElement).getPropertyValue(name).trim();
  return v || '#8A9AA3';
}

// Converte '#rgb', '#rrggbb' ou 'rgb(...)' em rgba() com a transparência dada
// — usado nos degradês de preenchimento, que precisam da MESMA cor da linha.
function chartAlpha(color, alpha) {
  const c = String(color).trim();
  let m;
  if ((m = /^#([0-9a-f]{3})$/i.exec(c))) {
    const [r, g, b] = m[1].split('').map((h) => parseInt(h + h, 16));
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if ((m = /^#([0-9a-f]{6})$/i.exec(c))) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  if ((m = /^rgba?\(([^)]+)\)$/i.exec(c))) {
    const [r, g, b] = m[1].split(',').map((x) => parseFloat(x));
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return c;
}

function chartTheme(el) {
  const get = (name, fallback) => getComputedStyle(el).getPropertyValue(name).trim() || fallback;
  return {
    ink: get('--ink', '#14212B'),
    inkSoft: get('--ink-soft', '#5B6B74'),
    panel: get('--panel', '#FFFFFF'),
    grid: get('--chart-line', '#DCE2DF'),
    // Fixo nos dois temas (como o tooltip antigo e o toast): um tooltip escuro
    // precisa continuar escuro, senão o texto claro some em cima dele.
    tooltipBg: get('--hero-dark', '#05141F'),
    font: getComputedStyle(document.body).fontFamily || 'sans-serif',
    mono: get('--mono', 'ui-monospace, monospace'),
  };
}

const chartReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Rótulo compacto de eixo: "R$ 1,5 mil", "R$ 2,3 mi". O valor exato continua
// no tooltip e nos rótulos de pico — o eixo só dá a escala.
const chartCompactFmt = typeof Intl !== 'undefined'
  ? new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })
  : null;
function compactMoney(v) {
  const n = Number(v) || 0;
  if (!chartCompactFmt) return 'R$ ' + formatNumber(n, 0);
  return (n < 0 ? '-' : '') + 'R$ ' + chartCompactFmt.format(Math.abs(n));
}

// Formatador do EIXO Y. Se a tela passou um formatador de valor próprio (ex:
// "3 empresas"), o eixo mostra só inteiros — fração de empresa não existe.
function chartTickFormatter(opts) {
  if (opts.tickFormatter) return opts.tickFormatter;
  if (opts.valueFormatter) return (v) => (Number.isInteger(v) ? formatNumber(v, 0) : '');
  return compactMoney;
}

// Opções comuns de tooltip: pílula escura, cantos suaves, valor em fonte mono.
function chartTooltip(theme, extra = {}) {
  return {
    enabled: true,
    backgroundColor: theme.tooltipBg,
    titleColor: 'rgba(255,255,255,.65)',
    bodyColor: '#fff',
    borderColor: 'rgba(255,255,255,.12)',
    borderWidth: 1,
    cornerRadius: 10,
    padding: { top: 8, bottom: 8, left: 11, right: 11 },
    titleFont: { family: theme.font, size: 11, weight: '500' },
    bodyFont: { family: theme.mono, size: 13, weight: '700' },
    titleMarginBottom: 4,
    displayColors: true,
    usePointStyle: true,
    boxWidth: 8,
    boxHeight: 8,
    boxPadding: 4,
    caretSize: 5,
    caretPadding: 8,
    ...extra,
  };
}

/* ---------------------------------------------------------------------------
   Plugins inline (só valem para os gráficos deste arquivo)
--------------------------------------------------------------------------- */

// Linha vertical pontilhada no ponto sob o cursor — o "crosshair" que o
// gráfico de área antigo já tinha, agora para todo gráfico de linha.
const sigesCrosshair = {
  id: 'sigesCrosshair',
  beforeDatasetsDraw(chart, args, o) {
    if (!o || !o.color || !chart.tooltip) return;
    const active = chart.tooltip.getActiveElements();
    if (!active.length) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = o.color;
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// Rótulos de valor ESTÁTICOS (visíveis sem hover — importante no celular, onde
// não existe hover). Só nos índices que a tela escolheu, para não poluir:
// pico e último ponto nas linhas, todas as barras quando são poucas.
// Halo na cor do painel por trás do texto para nunca ficar ilegível sobre a
// linha ou a grade. O X é limitado às bordas do canvas, senão o rótulo do
// último ponto era cortado.
const sigesValueLabels = {
  id: 'sigesValueLabels',
  afterDatasetsDraw(chart, args, o) {
    if (!o || !o.indexes || !o.indexes.length) return;
    const meta = chart.getDatasetMeta(0);
    const data = chart.data.datasets[0].data;
    const { ctx, chartArea, width } = chart;
    // O ponto sob o cursor já mostra o valor no tooltip — o rótulo estático
    // dele ficaria espiando atrás da caixa, repetido e sujo.
    const hovered = chart.tooltip ? chart.tooltip.getActiveElements().map((a) => a.index) : [];
    const size = o.size || 11;
    ctx.save();
    ctx.font = `700 ${size}px ${o.family}`;
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';

    // Anticolisão: com poucos pixels por ponto (celular), rótulos vizinhos se
    // sobrepõem e viram uma mancha ilegível. Desenha primeiro o de MAIOR valor
    // (o pico nunca é sacrificado) e pula qualquer um que bata num já
    // desenhado. O valor de quem foi pulado continua no tooltip (toque/hover)
    // e na tabela de leitura.
    const drawn = [];
    const ordered = [...o.indexes].sort((a, b) => Math.abs(data[b]) - Math.abs(data[a]));
    ordered.forEach((i) => {
      const el = meta.data[i];
      if (!el || hovered.includes(i)) return;
      const v = data[i];
      const text = o.fmt(v);
      const tw = ctx.measureText(text).width;
      const x = Math.min(Math.max(el.x - tw / 2, 2), width - tw - 2);
      const y = v >= 0
        ? Math.max(el.y - 8, chartArea.top - 4)
        : Math.min(el.y + 16, chart.height - 4);
      const box = { x1: x - 4, x2: x + tw + 4, y1: y - size - 2, y2: y + 3 };
      if (drawn.some((d) => box.x1 < d.x2 && box.x2 > d.x1 && box.y1 < d.y2 && box.y2 > d.y1)) return;
      drawn.push(box);
      ctx.lineWidth = 3;
      ctx.strokeStyle = o.halo;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = o.colorAt ? o.colorAt(i) : o.color;
      ctx.fillText(text, x, y);
    });
    ctx.restore();
  },
};

/* ---------------------------------------------------------------------------
   Montagem
--------------------------------------------------------------------------- */

function registerChart(build) {
  const id = 'ch' + (++chartSeq);
  CHART_REGISTRY.set(id, { build, chart: null, canvas: null, createdAt: Date.now() });
  return id;
}

// HTML padrão de um gráfico: contêiner com ALTURA FIXA (o Chart.js responsivo
// precisa de um pai com dimensão própria, senão entra num ciclo de
// crescimento) + canvas + tabela para leitor de tela.
function chartShell(id, height, ariaLabel, series, opts) {
  return `<div class="chart-wrap">
    <div class="chart-canvas" style="height:${height}px">
      <canvas data-chart-id="${id}" role="img" aria-label="${escapeHtml(ariaLabel)}"></canvas>
    </div>
    ${chartDataTable(series, opts)}
  </div>`;
}

function mountChartCanvas(canvas) {
  if (canvas.dataset.chartMounted) return;
  const entry = CHART_REGISTRY.get(canvas.dataset.chartId);
  if (!entry) return;
  canvas.dataset.chartMounted = '1';

  // CDN bloqueada / sem rede / SRI recusado: o gráfico não existe, mas o dado
  // não pode sumir junto. Mostra a tabela (que já estava na página) no lugar.
  if (typeof Chart === 'undefined') {
    const wrap = canvas.closest('.chart-wrap');
    if (wrap) {
      wrap.classList.add('chart-failed');
      const box = wrap.querySelector('.chart-canvas');
      if (box) {
        box.style.height = 'auto';
        box.innerHTML = '<p class="text-soft text-sm" style="margin:0">Não foi possível carregar o gráfico agora. Os valores estão na tabela abaixo.</p>';
      }
    }
    return;
  }

  entry.canvas = canvas;
  entry.chart = new Chart(canvas, entry.build(true));
}

// Instancia todo canvas ainda não montado dentro de `root` e destrói os
// gráficos cujo canvas saiu do DOM. Idempotente.
function initCharts(root) {
  (root || document).querySelectorAll('canvas[data-chart-id]:not([data-chart-mounted])').forEach(mountChartCanvas);
  sweepCharts();
}

function sweepCharts() {
  const now = Date.now();
  CHART_REGISTRY.forEach((entry, id) => {
    if (entry.canvas) {
      if (!entry.canvas.isConnected) {
        if (entry.chart) entry.chart.destroy();
        CHART_REGISTRY.delete(id);
      }
    } else if (now - entry.createdAt > 15000 && !document.querySelector(`canvas[data-chart-id="${id}"]`)) {
      // HTML gerado mas nunca inserido na página (tela que descartou o render).
      CHART_REGISTRY.delete(id);
    }
  });
}

// Trocar o tema recria os gráficos vivos: as cores dos eixos, grade e tooltip
// foram lidas no momento da criação.
function restyleCharts() {
  CHART_REGISTRY.forEach((entry) => {
    if (!entry.canvas || !entry.chart || !entry.canvas.isConnected) return;
    entry.chart.destroy();
    entry.chart = new Chart(entry.canvas, entry.build(false));
  });
}

// Agrupa várias mutações seguidas numa única varredura. Usa setTimeout e NÃO
// requestAnimationFrame de propósito: o rAF é pausado pelo navegador em aba em
// segundo plano e em alguns webviews, e o gráfico simplesmente nunca nascia
// (os canvas ficavam vazios, em 300x150, até alguém forçar a montagem).
// Alinhar a criação a um quadro de pintura não traz nada aqui.
let chartSyncQueued = false;
function scheduleChartSync() {
  if (chartSyncQueued) return;
  chartSyncQueued = true;
  setTimeout(() => {
    chartSyncQueued = false;
    initCharts(document);
  }, 0);
}

if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
  new MutationObserver(scheduleChartSync).observe(document.body || document.documentElement, { childList: true, subtree: true });
  new MutationObserver(() => { if (typeof Chart !== 'undefined') restyleCharts(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/* ---------------------------------------------------------------------------
   Opções base compartilhadas pelos gráficos cartesianos
--------------------------------------------------------------------------- */

function cartesianOptions(theme, series, opts, { hasNegative, animate }) {
  const fmtTick = chartTickFormatter(opts);
  const many = series.length > 10;
  const narrow = typeof window !== 'undefined' && window.innerWidth <= 640;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: animate && !chartReducedMotion() ? { duration: 750, easing: 'easeOutQuart' } : false,
    // Folga em cima para o rótulo do pico não ser cortado.
    layout: { padding: { top: 16, right: 6, left: 0, bottom: 0 } },
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: {
        grid: { display: false },
        border: { display: false },
        ticks: {
          color: theme.inkSoft,
          font: { family: theme.font, size: 11 },
          maxRotation: 0,
          autoSkip: true,
          // Tela estreita comporta menos datas lado a lado; sem isto os
          // rótulos "01/10 05/10 09/10..." ficam colados no celular.
          maxTicksLimit: narrow ? (many ? 5 : 6) : (many ? 8 : 12),
          padding: 6,
        },
      },
      y: {
        beginAtZero: true,
        grace: '10%',
        border: { display: false },
        grid: {
          color: (c) => (hasNegative && c.tick && c.tick.value === 0 ? chartAlpha(theme.inkSoft, 0.55) : theme.grid),
          lineWidth: 1,
          drawTicks: false,
        },
        ticks: {
          color: theme.inkSoft,
          font: { family: theme.font, size: 11 },
          maxTicksLimit: 5,
          padding: 10,
          callback: (v) => fmtTick(v),
        },
      },
    },
  };
}

// Índices do pico e do último ponto (valores > 0), sem repetir.
function peakAndLast(series) {
  let peak = 0;
  series.forEach((p, i) => { if (p.value > series[peak].value) peak = i; });
  const last = series.length - 1;
  return [...new Set([peak, last])].filter((i) => series[i].value > 0);
}

/* ---------------------------------------------------------------------------
   Linha e área
   Curva SUAVE por interpolação monotônica (cubicInterpolationMode:'monotone'),
   não por `tension`. A razão é histórica: a curva Bézier por ponto-médio que
   este sistema já usou "cortava o canto" de picos isolados — a linha passava
   perto do ponto, não por ele, e o rótulo parecia flutuar (bug real, relatado
   com print em 2026-07-31) — e `tension` pode ainda ultrapassar o zero e
   desenhar valor negativo onde não existe. A monotônica é suave E garante que
   a linha toca todos os pontos, sem nunca passar de um valor ao seguinte.
--------------------------------------------------------------------------- */

function lineLikeChart(series, opts, { filled }) {
  if (!series || !series.length) return emptyChartHtml(opts.emptyMessage);
  const fmt = opts.valueFormatter || formatMoney;
  const h = opts.height || (filled ? 220 : 200);
  const caption = opts.caption || (filled ? 'Gráfico de área' : 'Gráfico de linha');
  const hasNegative = series.some((p) => p.value < 0);

  const id = registerChart((animate) => {
    const canvas = CHART_REGISTRY.get(id).canvas;
    const theme = chartTheme(canvas);
    const color = resolveChartColor(opts.color || CHART_COLORS.accent, canvas);
    const n = series.length;
    const [a0, a1] = filled ? [0.34, 0.02] : [0.14, 0];
    const options = cartesianOptions(theme, series, opts, { hasNegative, animate });
    options.plugins = {
      legend: { display: false },
      tooltip: chartTooltip(theme, {
        callbacks: {
          title: (items) => (items[0] ? items[0].label : ''),
          label: (ctx) => ' ' + fmt(ctx.parsed.y),
          labelColor: () => ({ borderColor: color, backgroundColor: color, borderRadius: 4 }),
        },
      }),
      sigesCrosshair: { color: chartAlpha(theme.inkSoft, 0.7) },
      sigesValueLabels: {
        indexes: peakAndLast(series),
        fmt, color: theme.ink, halo: theme.panel, family: theme.font, size: 11,
      },
    };
    return {
      type: 'line',
      data: {
        labels: series.map((p) => p.label || ''),
        datasets: [{
          data: series.map((p) => p.value),
          borderColor: color,
          borderWidth: 2.5,
          borderCapStyle: 'round',
          borderJoinStyle: 'round',
          cubicInterpolationMode: 'monotone',
          fill: 'origin',
          backgroundColor: (ctx) => {
            const { chart } = ctx;
            if (!chart.chartArea) return chartAlpha(color, 0.12);
            const g = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
            g.addColorStop(0, chartAlpha(color, a0));
            g.addColorStop(1, chartAlpha(color, a1));
            return g;
          },
          // Ponto = "superfície" (cor do painel) com anel na cor da série;
          // cresce e se preenche no hover. Em séries longas some, para a linha
          // não virar um colar de bolinhas.
          pointRadius: n > 20 ? 0 : (n > 12 ? 2.5 : 3.8),
          pointHoverRadius: 6.5,
          pointBackgroundColor: theme.panel,
          pointBorderColor: color,
          pointBorderWidth: 2,
          pointHoverBackgroundColor: color,
          pointHoverBorderColor: theme.panel,
          pointHoverBorderWidth: 2.5,
          pointHitRadius: 24,
        }],
      },
      options,
      plugins: [sigesCrosshair, sigesValueLabels],
    };
  });

  return chartShell(id, h, caption, series, { ...opts, valueFormatter: fmt });
}

function lineChart(series, opts = {}) { return lineLikeChart(series, opts, { filled: false }); }
function areaChart(series, opts = {}) { return lineLikeChart(series, opts, { filled: true }); }

/* ---------------------------------------------------------------------------
   Barras
--------------------------------------------------------------------------- */

function barChart(series, opts = {}) {
  if (!series || !series.length) return emptyChartHtml(opts.emptyMessage);
  const fmt = opts.valueFormatter || formatMoney;
  const h = opts.height || 200;
  const hasNegative = series.some((p) => p.value < 0);

  const id = registerChart((animate) => {
    const canvas = CHART_REGISTRY.get(id).canvas;
    const theme = chartTheme(canvas);
    const base = resolveChartColor(opts.color || CHART_COLORS.brand, canvas);
    const bad = resolveChartColor(CHART_COLORS.bad, canvas);
    // Valor negativo (período com prejuízo, possível com o recurso de perda)
    // SEMPRE em vermelho, salvo cor explícita da barra.
    const colors = series.map((p) => (p.color ? resolveChartColor(p.color, canvas) : (p.value < 0 ? bad : base)));

    // Poucas barras: rotula todas as não-nulas. Muitas: só pico e último —
    // com 30 barras um rótulo em cada uma vira faixa ilegível.
    const labelIdx = series.length <= 10
      ? series.map((p, i) => i).filter((i) => series[i].value !== 0)
      : peakAndLast(series);

    const options = cartesianOptions(theme, series, opts, { hasNegative, animate });
    options.plugins = {
      legend: { display: false },
      tooltip: chartTooltip(theme, {
        callbacks: {
          title: (items) => (items[0] ? items[0].label : ''),
          label: (ctx) => ' ' + fmt(ctx.parsed.y),
          labelColor: (ctx) => ({ borderColor: colors[ctx.dataIndex], backgroundColor: colors[ctx.dataIndex], borderRadius: 4 }),
        },
      }),
      sigesValueLabels: {
        indexes: labelIdx,
        fmt, colorAt: (i) => colors[i], halo: theme.panel, family: theme.font, size: 11,
      },
    };

    // UMA função que escolhe a cor pelo índice da barra. Não pode ser um array
    // de funções ([fn, fn]): o Chart.js só resolve como "scriptable" quando a
    // opção INTEIRA é uma função; num array, cada função seria lida como se
    // fosse uma cor — e a barra saía preta.
    const gradient = (ctx) => {
      const c = colors[ctx.dataIndex];
      const { chart } = ctx;
      if (!chart.chartArea) return c;
      const g = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
      g.addColorStop(0, c);
      g.addColorStop(1, chartAlpha(c, 0.62));
      return g;
    };

    return {
      type: 'bar',
      data: {
        labels: series.map((p) => p.label || ''),
        datasets: [{
          data: series.map((p) => p.value),
          backgroundColor: hasNegative ? colors : gradient,
          hoverBackgroundColor: colors,
          borderRadius: 7,
          // Só a ponta livre arredonda (topo da barra positiva, base da
          // negativa); o lado que encosta no zero fica reto.
          borderSkipped: 'start',
          // Teto de largura: sem ele, 2 barras num gráfico largo viram lajes.
          maxBarThickness: opts.maxBarWidth || 64,
          categoryPercentage: 0.78,
          barPercentage: 0.78,
        }],
      },
      options,
      plugins: [sigesValueLabels],
    };
  });

  return chartShell(id, h, opts.caption || 'Gráfico de barras', series, { ...opts, valueFormatter: fmt });
}

/* ---------------------------------------------------------------------------
   Rosca (a legenda continua sendo HTML — donutLegendHtml — porque ali o texto
   é real, selecionável e lido por leitor de tela)
--------------------------------------------------------------------------- */

function donutChart(segments, opts = {}) {
  // Mesmo cuidado do SVG antigo: um card estreito de celular não comporta a
  // rosca de 180px, que ficava desproporcional ao lado dos elementos compactos.
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 640;
  const size = opts.size || (isMobile ? 128 : 180);
  const fmt = opts.valueFormatter || formatMoney;
  const shown = segments.filter((s) => s.value > 0);
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const box = (id) => `<div style="width:${size}px;height:${size}px;max-width:100%;flex:none" aria-hidden="true"><canvas data-chart-id="${id}"></canvas></div>`;

  if (!shown.length) {
    // Sem nenhum valor positivo, anel neutro — mesmo comportamento do SVG.
    const id0 = registerChart(() => {
      const theme = chartTheme(CHART_REGISTRY.get(id0).canvas);
      return {
        type: 'doughnut',
        data: { labels: [''], datasets: [{ data: [1], backgroundColor: [theme.grid], borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '70%', animation: false, events: [], plugins: { legend: { display: false }, tooltip: { enabled: false } } },
      };
    });
    return box(id0);
  }

  const id = registerChart((animate) => {
    const canvas = CHART_REGISTRY.get(id).canvas;
    const theme = chartTheme(canvas);
    const colors = shown.map((s) => resolveChartColor(s.color, canvas));
    return {
      type: 'doughnut',
      data: {
        labels: shown.map((s) => s.label),
        datasets: [{
          data: shown.map((s) => s.value),
          backgroundColor: colors,
          // Borda na cor do painel + `spacing` = fatias separadas por uma
          // fresta limpa, com as pontas arredondadas.
          borderColor: theme.panel,
          borderWidth: 2,
          spacing: 2,
          borderRadius: 6,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '70%',
        animation: animate && !chartReducedMotion() ? { duration: 800, easing: 'easeOutQuart', animateRotate: true, animateScale: false } : false,
        layout: { padding: 6 },
        plugins: {
          legend: { display: false },
          tooltip: chartTooltip(theme, {
            callbacks: {
              title: () => '',
              label: (ctx) => ` ${ctx.label}: ${fmt(ctx.parsed)} (${formatNumber((ctx.parsed / total) * 100, 0)}%)`,
              labelColor: (ctx) => ({ borderColor: colors[ctx.dataIndex], backgroundColor: colors[ctx.dataIndex], borderRadius: 4 }),
            },
          }),
        },
      },
    };
  });

  // A legenda ao lado (donutLegendHtml) já expõe rótulo, valor e percentual em
  // texto real, então o canvas é decorativo — aria-hidden evita que o leitor
  // de tela leia a mesma informação duas vezes.
  return box(id);
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

/* ---------------------------------------------------------------------------
   Sparkline — compacto, sem eixo e sem hover, ao lado de um número "hero".
   Cor fixa (default branco): hoje só é usado sobre --hero-dark, que não muda
   entre os temas claro/escuro.
--------------------------------------------------------------------------- */

function sparkline(series, opts = {}) {
  if (!series || !series.length) return '';
  const w = opts.width || 110, h = opts.height || 34;
  const color = opts.color || '#fff';
  const lastIdx = series.length - 1;

  const id = registerChart((animate) => ({
    type: 'line',
    data: {
      labels: series.map((p) => p.label || ''),
      datasets: [{
        data: series.map((p) => p.value),
        borderColor: color,
        borderWidth: 1.8,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        cubicInterpolationMode: 'monotone',
        fill: 'origin',
        backgroundColor: chartAlpha(color, 0.15),
        // Só o último ponto aparece, como o círculo do SVG antigo.
        pointRadius: series.map((p, i) => (i === lastIdx ? 2.6 : 0)),
        pointBackgroundColor: color,
        pointBorderWidth: 0,
        pointHoverRadius: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: animate && !chartReducedMotion() ? { duration: 600, easing: 'easeOutQuart' } : false,
      events: [],
      layout: { padding: { top: 4, bottom: 3, left: 3, right: 5 } },
      scales: {
        x: { display: false },
        y: { display: false, beginAtZero: true, grace: '6%' },
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
  }));

  // Decorativo por definição (o número "herói" ao lado já diz o valor) —
  // aria-hidden evita que o leitor de tela leia um desenho sem significado.
  return `<div style="width:${w}px;height:${h}px;flex:none" aria-hidden="true"><canvas data-chart-id="${id}"></canvas></div>`;
}

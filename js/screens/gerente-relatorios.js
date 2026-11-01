/* ============================================================================
   Gerente — Relatórios gerenciais (Lucro Analítico, Fluxo de Caixa, Analítico)
   ============================================================================ */

let relatoriosTab = 'lucro';
let relatoriosPeriodo = 'ano'; // 'dia' | 'mes' | 'ano'
let relatoriosDia = todayISO();
let relatoriosMes = todayISO().slice(0, 7);
let relatoriosAno = todayISO().slice(0, 4);

function periodoRange() {
  if (relatoriosPeriodo === 'dia') {
    return { start: relatoriosDia, end: addDaysISO(relatoriosDia, 1), bucket: 'dia' };
  }
  if (relatoriosPeriodo === 'ano') {
    return { start: relatoriosAno + '-01-01', end: (Number(relatoriosAno) + 1) + '-01-01', bucket: 'mes' };
  }
  const start = relatoriosMes + '-01';
  // Último dia do mês via getDate() (lê o calendário LOCAL, sem conversão de
  // fuso) — a versão anterior passava por .toISOString() (sempre UTC), que
  // em qualquer fuso negativo (ex: Brasil) jogava a meia-noite local um dia
  // pra trás, fazendo o relatório de "mês" perder o último dia do mês.
  const lastDay = new Date(Number(relatoriosMes.slice(0, 4)), Number(relatoriosMes.slice(5, 7)), 0).getDate();
  const lastDayISO = relatoriosMes + '-' + String(lastDay).padStart(2, '0');
  const end = addDaysISO(lastDayISO, 1);
  return { start, end, bucket: 'dia' };
}

async function renderGerenteRelatorios() {
  const root = document.getElementById('screen-gerente-relatorios');
  root.innerHTML = `
    <div class="flex justify-between items-center gap-10" style="flex-wrap:wrap">
      <div class="flex gap-8" style="flex-wrap:wrap">
        <button class="btn btn-sm ${relatoriosTab === 'lucro' ? 'btn-primary' : 'btn-outline'}" id="tab-lucro">Lucro Analítico</button>
        <button class="btn btn-sm ${relatoriosTab === 'fluxo' ? 'btn-primary' : 'btn-outline'}" id="tab-fluxo">Fluxo de Caixa</button>
        <button class="btn btn-sm ${relatoriosTab === 'analitico' ? 'btn-primary' : 'btn-outline'}" id="tab-analitico">Relatório Analítico</button>
        <button class="btn btn-sm ${relatoriosTab === 'renovacoes' ? 'btn-primary' : 'btn-outline'}" id="tab-renovacoes">Renovações</button>
        <button class="btn btn-sm ${relatoriosTab === 'clientes' ? 'btn-primary' : 'btn-outline'}" id="tab-clientes">Clientes (Pareto)</button>
        <button class="btn btn-sm ${relatoriosTab === 'risco' ? 'btn-primary' : 'btn-outline'}" id="tab-risco">Risco</button>
        <button class="btn btn-sm ${relatoriosTab === 'tendencia' ? 'btn-primary' : 'btn-outline'}" id="tab-tendencia">Tendência</button>
      </div>
      ${/* Risco e Tendência são um retrato do AGORA e do que já está
            contratado — o seletor de período não muda nada nelas, então some
            em vez de ficar na tela sem efeito. */''}
      <div class="flex gap-8 items-center ${REL_TABS_SEM_PERIODO.includes(relatoriosTab) ? 'hidden' : ''}">
        <div class="auth-tabs" style="margin:0">
          <button class="auth-tab ${relatoriosPeriodo === 'dia' ? 'active' : ''}" id="periodo-dia">Dia</button>
          <button class="auth-tab ${relatoriosPeriodo === 'mes' ? 'active' : ''}" id="periodo-mes">Mês</button>
          <button class="auth-tab ${relatoriosPeriodo === 'ano' ? 'active' : ''}" id="periodo-ano">Ano</button>
        </div>
        ${relatoriosPeriodo === 'dia' ? `<input type="date" id="relatorios-data" value="${relatoriosDia}">` : ''}
        ${relatoriosPeriodo === 'mes' ? `<input type="month" id="relatorios-data" value="${relatoriosMes}">` : ''}
        ${relatoriosPeriodo === 'ano' ? `<input type="number" id="relatorios-data" value="${relatoriosAno}" style="width:90px">` : ''}
      </div>
    </div>
    <div id="relatorios-body" class="mt-14"><div class="text-soft">Carregando...</div></div>
  `;
  document.getElementById('tab-lucro').onclick = () => { relatoriosTab = 'lucro'; renderGerenteRelatorios(); };
  document.getElementById('tab-fluxo').onclick = () => { relatoriosTab = 'fluxo'; renderGerenteRelatorios(); };
  document.getElementById('tab-analitico').onclick = () => { relatoriosTab = 'analitico'; renderGerenteRelatorios(); };
  ['renovacoes', 'clientes', 'risco', 'tendencia'].forEach((t) => {
    document.getElementById('tab-' + t).onclick = () => { relatoriosTab = t; renderGerenteRelatorios(); };
  });
  if (!REL_TABS_SEM_PERIODO.includes(relatoriosTab)) {
  document.getElementById('periodo-dia').onclick = () => { relatoriosPeriodo = 'dia'; renderGerenteRelatorios(); };
  document.getElementById('periodo-mes').onclick = () => { relatoriosPeriodo = 'mes'; renderGerenteRelatorios(); };
  document.getElementById('periodo-ano').onclick = () => { relatoriosPeriodo = 'ano'; renderGerenteRelatorios(); };
  document.getElementById('relatorios-data').onchange = (e) => {
    if (relatoriosPeriodo === 'dia') relatoriosDia = e.target.value;
    else if (relatoriosPeriodo === 'mes') relatoriosMes = e.target.value;
    else relatoriosAno = e.target.value;
    renderGerenteRelatorios();
  };
  }

  const body = document.getElementById('relatorios-body');

  const { start, end, bucket } = periodoRange();

  // Abas analíticas (migration_054). Cada uma busca só o que precisa — carregar
  // as nove RPCs a cada troca de aba seria desperdício e deixaria a tela lenta.
  if (REL_TABS_SEM_PERIODO.includes(relatoriosTab) || relatoriosTab === 'renovacoes' || relatoriosTab === 'clientes') {
    const faltaMigration = (e) => {
      if (!isMissingRpcError(e)) return false;
      body.innerHTML = missingMigrationHtml('as funções de análise do banco (migration_054)')
        .replace(/migration_048/g, 'migration_054');
      return true;
    };
    const falhou = (e) => {
      console.error('Erro ao carregar relatório analítico:', e);
      body.innerHTML = `<p class="auth-error">Não foi possível carregar este relatório agora. Recarregue a página ou tente novamente em instantes.</p>`;
    };

    if (relatoriosTab === 'renovacoes') {
      const [tot, ser] = await Promise.all([
        supa.rpc('report_renewals', { p_start: start, p_end: end }),
        supa.rpc('report_renewal_series', { p_start: start, p_end: end, p_bucket: bucket }),
      ]);
      if (faltaMigration(tot.error || ser.error)) return;
      if (tot.error || ser.error) return falhou(tot.error || ser.error);
      paintRelRenovacoes(body, tot.data, ser.data || [], bucket);
      initCharts(body);
      return;
    }
    if (relatoriosTab === 'clientes') {
      const res = await supa.rpc('report_client_pareto', { p_start: start, p_end: end, p_limit: 20 });
      if (faltaMigration(res.error)) return;
      if (res.error) return falhou(res.error);
      paintRelClientes(body, res.data || []);
      initCharts(body);
      return;
    }
    if (relatoriosTab === 'risco') {
      const [r, b] = await Promise.all([supa.rpc('report_risk'), supa.rpc('report_portfolio_breakdown')]);
      if (faltaMigration(r.error || b.error)) return;
      if (r.error || b.error) return falhou(r.error || b.error);
      paintRelRisco(body, r.data, b.data);
      initCharts(body);
      return;
    }
    const res = await supa.rpc('report_profit_trend', { p_months_back: 12, p_months_ahead: 6 });
    if (faltaMigration(res.error)) return;
    if (res.error) return falhou(res.error);
    paintRelTendencia(body, res.data || []);
    initCharts(body);
    return;
  }

  // FIN-01 (auditoria 2026-08-23): antes isto fazia `select('*')` sobre TODOS
  // os pagamentos e contratos do período e somava no navegador. Com o filtro
  // "Ano", são doze meses de linhas — e o PostgREST corta a resposta em 1.000
  // por padrão, então o relatório anual de qualquer empresa com volume real
  // mostrava MENOS dinheiro do que existia, sem erro nenhum na tela. Agora as
  // somas e a série por período vêm agregadas do banco, sem teto de linhas.
  const [totalsRes, seriesRes] = await Promise.all([
    supa.rpc('financial_totals', { p_start: start, p_end: end }),
    supa.rpc('financial_series', { p_start: start, p_end: end, p_bucket: bucket }),
  ]);

  const relErr = totalsRes.error || seriesRes.error;
  if (isMissingRpcError(relErr)) {
    body.innerHTML = missingMigrationHtml('as funções de totais do banco (financial_totals / financial_series)');
    return;
  }
  if (relErr) {
    console.error('Erro ao carregar relatório:', relErr);
    body.innerHTML = `<p class="auth-error">Não foi possível carregar o relatório agora. Recarregue a página ou tente novamente em instantes.</p>`;
    return;
  }

  const totals = totalsRes.data || {};
  const series = (seriesRes.data || []).map((r) => ({
    key: r.bucket,
    recebido: Number(r.recebido || 0),
    lucro: Number(r.lucro || 0),
    retorno: Number(r.retorno || 0),
    juros: Number(r.juros || 0),
    taxaEntrada: Number(r.taxa_entrada || 0),
    taxaSaida: Number(r.taxa_saida || 0),
    aporte: Number(r.aporte || 0),
    perda: Number(r.perda || 0),
  }));

  if (relatoriosTab === 'lucro') paintLucroAnalitico(totals, series, bucket);
  else if (relatoriosTab === 'fluxo') paintFluxoCaixa(totals, series, bucket);
  else paintRelatorioAnalitico(totals, series);
}

const numOf = (obj, key) => Number((obj || {})[key] || 0);

function bucketKey(dateStr, bucket) {
  return bucket === 'mes' ? String(dateStr).slice(0, 7) : String(dateStr).slice(0, 10);
}

function bucketLabel(key, bucket) {
  if (bucket === 'mes') {
    const [y, m] = key.split('-');
    const nomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    return nomes[Number(m) - 1] + '/' + y.slice(2);
  }
  return key.slice(8, 10);
}

// `totals` vem de financial_totals() e `series` de financial_series() — as
// duas somadas no banco. As funções abaixo só formatam; nenhuma soma dinheiro
// a partir de linhas cruas (ver comentário FIN-01 em renderGerenteRelatorios).
function paintLucroAnalitico(totals, series, bucket) {
  const body = document.getElementById('relatorios-body');

  // Lucro líquido do período = lucro dos pagamentos (net_profit, que já
  // desconta a taxa de entrada) − taxa de saída dos contratos − capital perdido.
  const netFor = (r) => r.lucro - r.taxaSaida - r.perda;
  const totalLucro = numOf(totals, 'net_profit') - numOf(totals, 'taxa_saida') - numOf(totals, 'perda');

  const todayKey = bucketKey(todayISO(), bucket);
  const hoje = series.find((r) => r.key === todayKey);
  const lucroHoje = hoje ? netFor(hoje) : 0;
  const retornoHoje = hoje ? hoje.retorno : 0;

  let melhor = null;
  series.forEach((r) => { if (!melhor || netFor(r) > netFor(melhor)) melhor = r; });

  const chartSeries = series.map((r) => ({ label: bucketLabel(r.key, bucket), value: netFor(r) }));

  body.innerHTML = `
    <div class="grid grid-4 kpi-grid-4">
      <div class="card stat-card"><div class="label">Lucro total no período</div><div class="value mono">${formatMoney(totalLucro)}</div></div>
      <div class="card stat-card"><div class="label">Retorno hoje (capital)</div><div class="value mono">${formatMoney(retornoHoje)}</div></div>
      <div class="card stat-card"><div class="label">Lucro hoje</div><div class="value mono">${formatMoney(lucroHoje)}</div></div>
      <div class="card stat-card">
        <div class="label">${bucket === 'mes' ? 'Mês' : 'Dia'} mais lucrativo</div>
        <div class="value mono">${melhor ? bucketLabel(melhor.key, bucket) : '—'}</div>
        ${melhor ? `<div class="text-sm text-soft mono mt-8">${formatMoney(netFor(melhor))}</div>` : ''}
      </div>
    </div>
    <div class="card mt-14">
      <h3 class="flex items-center gap-8">Lucro por período <span class="help-dot" title="Juros recebidos − taxa de saída dos contratos − taxas de entrada dos pagamentos − capital perdido">?</span></h3>
      <!-- Ocupa a largura cheia do card (o card interno chega a ~1200px numa
           .main de 1280): antes o viewBox era 600 com max-width de 600px, o
           que deixava o gráfico ilhado no meio de um card duas vezes maior.
           O degrau de 820 cobre notebook/tablet, onde 1180 seria espremido
           a ~70% e encolheria os rótulos junto. -->
      <div class="mt-8">${barChart(chartSeries, { color: CHART_COLORS.accent, caption: 'Lucro líquido por período', emptyMessage: 'Sem movimento neste período.', ...chartSize(1180, 260, 320, 200, 820, 230) })}</div>
    </div>
    <div class="card mt-14" style="padding:0">
      <table class="data-table table-scroll">
        <thead><tr><th>Período</th><th>Coletado</th><th>Retornado (capital)</th><th>Lucro líquido</th></tr></thead>
        <tbody>
          ${series.map((r) => `<tr><td data-label="Período">${bucket === 'mes' ? bucketLabel(r.key, bucket) : formatDate(r.key)}</td><td data-label="Coletado" class="mono">${formatMoney(r.recebido)}</td><td data-label="Retornado" class="mono">${formatMoney(r.retorno)}</td><td data-label="Lucro" class="mono">${formatMoney(netFor(r))}</td></tr>`).join('') || '<tr><td colspan="4" class="text-soft">Sem movimento.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function paintFluxoCaixa(totals, series, bucket) {
  const body = document.getElementById('relatorios-body');
  const recebido = numOf(totals, 'recebido');
  const aporte = numOf(totals, 'aporte');
  const exitFees = numOf(totals, 'taxa_saida');
  const entryFees = numOf(totals, 'taxa_entrada');
  const perdas = numOf(totals, 'perda');
  const lucroLiquido = numOf(totals, 'lucro_bruto') - exitFees - entryFees - perdas;

  const seriesIn = series.map((r) => ({ label: bucketLabel(r.key, bucket), value: r.recebido }));
  const seriesOut = series.map((r) => ({ label: bucketLabel(r.key, bucket), value: r.aporte }));

  body.innerHTML = `
    <div class="grid grid-3 kpi-grid-3">
      <div class="card stat-card"><div class="label">Aporte no período (contrato + taxa de saída)</div><div class="value mono">${formatMoney(aporte)}</div></div>
      <div class="card stat-card"><div class="label">Recebido no período</div><div class="value mono">${formatMoney(recebido)}</div></div>
      <div class="card stat-card"><div class="label">Lucro líquido (juros − taxas − perdas)</div><div class="value mono">${formatMoney(lucroLiquido)}</div></div>
    </div>
    <div class="grid grid-2 mt-14">
      <div class="card">
        <h3>Recebido por período</h3>
        <div class="mt-8">${lineChart(seriesIn, { color: CHART_COLORS.good, caption: 'Recebido por período', emptyMessage: 'Sem dados.', ...chartSize(600, 200, 320, 200) })}</div>
      </div>
      <div class="card">
        <h3>Novo capital emprestado por período</h3>
        <div class="mt-8">${lineChart(seriesOut, { color: CHART_COLORS.brand, caption: 'Capital emprestado por período', emptyMessage: 'Sem dados.', ...chartSize(600, 200, 320, 200) })}</div>
      </div>
    </div>
  `;
}

function paintRelatorioAnalitico(totals, series) {
  const body = document.getElementById('relatorios-body');
  const entradas = numOf(totals, 'recebido');
  const saidas = numOf(totals, 'capital_emprestado');
  const juros = numOf(totals, 'lucro_bruto');
  const exitFees = numOf(totals, 'taxa_saida');
  const entryFees = numOf(totals, 'taxa_entrada');
  const perdas = numOf(totals, 'perda');

  const lucroLiquidoTotal = juros - exitFees - entryFees - perdas;

  body.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <h3>Composição do período</h3>
        <p class="text-sm text-soft mt-8">Entradas e saídas são 2 totais independentes (não somam "100%" de um mesmo todo) — comparadas em barra, não em rosca.</p>
        <div class="mt-14">${barChart([{ label: 'Entradas', value: entradas, color: CHART_COLORS.good }, { label: 'Saídas (novo crédito)', value: saidas, color: CHART_COLORS.brand }], { caption: 'Entradas e saídas do período', ...chartSize(320, 180, 300, 180) })}</div>
      </div>
      <div class="card">
        <h3>Resumo</h3>
        <div class="mt-14">
          <div class="ledger-row"><span class="text-soft">Entradas (recebimentos)</span><span class="v">${formatMoney(entradas)}</span></div>
          <div class="ledger-row"><span class="text-soft">Saídas (novo crédito)</span><span class="v">${formatMoney(saidas)}</span></div>
          <div class="ledger-row"><span class="text-soft">Juros recebidos (bruto)</span><span class="v">${formatMoney(juros)}</span></div>
          <div class="ledger-row"><span class="text-soft">Taxas de saída (contratos)</span><span class="v">${formatMoney(exitFees)}</span></div>
          <div class="ledger-row"><span class="text-soft">Taxas de entrada (recebimentos)</span><span class="v">${formatMoney(entryFees)}</span></div>
          <div class="ledger-row"><span class="text-soft">Capital em perda</span><span class="v" style="color:${perdas > 0 ? 'var(--bad)' : 'inherit'}">${formatMoney(perdas)}</span></div>
          <div class="ledger-row total"><span>Lucro líquido total</span><span class="v">${formatMoney(lucroLiquidoTotal)}</span></div>
        </div>
      </div>
    </div>
    <p class="text-sm text-soft mt-14">Metodologia: entradas somam todos os pagamentos recebidos no período (parcelas e renovações); saídas somam o valor bruto de novos contratos criados no período. Lucro líquido considera juros recebidos menos taxas operacionais de saída (desembolso) e de entrada (recebimento).</p>
  `;
}

registerRoute('gerente/relatorios', { role: 'gerente', screenId: 'gerente-relatorios', title: 'Relatórios Gerenciais', render: renderGerenteRelatorios });

/* ============================================================================
   Abas analíticas (migration_054)

   Separadas das três abas originais porque não compartilham a fonte de dados:
   Lucro/Fluxo/Analítico saem de financial_totals+financial_series, e cada uma
   destas tem a sua própria RPC. Duas delas (Risco e Tendência) são um retrato
   do AGORA e do que já está contratado, então o seletor de período não se
   aplica a elas — e some da tela em vez de ficar ali sem efeito.
   ============================================================================ */

// Abas que não usam o seletor Dia/Mês/Ano.
const REL_TABS_SEM_PERIODO = ['risco', 'tendencia'];

const relKpi = (label, valor, hint, cor) => `
  <div class="card stat-card">
    <div class="label">${label}</div>
    <div class="value mono"${cor ? ` style="color:${cor}"` : ''}>${valor}</div>
    ${hint ? `<div class="hint">${hint}</div>` : ''}
  </div>`;

const relLinha = (label, valor, cor) => `
  <div class="flex justify-between text-sm" style="padding:7px 0;border-bottom:1px solid var(--line)">
    <span class="text-soft">${label}</span><span class="mono"${cor ? ` style="color:${cor};font-weight:700"` : ''}>${valor}</span>
  </div>`;

// ---------------------------------------------------------------------------
// Renovações e prorrogações
// ---------------------------------------------------------------------------
function paintRelRenovacoes(body, dados, serie, bucket) {
  const d = dados || {};
  const totalEventos = Number(d.renovacoes_qtd || 0) + Number(d.prorrogacoes_qtd || 0);
  const lucroRenov = Number(d.renovacoes_lucro || 0) + Number(d.prorrogacoes_lucro || 0);
  const lucroTotal = lucroRenov + Number(d.quitacoes_lucro || 0);
  const serieRenov = serie.map((r) => ({ label: bucketLabel(bucketKey(r.periodo, bucket), bucket), value: Number(r.renovacoes || 0) }));
  const serieLucro = serie.map((r) => ({ label: bucketLabel(bucketKey(r.periodo, bucket), bucket), value: Number(r.lucro || 0) }));

  body.innerHTML = `
    <div class="grid grid-4">
      ${relKpi('Renovações no período', d.renovacoes_qtd, 'dívida rolada por mais um ciclo')}
      ${relKpi('Prorrogações no período', d.prorrogacoes_qtd, 'parcela e seguintes empurradas')}
      ${relKpi('Lucro com renovação', formatMoney(lucroRenov), totalEventos ? `${formatMoney(lucroRenov / totalEventos)} por evento` : 'nenhum evento', 'var(--good)')}
      ${relKpi('Peso no lucro total', lucroTotal > 0 ? formatNumber((lucroRenov / lucroTotal) * 100, 1) + '%' : '—', 'do lucro do período')}
    </div>

    <div class="card mt-14">
      <h3>Renovações x prorrogações por período</h3>
      <p class="text-sm text-soft mt-8">Quantos eventos de rolagem aconteceram em cada período.</p>
      ${serieRenov.some((x) => x.value > 0) || serie.some((r) => Number(r.prorrogacoes) > 0)
        ? barChart(serieRenov.map((x, i) => ({ ...x, value: x.value + Number(serie[i].prorrogacoes || 0) })),
            { color: CHART_COLORS.purple, caption: 'Eventos de rolagem por período',
              valueFormatter: (v) => formatNumber(v, 0) + (v === 1 ? ' evento' : ' eventos'),
              emptyMessage: 'Nenhuma renovação neste período.', ...chartSize(1180, 250, 320, 200, 820, 220) })
        : `<p class="text-soft text-sm mt-8">Nenhuma renovação ou prorrogação neste período.</p>`}
    </div>

    <div class="card mt-14">
      <h3>Lucro gerado por rolagem</h3>
      <p class="text-sm text-soft mt-8">Juros recebidos em renovações e prorrogações — receita que não existe quando o cliente simplesmente quita.</p>
      ${serieLucro.some((x) => x.value !== 0)
        ? areaChart(serieLucro, { color: CHART_COLORS.good, caption: 'Lucro de renovação por período', ...chartSize(1180, 250, 320, 200, 820, 220) })
        : `<p class="text-soft text-sm mt-8">Sem lucro de renovação neste período.</p>`}
    </div>

    <div class="grid grid-2 mt-14">
      <div class="card">
        <h3>Composição do lucro no período</h3>
        <div class="mt-14">
          ${relLinha('Lucro de quitações', formatMoney(d.quitacoes_lucro))}
          ${relLinha('Lucro de renovações (ciclo)', formatMoney(d.renovacoes_lucro))}
          ${relLinha('Lucro de prorrogações (parcela)', formatMoney(d.prorrogacoes_lucro))}
          ${relLinha('Total', formatMoney(lucroTotal), 'var(--good)')}
        </div>
      </div>
      <div class="card">
        <h3>Situação geral</h3>
        <div class="mt-14">
          ${relLinha('Quitações no período', d.quitacoes_qtd)}
          ${relLinha('Contratos que já renovaram alguma vez', d.contratos_com_renovacao)}
          ${relLinha('Ciclos de renovação em aberto hoje', d.ciclos_abertos)}
        </div>
        <p class="text-sm text-soft mt-14">
          Renovação e prorrogação são registradas com o mesmo tipo de pagamento;
          o que as separa é o alvo — a renovação rola a dívida inteira do contrato
          de parcela única, a prorrogação empurra uma parcela e as seguintes.
        </p>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Risco da carteira
// ---------------------------------------------------------------------------
function paintRelRisco(body, risco, breakdown) {
  const r = risco || {};
  const b = breakdown || {};
  const pctRisco = Number(r.percentual_risco || 0);
  const corRisco = pctRisco >= 20 ? 'var(--bad)' : pctRisco >= 10 ? 'var(--warn)' : 'var(--good)';
  const aging = (r.aging || []).map((x) => ({ label: x.faixa, value: Number(x.valor || 0) }));
  const porScore = (b.por_score || []).map((x) => ({ label: x.tier, value: Number(x.valor || 0) }));
  const porGrupo = (b.por_grupo || []).map((x) => ({ label: x.grupo, value: Number(x.valor || 0) }));
  const tierCor = { Excelente: CHART_COLORS.good, Bom: CHART_COLORS.accent, 'Atenção': CHART_COLORS.warn, 'Crítico': CHART_COLORS.bad };

  body.innerHTML = `
    <div class="grid grid-4">
      ${relKpi('Carteira ativa', formatMoney(r.carteira_ativa), 'tudo que falta receber')}
      ${relKpi('Em atraso', formatMoney(r.em_atraso), `${r.clientes_em_atraso} cliente${Number(r.clientes_em_atraso) === 1 ? '' : 's'}`, Number(r.em_atraso) > 0 ? 'var(--bad)' : null)}
      ${relKpi('Percentual em risco', formatNumber(pctRisco, 2) + '%', 'da carteira ativa', corRisco)}
      ${relKpi('Prejuízo reconhecido', formatMoney(r.prejuizo_reconhecido), 'capital já abatido do lucro', Number(r.prejuizo_reconhecido) > 0 ? 'var(--bad)' : null)}
    </div>

    <div class="card mt-14" style="border-color:${corRisco}">
      <h3>Leitura do risco</h3>
      <p class="text-sm mt-8">
        ${pctRisco === 0
          ? 'Nenhum valor vencido na carteira neste momento.'
          : `<strong class="mono" style="color:${corRisco}">${formatNumber(pctRisco, 2)}%</strong> da carteira está vencida —
             ${formatMoney(r.em_atraso)} de ${formatMoney(r.carteira_ativa)}, concentrados em
             ${r.clientes_em_atraso} de ${r.clientes_ativos} cliente${Number(r.clientes_ativos) === 1 ? '' : 's'} com contrato aberto.
             ${pctRisco >= 20 ? 'Acima de 20% é um nível que pede ação de cobrança imediata.' : pctRisco >= 10 ? 'Entre 10% e 20% é um nível de atenção.' : 'Abaixo de 10% é um nível administrável.'}`}
      </p>
    </div>

    <div class="card mt-14">
      <h3>Há quanto tempo o dinheiro está vencido</h3>
      <p class="text-sm text-soft mt-8">Quanto mais à direita, menor a chance de recuperar.</p>
      ${aging.length
        ? barChart(aging, { color: CHART_COLORS.bad, caption: 'Valor vencido por faixa de atraso', ...chartSize(1180, 240, 320, 200, 820, 220) })
        : `<p class="text-soft text-sm mt-8">Nada vencido no momento.</p>`}
    </div>

    <div class="grid grid-2 mt-14">
      <div class="card">
        <h3>Capital exposto por faixa de score</h3>
        <p class="text-sm text-soft mt-8">Concentrar dinheiro nos piores scores é o risco que o total sozinho não mostra.</p>
        ${porScore.length ? `
          <div class="flex gap-14 items-center mt-14" style="flex-wrap:wrap">
            ${donutChart(porScore.map((x) => ({ ...x, color: tierCor[x.label] || CHART_COLORS.brand })))}
            <div style="flex:1;min-width:200px">
              ${donutLegendHtml(porScore.map((x) => ({ ...x, color: tierCor[x.label] || CHART_COLORS.brand })))}
            </div>
          </div>` : `<p class="text-soft text-sm mt-8">Nenhum capital em aberto.</p>`}
      </div>
      <div class="card">
        <h3>Capital exposto por grupo</h3>
        <p class="text-sm text-soft mt-8">Onde o seu dinheiro está alocado hoje.</p>
        ${porGrupo.length
          ? barChart(porGrupo, { color: CHART_COLORS.brand, caption: 'Capital em aberto por grupo', ...chartSize(520, 230, 300, 200) })
          : `<p class="text-soft text-sm mt-8">Nenhum capital em aberto.</p>`}
      </div>
    </div>

    <div class="card mt-14">
      <h3>Contratos abertos por prazo</h3>
      ${(b.por_prazo || []).length ? `
      <table class="data-table table-scroll mt-8">
        <thead><tr><th>Prazo</th><th>Contratos</th><th>Capital contratado</th></tr></thead>
        <tbody>
          ${(b.por_prazo || []).map((x) => `
            <tr>
              <td data-label="Prazo">${escapeHtml(dueTypeLabel(x.prazo))}</td>
              <td data-label="Contratos" class="mono">${x.qtd}</td>
              <td data-label="Capital contratado" class="mono">${formatMoney(x.valor)}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : `<p class="text-soft text-sm mt-8">Nenhum contrato aberto.</p>`}
    </div>`;
}

// ---------------------------------------------------------------------------
// Tendência e projeção
// ---------------------------------------------------------------------------
function paintRelTendencia(body, linhas) {
  const dados = linhas || [];
  const passado = dados.filter((r) => !r.futuro);
  const futuro = dados.filter((r) => r.futuro);
  const serieReal = passado.map((r) => ({ label: formatDate(r.mes).slice(0, 5), value: Number(r.realizado || 0) }));
  const seriePrev = futuro.map((r) => ({ label: formatDate(r.mes).slice(0, 5), value: Number(r.previsto || 0) }));

  const realizados = passado.filter((r) => Number(r.realizado) > 0).map((r) => Number(r.realizado));
  const media = realizados.length ? realizados.reduce((s, v) => s + v, 0) / realizados.length : 0;
  const ultimos3 = realizados.slice(-3);
  const media3 = ultimos3.length ? ultimos3.reduce((s, v) => s + v, 0) / ultimos3.length : 0;
  const totalPrevisto = futuro.reduce((s, r) => s + Number(r.previsto || 0), 0);
  const tendencia = media > 0 ? ((media3 - media) / media) * 100 : 0;

  body.innerHTML = `
    <div class="grid grid-4">
      ${relKpi('Média mensal de lucro', formatMoney(media), `${realizados.length} ${realizados.length === 1 ? 'mês' : 'meses'} com movimento`)}
      ${relKpi('Média dos últimos 3 meses', formatMoney(media3), 'ritmo recente')}
      ${relKpi('Tendência', (tendencia >= 0 ? '+' : '') + formatNumber(tendencia, 1) + '%', 'ritmo recente vs. média geral', tendencia >= 0 ? 'var(--good)' : 'var(--bad)')}
      ${relKpi('Já contratado a receber', formatMoney(totalPrevisto), `juros dos próximos ${futuro.length} meses`, 'var(--purple, var(--chart-purple))')}
    </div>

    <div class="card mt-14">
      <h3>Lucro realizado — histórico</h3>
      <p class="text-sm text-soft mt-8">Lucro líquido efetivamente recebido em cada mês.</p>
      ${serieReal.some((x) => x.value !== 0)
        ? areaChart(serieReal, { color: CHART_COLORS.good, caption: 'Lucro realizado por mês', ...chartSize(1180, 260, 320, 200, 820, 230) })
        : `<p class="text-soft text-sm mt-8">Nenhum lucro registrado no período.</p>`}
    </div>

    <div class="card mt-14">
      <h3>Projeção dos próximos meses</h3>
      <p class="text-sm text-soft mt-8">
        Juros de parcelas e renovações <strong>já contratadas</strong> que vencem em cada mês.
        Não é uma extrapolação estatística: é o que está assinado. Meses sem vencimento aparecem zerados,
        e renovações futuras ainda não contratadas não entram aqui.
      </p>
      ${seriePrev.some((x) => x.value !== 0)
        ? barChart(seriePrev, { color: CHART_COLORS.purple, caption: 'Lucro previsto por mês', ...chartSize(1180, 250, 320, 200, 820, 220) })
        : `<p class="text-soft text-sm mt-8">Nenhum vencimento contratado para os próximos meses.</p>`}
    </div>

    <div class="card mt-14">
      <h3>Mês a mês</h3>
      <table class="data-table table-scroll mt-8">
        <thead><tr><th>Mês</th><th>Realizado</th><th>Previsto</th><th>Situação</th></tr></thead>
        <tbody>
          ${dados.map((r) => `
            <tr>
              <td data-label="Mês">${formatDate(r.mes)}</td>
              <td data-label="Realizado" class="mono">${Number(r.realizado) ? formatMoney(r.realizado) : '—'}</td>
              <td data-label="Previsto" class="mono">${Number(r.previsto) ? formatMoney(r.previsto) : '—'}</td>
              <td data-label="Situação">${r.futuro ? '<span class="badge badge-purple">A vencer</span>' : '<span class="badge badge-good">Fechado</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------------------
// Pareto de clientes
// ---------------------------------------------------------------------------
function paintRelClientes(body, linhas) {
  const dados = (linhas || []).map((r) => ({
    label: String(r.client_name || 'Sem nome').split(' ')[0] + (String(r.client_name || '').split(' ')[1] ? ' ' + String(r.client_name).split(' ')[1][0] + '.' : ''),
    nomeCompleto: r.client_name,
    value: Number(r.lucro || 0),
    recebido: Number(r.recebido || 0),
    contratos: Number(r.contratos || 0),
  })).filter((r) => r.value > 0);

  const total = dados.reduce((s, r) => s + r.value, 0);
  // Quantos clientes respondem por 80% do lucro — a leitura clássica do Pareto.
  let acc = 0, clientes80 = 0;
  [...dados].sort((a, b) => b.value - a.value).forEach((r) => {
    if (acc < total * 0.8) { acc += r.value; clientes80++; }
  });

  body.innerHTML = `
    <div class="grid grid-4">
      ${relKpi('Clientes que geraram lucro', dados.length, 'no período')}
      ${relKpi('Lucro somado', formatMoney(total), 'dos clientes listados', 'var(--good)')}
      ${relKpi('Concentração', dados.length ? `${clientes80} de ${dados.length}` : '—', 'clientes fazem 80% do lucro')}
      ${relKpi('Lucro médio por cliente', dados.length ? formatMoney(total / dados.length) : '—', 'no período')}
    </div>

    <div class="card mt-14">
      <h3>Pareto — quem responde pelo seu lucro</h3>
      <p class="text-sm text-soft mt-8">
        Barras: lucro de cada cliente, do maior para o menor. Linha: percentual acumulado.
        Onde a linha cruza 80% está o grupo que sustenta o resultado.
      </p>
      ${dados.length
        ? paretoChart(dados, { color: CHART_COLORS.brand, lineColor: CHART_COLORS.warn, caption: 'Lucro por cliente (Pareto)', ...chartSize(1180, 280, 320, 230, 820, 250) })
        : `<p class="text-soft text-sm mt-8">Nenhum lucro registrado neste período.</p>`}
    </div>

    <div class="card mt-14">
      <h3>Detalhamento</h3>
      ${dados.length ? `
      <table class="data-table table-scroll mt-8">
        <thead><tr><th>#</th><th>Cliente</th><th>Contratos</th><th>Recebido</th><th>Lucro</th><th>% do total</th></tr></thead>
        <tbody>
          ${[...dados].sort((a, b) => b.value - a.value).map((r, i) => `
            <tr>
              <td data-label="#" class="mono">${i + 1}</td>
              <td data-label="Cliente" class="wrap-text">${escapeHtml(r.nomeCompleto || 'Sem nome')}</td>
              <td data-label="Contratos" class="mono">${r.contratos}</td>
              <td data-label="Recebido" class="mono">${formatMoney(r.recebido)}</td>
              <td data-label="Lucro" class="mono" style="color:var(--good);font-weight:700">${formatMoney(r.value)}</td>
              <td data-label="% do total" class="mono">${total > 0 ? formatNumber((r.value / total) * 100, 1) : '0'}%</td>
            </tr>`).join('')}
        </tbody>
      </table>` : ''}
    </div>`;
}

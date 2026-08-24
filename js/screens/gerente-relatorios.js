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
      </div>
      <div class="flex gap-8 items-center">
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
  document.getElementById('periodo-dia').onclick = () => { relatoriosPeriodo = 'dia'; renderGerenteRelatorios(); };
  document.getElementById('periodo-mes').onclick = () => { relatoriosPeriodo = 'mes'; renderGerenteRelatorios(); };
  document.getElementById('periodo-ano').onclick = () => { relatoriosPeriodo = 'ano'; renderGerenteRelatorios(); };
  document.getElementById('relatorios-data').onchange = (e) => {
    if (relatoriosPeriodo === 'dia') relatoriosDia = e.target.value;
    else if (relatoriosPeriodo === 'mes') relatoriosMes = e.target.value;
    else relatoriosAno = e.target.value;
    renderGerenteRelatorios();
  };

  const body = document.getElementById('relatorios-body');

  const { start, end, bucket } = periodoRange();

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

  if (totalsRes.error || seriesRes.error) {
    console.error('Erro ao carregar relatório:', totalsRes.error || seriesRes.error);
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
      <div class="mt-8">${barChartSVG(chartSeries, { color: CHART_COLORS.accent, caption: 'Lucro líquido por período', emptyMessage: 'Sem movimento neste período.', ...chartSize(600, 200, 320, 200) })}</div>
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
        <div class="mt-8">${lineChartSVG(seriesIn, { color: CHART_COLORS.good, caption: 'Recebido por período', emptyMessage: 'Sem dados.', ...chartSize(600, 200, 320, 200) })}</div>
      </div>
      <div class="card">
        <h3>Novo capital emprestado por período</h3>
        <div class="mt-8">${lineChartSVG(seriesOut, { color: CHART_COLORS.brand, caption: 'Capital emprestado por período', emptyMessage: 'Sem dados.', ...chartSize(600, 200, 320, 200) })}</div>
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
        <div class="mt-14">${barChartSVG([{ label: 'Entradas', value: entradas, color: CHART_COLORS.good }, { label: 'Saídas (novo crédito)', value: saidas, color: CHART_COLORS.brand }], { caption: 'Entradas e saídas do período', ...chartSize(320, 180, 300, 180) })}</div>
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

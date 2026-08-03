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

  const [{ data: payments, error: pe1 }, { data: contracts, error: pe2 }, { data: lostInstallments, error: pe3 }, { data: lostCycles, error: pe4 }] = await Promise.all([
    supa.from('payments').select('*').gte('received_at', start).lt('received_at', end),
    supa.from('loan_contracts').select('*').gte('contract_date', start).lt('contract_date', end),
    // Perda reconhecida no período — sempre por loss_recognized_at (quando a
    // parcela/ciclo foi de fato baixado como perda), nunca due_date/
    // created_at, mesmo critério já usado no Dashboard.
    supa.from('installments').select('principal_lost, loss_recognized_at').eq('status', 'perda').gte('loss_recognized_at', start).lt('loss_recognized_at', end),
    supa.from('renewal_cycles').select('principal_lost, loss_recognized_at').eq('status', 'perda').gte('loss_recognized_at', start).lt('loss_recognized_at', end),
  ]);
  if (pe1 || pe2 || pe3 || pe4) {
    console.error('Erro ao carregar relatório:', pe1 || pe2 || pe3 || pe4);
    body.innerHTML = `<p class="auth-error">Não foi possível carregar o relatório agora. Recarregue a página ou tente novamente em instantes.</p>`;
    return;
  }
  const losses = [...(lostInstallments || []), ...(lostCycles || [])];

  if (relatoriosTab === 'lucro') paintLucroAnalitico(payments || [], contracts || [], bucket, losses);
  else if (relatoriosTab === 'fluxo') paintFluxoCaixa(payments || [], contracts || [], bucket, losses);
  else paintRelatorioAnalitico(payments || [], contracts || [], losses);
}

function bucketKey(dateStr, bucket) {
  return bucket === 'mes' ? String(dateStr).slice(0, 7) : String(dateStr).slice(0, 10);
}

function groupByBucket(rows, dateField, valueFields, bucket) {
  const map = {};
  rows.forEach((r) => {
    const key = bucketKey(r[dateField], bucket);
    map[key] = map[key] || Object.fromEntries(valueFields.map((f) => [f, 0]));
    valueFields.forEach((f) => { map[key][f] += Number(r[f] || 0); });
  });
  return map;
}

function bucketLabel(key, bucket) {
  if (bucket === 'mes') {
    const [y, m] = key.split('-');
    const nomes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    return nomes[Number(m) - 1] + '/' + y.slice(2);
  }
  return key.slice(8, 10);
}

function paintLucroAnalitico(payments, contracts, bucket, losses) {
  const body = document.getElementById('relatorios-body');
  const byBucketProfit = groupByBucket(payments, 'received_at', ['net_profit', 'principal_component', 'amount_received'], bucket);
  // Defesa em profundidade: só soma taxa de saída de contratos com o flag
  // has_operational_fee ativo — na prática o valor já vem zerado quando o
  // flag está desligado (JS sempre zera ao salvar), mas não vale a pena
  // confiar cegamente nisso num relatório financeiro agregado.
  const byBucketFees = groupByBucket(contracts.filter((c) => c.has_operational_fee), 'contract_date', ['operational_fee_amount'], bucket);
  const byBucketLoss = groupByBucket(losses || [], 'loss_recognized_at', ['principal_lost'], bucket);
  const keys = [...new Set([...Object.keys(byBucketProfit), ...Object.keys(byBucketFees), ...Object.keys(byBucketLoss)])].sort();

  const netFor = (k) => (byBucketProfit[k] ? byBucketProfit[k].net_profit : 0) - (byBucketFees[k] ? byBucketFees[k].operational_fee_amount : 0) - (byBucketLoss[k] ? byBucketLoss[k].principal_lost : 0);
  const totalLucro = keys.reduce((s, k) => s + netFor(k), 0);

  const todayKey = bucketKey(todayISO(), bucket);
  const lucroHoje = netFor(todayKey);
  const retornoHoje = byBucketProfit[todayKey] ? byBucketProfit[todayKey].principal_component : 0;

  let melhorDia = null;
  keys.forEach((k) => { if (!melhorDia || netFor(k) > netFor(melhorDia)) melhorDia = k; });

  const series = keys.map((k) => ({ label: bucketLabel(k, bucket), value: netFor(k) }));

  body.innerHTML = `
    <div class="grid grid-4 kpi-grid-4">
      <div class="card stat-card"><div class="label">Lucro total no período</div><div class="value mono">${formatMoney(totalLucro)}</div></div>
      <div class="card stat-card"><div class="label">Retorno hoje (capital)</div><div class="value mono">${formatMoney(retornoHoje)}</div></div>
      <div class="card stat-card"><div class="label">Lucro hoje</div><div class="value mono">${formatMoney(lucroHoje)}</div></div>
      <div class="card stat-card">
        <div class="label">${bucket === 'mes' ? 'Mês' : 'Dia'} mais lucrativo</div>
        <div class="value mono">${melhorDia ? bucketLabel(melhorDia, bucket) : '—'}</div>
        ${melhorDia ? `<div class="text-sm text-soft mono mt-8">${formatMoney(netFor(melhorDia))}</div>` : ''}
      </div>
    </div>
    <div class="card mt-14">
      <h3 class="flex items-center gap-8">Lucro por período <span class="help-dot" title="Juros recebidos − taxa de saída dos contratos − taxas de entrada dos pagamentos − capital perdido">?</span></h3>
      <div class="mt-8">${series.length ? barChartSVG(series, { color: CHART_COLORS.accent, ...chartSize(600, 200, 320, 200) }) : '<p class="text-soft text-sm">Sem movimento neste período.</p>'}</div>
    </div>
    <div class="card mt-14" style="padding:0">
      <table class="data-table table-scroll">
        <thead><tr><th>Período</th><th>Coletado</th><th>Retornado (capital)</th><th>Lucro líquido</th></tr></thead>
        <tbody>
          ${keys.map((k) => `<tr><td data-label="Período">${bucket === 'mes' ? bucketLabel(k, bucket) : formatDate(k)}</td><td data-label="Coletado" class="mono">${formatMoney(byBucketProfit[k] ? byBucketProfit[k].amount_received : 0)}</td><td data-label="Retornado" class="mono">${formatMoney(byBucketProfit[k] ? byBucketProfit[k].principal_component : 0)}</td><td data-label="Lucro" class="mono">${formatMoney(netFor(k))}</td></tr>`).join('') || '<tr><td colspan="4" class="text-soft">Sem movimento.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function paintFluxoCaixa(payments, contracts, bucket, losses) {
  const body = document.getElementById('relatorios-body');
  const recebido = payments.reduce((s, p) => s + Number(p.amount_received), 0);
  const aporte = contracts.reduce((s, c) => s + Number(c.total_disbursed_amount), 0);
  const exitFees = contracts.filter((c) => c.has_operational_fee).reduce((s, c) => s + Number(c.operational_fee_amount), 0);
  const entryFees = payments.filter((p) => p.has_operational_fee).reduce((s, p) => s + Number(p.operational_fee_amount), 0);
  const perdas = (losses || []).reduce((s, l) => s + Number(l.principal_lost || 0), 0);
  const lucroLiquido = payments.reduce((s, p) => s + Number(p.interest_component), 0) - exitFees - entryFees - perdas;

  const byBucketIn = groupByBucket(payments, 'received_at', ['amount_received'], bucket);
  const byBucketOut = groupByBucket(contracts, 'contract_date', ['total_disbursed_amount'], bucket);
  const allKeys = [...new Set([...Object.keys(byBucketIn), ...Object.keys(byBucketOut)])].sort();
  const seriesIn = allKeys.map((k) => ({ label: bucketLabel(k, bucket), value: (byBucketIn[k] || { amount_received: 0 }).amount_received }));
  const seriesOut = allKeys.map((k) => ({ label: bucketLabel(k, bucket), value: (byBucketOut[k] || { total_disbursed_amount: 0 }).total_disbursed_amount }));

  body.innerHTML = `
    <div class="grid grid-3 kpi-grid-3">
      <div class="card stat-card"><div class="label">Aporte no período (contrato + taxa de saída)</div><div class="value mono">${formatMoney(aporte)}</div></div>
      <div class="card stat-card"><div class="label">Recebido no período</div><div class="value mono">${formatMoney(recebido)}</div></div>
      <div class="card stat-card"><div class="label">Lucro líquido (juros − taxas − perdas)</div><div class="value mono">${formatMoney(lucroLiquido)}</div></div>
    </div>
    <div class="grid grid-2 mt-14">
      <div class="card">
        <h3>Recebido por período</h3>
        <div class="mt-8">${seriesIn.length ? lineChartSVG(seriesIn, { color: CHART_COLORS.good, ...chartSize(600, 200, 320, 200) }) : '<p class="text-soft text-sm">Sem dados.</p>'}</div>
      </div>
      <div class="card">
        <h3>Novo capital emprestado por período</h3>
        <div class="mt-8">${seriesOut.length ? lineChartSVG(seriesOut, { color: CHART_COLORS.brand, ...chartSize(600, 200, 320, 200) }) : '<p class="text-soft text-sm">Sem dados.</p>'}</div>
      </div>
    </div>
  `;
}

function paintRelatorioAnalitico(payments, contracts, losses) {
  const body = document.getElementById('relatorios-body');
  const entradas = payments.reduce((s, p) => s + Number(p.amount_received), 0);
  const saidas = contracts.reduce((s, c) => s + Number(c.principal_amount), 0);
  const juros = payments.reduce((s, p) => s + Number(p.interest_component), 0);
  const exitFees = contracts.filter((c) => c.has_operational_fee).reduce((s, c) => s + Number(c.operational_fee_amount), 0);
  const entryFees = payments.filter((p) => p.has_operational_fee).reduce((s, p) => s + Number(p.operational_fee_amount), 0);
  const perdas = (losses || []).reduce((s, l) => s + Number(l.principal_lost || 0), 0);

  const lucroLiquidoTotal = juros - exitFees - entryFees - perdas;

  body.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <h3>Composição do período</h3>
        <p class="text-sm text-soft mt-8">Entradas e saídas são 2 totais independentes (não somam "100%" de um mesmo todo) — comparadas em barra, não em rosca.</p>
        <div class="mt-14">${barChartSVG([{ label: 'Entradas', value: entradas, color: CHART_COLORS.good }, { label: 'Saídas (novo crédito)', value: saidas, color: CHART_COLORS.brand }], { ...chartSize(320, 180, 300, 180) })}</div>
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

/* ============================================================================
   Gerente — Relatórios gerenciais (Lucro Analítico, Fluxo de Caixa, Analítico)
   ============================================================================ */

let relatoriosTab = 'lucro';
let relatoriosPeriodo = 'ano'; // 'dia' | 'mes' | 'ano'
let relatoriosDia = todayISO();
let relatoriosMes = todayISO().slice(0, 7);
let relatoriosAno = todayISO().slice(0, 4);
let futurosDataLimite = '';
let futurosTipo = 'todos'; // 'todos' | 'parcela' | 'renovacao'

function periodoRange() {
  if (relatoriosPeriodo === 'dia') {
    return { start: relatoriosDia, end: addDaysISO(relatoriosDia, 1), bucket: 'dia' };
  }
  if (relatoriosPeriodo === 'ano') {
    return { start: relatoriosAno + '-01-01', end: (Number(relatoriosAno) + 1) + '-01-01', bucket: 'mes' };
  }
  const start = relatoriosMes + '-01';
  const end = addDaysISO(new Date(Number(relatoriosMes.slice(0, 4)), Number(relatoriosMes.slice(5, 7)), 0).toISOString().slice(0, 10), 1);
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
        <button class="btn btn-sm ${relatoriosTab === 'futuro' ? 'btn-primary' : 'btn-outline'}" id="tab-futuro">Lançamentos Futuros</button>
      </div>
      ${relatoriosTab !== 'futuro' ? `
      <div class="flex gap-8 items-center">
        <div class="auth-tabs" style="margin:0">
          <button class="auth-tab ${relatoriosPeriodo === 'dia' ? 'active' : ''}" id="periodo-dia">Dia</button>
          <button class="auth-tab ${relatoriosPeriodo === 'mes' ? 'active' : ''}" id="periodo-mes">Mês</button>
          <button class="auth-tab ${relatoriosPeriodo === 'ano' ? 'active' : ''}" id="periodo-ano">Ano</button>
        </div>
        ${relatoriosPeriodo === 'dia' ? `<input type="date" id="relatorios-data" value="${relatoriosDia}">` : ''}
        ${relatoriosPeriodo === 'mes' ? `<input type="month" id="relatorios-data" value="${relatoriosMes}">` : ''}
        ${relatoriosPeriodo === 'ano' ? `<input type="number" id="relatorios-data" value="${relatoriosAno}" style="width:90px">` : ''}
      </div>` : ''}
    </div>
    <div id="relatorios-body" class="mt-14"><div class="text-soft">Carregando...</div></div>
  `;
  document.getElementById('tab-lucro').onclick = () => { relatoriosTab = 'lucro'; renderGerenteRelatorios(); };
  document.getElementById('tab-fluxo').onclick = () => { relatoriosTab = 'fluxo'; renderGerenteRelatorios(); };
  document.getElementById('tab-analitico').onclick = () => { relatoriosTab = 'analitico'; renderGerenteRelatorios(); };
  document.getElementById('tab-futuro').onclick = () => { relatoriosTab = 'futuro'; renderGerenteRelatorios(); };
  if (relatoriosTab !== 'futuro') {
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

  if (relatoriosTab === 'futuro') {
    const [{ data: installments }, { data: cycles }] = await Promise.all([
      supa.from('installments').select('*, loan_contracts!installments_contract_id_fkey(contract_number, client_id, clients!loan_contracts_client_id_fkey(profiles!clients_profile_id_fkey(full_name)))').in('status', ['pendente', 'atrasada']),
      supa.from('renewal_cycles').select('*, loan_contracts!renewal_cycles_contract_id_fkey(contract_number, client_id, clients!loan_contracts_client_id_fkey(profiles!clients_profile_id_fkey(full_name)))').in('status', ['pendente', 'atrasada']),
    ]);
    paintLancamentosFuturos(installments || [], cycles || []);
    return;
  }

  const { start, end, bucket } = periodoRange();

  const [{ data: payments }, { data: contracts }] = await Promise.all([
    supa.from('payments').select('*').gte('received_at', start).lt('received_at', end),
    supa.from('loan_contracts').select('*').gte('contract_date', start).lt('contract_date', end),
  ]);

  if (relatoriosTab === 'lucro') paintLucroAnalitico(payments || [], contracts || [], bucket);
  else if (relatoriosTab === 'fluxo') paintFluxoCaixa(payments || [], contracts || [], bucket);
  else paintRelatorioAnalitico(payments || [], contracts || []);
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

function paintLucroAnalitico(payments, contracts, bucket) {
  const body = document.getElementById('relatorios-body');
  const byBucketProfit = groupByBucket(payments, 'received_at', ['net_profit', 'principal_component', 'amount_received'], bucket);
  const byBucketFees = groupByBucket(contracts, 'contract_date', ['operational_fee_amount'], bucket);
  const keys = [...new Set([...Object.keys(byBucketProfit), ...Object.keys(byBucketFees)])].sort();

  const netFor = (k) => (byBucketProfit[k] ? byBucketProfit[k].net_profit : 0) - (byBucketFees[k] ? byBucketFees[k].operational_fee_amount : 0);
  const totalLucro = keys.reduce((s, k) => s + netFor(k), 0);

  const todayKey = bucketKey(todayISO(), bucket);
  const lucroHoje = netFor(todayKey);
  const retornoHoje = byBucketProfit[todayKey] ? byBucketProfit[todayKey].principal_component : 0;

  let melhorDia = null;
  keys.forEach((k) => { if (!melhorDia || netFor(k) > netFor(melhorDia)) melhorDia = k; });

  const series = keys.map((k) => ({ label: bucketLabel(k, bucket), value: netFor(k) }));

  body.innerHTML = `
    <div class="grid grid-4">
      <div class="card stat-card"><div class="label">Lucro total no período</div><div class="value mono">${formatMoney(totalLucro)}</div></div>
      <div class="card stat-card"><div class="label">Retorno hoje (capital)</div><div class="value mono">${formatMoney(retornoHoje)}</div></div>
      <div class="card stat-card"><div class="label">Lucro hoje</div><div class="value mono">${formatMoney(lucroHoje)}</div></div>
      <div class="card stat-card"><div class="label">${bucket === 'mes' ? 'Mês' : 'Dia'} mais lucrativo</div><div class="value" style="font-size:15px">${melhorDia ? bucketLabel(melhorDia, bucket) + ' · ' + formatMoney(netFor(melhorDia)) : '—'}</div></div>
    </div>
    <div class="card mt-14">
      <h3>Lucro por período (juros − taxa de saída dos contratos − taxas de entrada dos pagamentos)</h3>
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

function paintFluxoCaixa(payments, contracts, bucket) {
  const body = document.getElementById('relatorios-body');
  const recebido = payments.reduce((s, p) => s + Number(p.amount_received), 0);
  const aporte = contracts.reduce((s, c) => s + Number(c.total_disbursed_amount), 0);
  const exitFees = contracts.reduce((s, c) => s + Number(c.operational_fee_amount), 0);
  const entryFees = payments.reduce((s, p) => s + Number(p.operational_fee_amount), 0);
  const lucroLiquido = payments.reduce((s, p) => s + Number(p.interest_component), 0) - exitFees - entryFees;

  const byBucketIn = groupByBucket(payments, 'received_at', ['amount_received'], bucket);
  const byBucketOut = groupByBucket(contracts, 'contract_date', ['total_disbursed_amount'], bucket);
  const allKeys = [...new Set([...Object.keys(byBucketIn), ...Object.keys(byBucketOut)])].sort();
  const seriesIn = allKeys.map((k) => ({ label: bucketLabel(k, bucket), value: (byBucketIn[k] || { amount_received: 0 }).amount_received }));
  const seriesOut = allKeys.map((k) => ({ label: bucketLabel(k, bucket), value: (byBucketOut[k] || { total_disbursed_amount: 0 }).total_disbursed_amount }));

  body.innerHTML = `
    <div class="grid grid-3">
      <div class="card stat-card"><div class="label">Aporte no período (contrato + taxa de saída)</div><div class="value mono">${formatMoney(aporte)}</div></div>
      <div class="card stat-card"><div class="label">Recebido no período</div><div class="value mono">${formatMoney(recebido)}</div></div>
      <div class="card stat-card"><div class="label">Lucro líquido (juros − taxas)</div><div class="value mono">${formatMoney(lucroLiquido)}</div></div>
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

function paintRelatorioAnalitico(payments, contracts) {
  const body = document.getElementById('relatorios-body');
  const entradas = payments.reduce((s, p) => s + Number(p.amount_received), 0);
  const saidas = contracts.reduce((s, c) => s + Number(c.principal_amount), 0);
  const juros = payments.reduce((s, p) => s + Number(p.interest_component), 0);
  const exitFees = contracts.reduce((s, c) => s + Number(c.operational_fee_amount), 0);
  const entryFees = payments.reduce((s, p) => s + Number(p.operational_fee_amount), 0);

  body.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <h3>Composição do período</h3>
        <div class="flex items-center gap-14 mt-14" style="flex-wrap:wrap">
          ${donutChartSVG([{ label: 'Entradas', value: entradas, color: CHART_COLORS.good }, { label: 'Saídas (novo crédito)', value: saidas, color: CHART_COLORS.brand }])}
          <div style="flex:1;min-width:160px" class="flex flex-col gap-8">
            ${donutLegendHtml([{ label: 'Entradas', value: entradas, color: CHART_COLORS.good }, { label: 'Saídas (novo crédito)', value: saidas, color: CHART_COLORS.brand }])}
          </div>
        </div>
      </div>
      <div class="card">
        <h3>Resumo</h3>
        <div class="grid grid-2 mt-14">
          <div class="stat-card"><div class="label">Entradas (recebimentos)</div><div class="value mono">${formatMoney(entradas)}</div></div>
          <div class="stat-card"><div class="label">Saídas (novo crédito)</div><div class="value mono">${formatMoney(saidas)}</div></div>
          <div class="stat-card"><div class="label">Juros recebidos (bruto)</div><div class="value mono">${formatMoney(juros)}</div></div>
          <div class="stat-card"><div class="label">Taxas de saída (contratos)</div><div class="value mono">${formatMoney(exitFees)}</div></div>
          <div class="stat-card"><div class="label">Taxas de entrada (recebimentos)</div><div class="value mono">${formatMoney(entryFees)}</div></div>
          <div class="stat-card"><div class="label">Lucro líquido total</div><div class="value mono">${formatMoney(juros - exitFees - entryFees)}</div></div>
        </div>
      </div>
    </div>
    <p class="text-sm text-soft mt-14">Metodologia: entradas somam todos os pagamentos recebidos no período (parcelas e renovações); saídas somam o valor bruto de novos contratos criados no período. Lucro líquido considera juros recebidos menos taxas operacionais de saída (desembolso) e de entrada (recebimento).</p>
  `;
}

function paintLancamentosFuturos(installments, cycles) {
  const body = document.getElementById('relatorios-body');
  const today = todayISO();

  let items = [
    ...installments.map((i) => ({
      tipo: 'parcela', data: i.due_date, valor: Number(i.amount_due),
      descricao: ((i.loan_contracts || {}).clients || {}).profiles ? ((i.loan_contracts.clients.profiles.full_name) + ' · Parcela #' + i.sequence_number) : 'Parcela #' + i.sequence_number,
      contractNumber: (i.loan_contracts || {}).contract_number, contractId: i.contract_id,
    })),
    ...cycles.map((c) => ({
      tipo: 'renovacao', data: c.new_due_date, valor: Number(c.full_debt_amount),
      descricao: ((c.loan_contracts || {}).clients || {}).profiles ? ((c.loan_contracts.clients.profiles.full_name) + ' · Renovação #' + c.cycle_number) : 'Renovação #' + c.cycle_number,
      contractNumber: (c.loan_contracts || {}).contract_number, contractId: c.contract_id,
    })),
  ];

  if (futurosTipo !== 'todos') items = items.filter((i) => i.tipo === futurosTipo);
  if (futurosDataLimite) items = items.filter((i) => i.data <= futurosDataLimite);
  items.sort((a, b) => a.data.localeCompare(b.data));

  const previsaoEntradas = items.reduce((s, i) => s + i.valor, 0);
  const previsaoSaidas = 0; // este sistema não tem conceito de saída programada (novo crédito é sob demanda, não agendado)
  const projecaoLiquida = previsaoEntradas - previsaoSaidas;

  const diasRestantes = (dataStr) => Math.round((new Date(dataStr) - new Date(today)) / 86400000);

  body.innerHTML = `
    <div class="grid grid-3">
      <div class="card stat-card" style="background:var(--good-dark);color:#fff">
        <div class="label" style="color:rgba(255,255,255,.85)">Previsão de entradas</div>
        <div class="text-sm" style="color:rgba(255,255,255,.75)">Parcelas de empréstimos + entradas programadas</div>
        <div class="value mono" style="color:#fff;font-size:20px">${formatMoney(previsaoEntradas)}</div>
      </div>
      <div class="card stat-card" style="background:var(--bad-dark);color:#fff">
        <div class="label" style="color:rgba(255,255,255,.85)">Previsão de saídas</div>
        <div class="text-sm" style="color:rgba(255,255,255,.75)">Saídas programadas ainda não debitadas</div>
        <div class="value mono" style="color:#fff;font-size:20px">${formatMoney(previsaoSaidas)}</div>
      </div>
      <div class="card stat-card" style="background:var(--purple, #7C5CFC);color:#fff">
        <div class="label" style="color:rgba(255,255,255,.85)">Projeção líquida</div>
        <div class="text-sm" style="color:rgba(255,255,255,.75)">Entradas previstas − saídas previstas</div>
        <div class="value mono" style="color:#fff;font-size:20px">${formatMoney(projecaoLiquida)}</div>
      </div>
    </div>

    <div class="field-row mt-14">
      <div class="field"><label>Data Limite (Opcional)</label><input type="date" id="futuros-data-limite" value="${futurosDataLimite}"></div>
      <div class="field">
        <label>Tipo</label>
        <select id="futuros-tipo">
          <option value="todos" ${futurosTipo === 'todos' ? 'selected' : ''}>Todos</option>
          <option value="parcela" ${futurosTipo === 'parcela' ? 'selected' : ''}>Parcela</option>
          <option value="renovacao" ${futurosTipo === 'renovacao' ? 'selected' : ''}>Renovação</option>
        </select>
      </div>
    </div>

    <div class="card mt-14" style="padding:0">
      <table class="data-table table-scroll">
        <thead><tr><th>Tipo</th><th>Data</th><th>Dias Restantes</th><th>Descrição</th><th>Valor</th><th>Referência</th></tr></thead>
        <tbody>
          ${items.length ? items.map((i) => {
            const dias = diasRestantes(i.data);
            const diasLabel = dias < 0 ? `${Math.abs(dias)}d atrasado` : dias === 0 ? 'Hoje' : `${dias} dia${dias === 1 ? '' : 's'}`;
            const diasColor = dias < 0 ? 'badge-bad' : dias <= 3 ? 'badge-warn' : 'badge-neutral';
            return `
            <tr>
              <td data-label="Tipo"><span class="badge badge-brand">${i.tipo === 'parcela' ? 'Parcela' : 'Renovação'}</span></td>
              <td data-label="Data">${formatDate(i.data)}</td>
              <td data-label="Dias Restantes"><span class="badge ${diasColor}">${diasLabel}</span></td>
              <td data-label="Descrição" class="wrap-text">${escapeHtml(i.descricao)}</td>
              <td data-label="Valor" class="mono">${formatMoney(i.valor)}</td>
              <td data-label="Referência">${i.contractNumber ? `<a href="#/gerente/contratos/${i.contractId}" class="reference-link">Contrato #${i.contractNumber} ${Icons.chevronRight}</a>` : '—'}</td>
            </tr>`;
          }).join('') : `<tr><td colspan="6" class="text-soft">Nenhum lançamento futuro encontrado.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('futuros-data-limite').onchange = (e) => { futurosDataLimite = e.target.value; renderGerenteRelatorios(); };
  document.getElementById('futuros-tipo').onchange = (e) => { futurosTipo = e.target.value; renderGerenteRelatorios(); };
}

registerRoute('gerente/relatorios', { role: 'gerente', screenId: 'gerente-relatorios', title: 'Relatórios Gerenciais', render: renderGerenteRelatorios });

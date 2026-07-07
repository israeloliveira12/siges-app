/* ============================================================================
   Gerente — Relatórios gerenciais (Lucro Analítico, Fluxo de Caixa, Analítico)
   ============================================================================ */

let relatoriosTab = 'lucro';
let relatoriosMonth = todayISO().slice(0, 7); // 'YYYY-MM'

async function renderGerenteRelatorios() {
  const root = document.getElementById('screen-gerente-relatorios');
  root.innerHTML = `
    <div class="flex justify-between items-center gap-10" style="flex-wrap:wrap">
      <div class="flex gap-8">
        <button class="btn btn-sm ${relatoriosTab === 'lucro' ? 'btn-primary' : 'btn-outline'}" id="tab-lucro">Lucro Analítico</button>
        <button class="btn btn-sm ${relatoriosTab === 'fluxo' ? 'btn-primary' : 'btn-outline'}" id="tab-fluxo">Fluxo de Caixa</button>
        <button class="btn btn-sm ${relatoriosTab === 'analitico' ? 'btn-primary' : 'btn-outline'}" id="tab-analitico">Relatório Analítico</button>
      </div>
      <input type="month" id="relatorios-month" value="${relatoriosMonth}">
    </div>
    <div id="relatorios-body" class="mt-14"><div class="text-soft">Carregando...</div></div>
  `;
  document.getElementById('tab-lucro').onclick = () => { relatoriosTab = 'lucro'; renderGerenteRelatorios(); };
  document.getElementById('tab-fluxo').onclick = () => { relatoriosTab = 'fluxo'; renderGerenteRelatorios(); };
  document.getElementById('tab-analitico').onclick = () => { relatoriosTab = 'analitico'; renderGerenteRelatorios(); };
  document.getElementById('relatorios-month').onchange = (e) => { relatoriosMonth = e.target.value; renderGerenteRelatorios(); };

  const monthStart = relatoriosMonth + '-01';
  const monthEnd = addDaysISO(new Date(Number(relatoriosMonth.slice(0, 4)), Number(relatoriosMonth.slice(5, 7)), 0).toISOString().slice(0, 10), 1);

  const [{ data: payments }, { data: contracts }] = await Promise.all([
    supa.from('payments').select('*').gte('received_at', monthStart).lt('received_at', monthEnd),
    supa.from('loan_contracts').select('*').gte('contract_date', monthStart).lt('contract_date', monthEnd),
  ]);

  if (relatoriosTab === 'lucro') paintLucroAnalitico(payments || []);
  else if (relatoriosTab === 'fluxo') paintFluxoCaixa(payments || [], contracts || []);
  else paintRelatorioAnalitico(payments || [], contracts || []);
}

function groupByDay(rows, dateField, valueFields) {
  const map = {};
  rows.forEach((r) => {
    const day = String(r[dateField]).slice(0, 10);
    map[day] = map[day] || Object.fromEntries(valueFields.map((f) => [f, 0]));
    valueFields.forEach((f) => { map[day][f] += Number(r[f] || 0); });
  });
  return map;
}

function paintLucroAnalitico(payments) {
  const body = document.getElementById('relatorios-body');
  const byDay = groupByDay(payments, 'received_at', ['net_profit', 'principal_component', 'amount_received']);
  const days = Object.keys(byDay).sort();
  const totalLucro = payments.reduce((s, p) => s + Number(p.net_profit), 0);
  const today = todayISO();
  const lucroHoje = byDay[today] ? byDay[today].net_profit : 0;
  const retornoHoje = byDay[today] ? byDay[today].principal_component : 0;

  let melhorDia = null, piorDia = null;
  days.forEach((d) => {
    if (!melhorDia || byDay[d].net_profit > byDay[melhorDia].net_profit) melhorDia = d;
    if (!piorDia || byDay[d].net_profit < byDay[piorDia].net_profit) piorDia = d;
  });

  const series = days.map((d) => ({ label: d.slice(8, 10), value: byDay[d].net_profit }));

  body.innerHTML = `
    <div class="grid grid-4">
      <div class="card stat-card"><div class="label">Lucro total no mês</div><div class="value mono">${formatMoney(totalLucro)}</div></div>
      <div class="card stat-card"><div class="label">Retorno hoje (capital)</div><div class="value mono">${formatMoney(retornoHoje)}</div></div>
      <div class="card stat-card"><div class="label">Lucro hoje</div><div class="value mono">${formatMoney(lucroHoje)}</div></div>
      <div class="card stat-card"><div class="label">Dia mais lucrativo</div><div class="value" style="font-size:15px">${melhorDia ? formatDate(melhorDia) + ' · ' + formatMoney(byDay[melhorDia].net_profit) : '—'}</div></div>
    </div>
    <div class="card mt-14">
      <h3>Lucro dia a dia</h3>
      <div class="mt-8">${series.length ? barChartSVG(series, { color: CHART_COLORS.accent }) : '<p class="text-soft text-sm">Sem pagamentos neste mês.</p>'}</div>
    </div>
    <div class="card mt-14" style="padding:0">
      <table class="data-table table-scroll">
        <thead><tr><th>Dia</th><th>Coletado</th><th>Retornado (capital)</th><th>Lucro</th></tr></thead>
        <tbody>
          ${days.map((d) => `<tr><td data-label="Dia">${formatDate(d)}</td><td data-label="Coletado" class="mono">${formatMoney(byDay[d].amount_received)}</td><td data-label="Retornado" class="mono">${formatMoney(byDay[d].principal_component)}</td><td data-label="Lucro" class="mono">${formatMoney(byDay[d].net_profit)}</td></tr>`).join('') || '<tr><td colspan="4" class="text-soft">Sem movimento.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function paintFluxoCaixa(payments, contracts) {
  const body = document.getElementById('relatorios-body');
  const recebidoMes = payments.reduce((s, p) => s + Number(p.amount_received), 0);
  const aporteMes = contracts.reduce((s, c) => s + Number(c.principal_amount), 0);
  const lucroLiquidoMes = payments.reduce((s, p) => s + Number(p.net_profit), 0);
  const saldoLiquido = recebidoMes - aporteMes;

  const byDayIn = groupByDay(payments, 'received_at', ['amount_received']);
  const byDayOut = groupByDay(contracts, 'contract_date', ['principal_amount']);
  const allDays = [...new Set([...Object.keys(byDayIn), ...Object.keys(byDayOut)])].sort();
  const seriesIn = allDays.map((d) => ({ label: d.slice(8, 10), value: (byDayIn[d] || { amount_received: 0 }).amount_received }));
  const seriesOut = allDays.map((d) => ({ label: d.slice(8, 10), value: (byDayOut[d] || { principal_amount: 0 }).principal_amount }));

  body.innerHTML = `
    <div class="grid grid-4">
      <div class="card stat-card"><div class="label">Aporte no mês</div><div class="value mono">${formatMoney(aporteMes)}</div></div>
      <div class="card stat-card"><div class="label">Recebido no mês</div><div class="value mono">${formatMoney(recebidoMes)}</div></div>
      <div class="card stat-card"><div class="label">Lucro líquido no mês</div><div class="value mono">${formatMoney(lucroLiquidoMes)}</div></div>
      <div class="card stat-card"><div class="label">Saldo líquido (recebido − aporte)</div><div class="value mono" style="color:${saldoLiquido >= 0 ? 'var(--good)' : 'var(--bad)'}">${formatMoney(saldoLiquido)}</div></div>
    </div>
    <div class="grid grid-2 mt-14">
      <div class="card">
        <h3>Recebido por dia</h3>
        <div class="mt-8">${seriesIn.length ? lineChartSVG(seriesIn, { color: CHART_COLORS.good }) : '<p class="text-soft text-sm">Sem dados.</p>'}</div>
      </div>
      <div class="card">
        <h3>Novo capital emprestado por dia</h3>
        <div class="mt-8">${seriesOut.length ? lineChartSVG(seriesOut, { color: CHART_COLORS.brand }) : '<p class="text-soft text-sm">Sem dados.</p>'}</div>
      </div>
    </div>
  `;
}

function paintRelatorioAnalitico(payments, contracts) {
  const body = document.getElementById('relatorios-body');
  const entradas = payments.reduce((s, p) => s + Number(p.amount_received), 0);
  const saidas = contracts.reduce((s, c) => s + Number(c.principal_amount), 0);
  const juros = payments.reduce((s, p) => s + Number(p.interest_component), 0);
  const taxas = payments.reduce((s, p) => s + Number(p.operational_fee_amount), 0);

  body.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <h3>Composição do mês</h3>
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
          <div class="stat-card"><div class="label">Taxas operacionais descontadas</div><div class="value mono">${formatMoney(taxas)}</div></div>
        </div>
      </div>
    </div>
    <p class="text-sm text-soft mt-14">Metodologia: entradas somam todos os pagamentos recebidos no mês (parcelas e renovações); saídas somam o valor bruto de novos contratos criados no mês. Juros/taxas refletem o detalhamento de cada pagamento.</p>
  `;
}

registerRoute('gerente/relatorios', { role: 'gerente', screenId: 'gerente-relatorios', title: 'Relatórios Gerenciais', render: renderGerenteRelatorios });

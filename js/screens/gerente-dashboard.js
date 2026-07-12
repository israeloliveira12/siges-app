/* ============================================================================
   Dashboard do gerente — visão geral de caixa, recebimentos e atalhos
   ============================================================================ */

// Badge de variação (▲/▼ %) comparando o período atual com o mesmo período
// do mês anterior. `dark` ajusta as cores pro fundo escuro do card de destaque.
function trendBadgeHtml(curr, prev, dark) {
  const goodColor = dark ? '#8FE3B0' : 'var(--good)';
  const badColor = dark ? '#FFB4A8' : 'var(--bad)';
  const mutedColor = dark ? 'rgba(255,255,255,.75)' : 'var(--ink-soft)';
  if (!prev) {
    if (!curr) return `<span style="color:${mutedColor}">sem dados no período anterior</span>`;
    return `<span style="color:${goodColor};font-weight:700">▲ novo</span>`;
  }
  const pct = ((curr - prev) / Math.abs(prev)) * 100;
  const up = pct >= 0;
  return `<span style="color:${up ? goodColor : badColor};font-weight:700">${up ? '▲' : '▼'} ${formatNumber(Math.abs(pct), 0)}%</span>`;
}

async function renderGerenteDashboard() {
  const root = document.getElementById('screen-gerente-dashboard');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const today = todayISO();
  const monthStart = today.slice(0, 7) + '-01';
  const trend30Start = addDaysISO(today, -29);

  // Período comparável do mês anterior (mesmo intervalo de dias, do dia 1 até
  // o mesmo dia-do-mês de hoje) — comparar mês corrente parcial com mês
  // anterior INTEIRO seria injusto (mês em andamento sempre perde).
  const todayDate = new Date(today + 'T00:00:00');
  const dayOfMonth = todayDate.getDate();
  const prevMonthRef = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1);
  const prevMonthStart = prevMonthRef.getFullYear() + '-' + String(prevMonthRef.getMonth() + 1).padStart(2, '0') + '-01';
  const prevMonthLastDay = new Date(prevMonthRef.getFullYear(), prevMonthRef.getMonth() + 1, 0).getDate();
  const prevMonthSameDay = Math.min(dayOfMonth, prevMonthLastDay);
  const prevMonthEnd = prevMonthRef.getFullYear() + '-' + String(prevMonthRef.getMonth() + 1).padStart(2, '0') + '-' + String(prevMonthSameDay).padStart(2, '0');

  const [
    { data: paymentsToday },
    { data: paymentsMonth },
    { data: paymentsPrevPeriod },
    { data: contractsStatus },
    { data: paymentsTrend },
    { count: pendingRequests },
    { data: dueSoon },
    { data: cyclesSoon },
    { data: entryFeesMonth },
    { data: exitFeesMonth },
    { data: exitFeesPrevPeriod },
  ] = await Promise.all([
    supa.from('payments').select('amount_received').gte('received_at', today),
    supa.from('payments').select('amount_received, net_profit').gte('received_at', monthStart),
    supa.from('payments').select('amount_received, net_profit').gte('received_at', prevMonthStart).lte('received_at', prevMonthEnd),
    supa.from('loan_contracts').select('status, created_at'),
    supa.from('payments').select('amount_received, received_at').gte('received_at', trend30Start),
    supa.from('loan_requests').select('id', { count: 'exact', head: true }).eq('status', 'pendente'),
    supa.from('installments').select('amount_due, due_date, status, principal_share, interest_share, principal_paid_partial, interest_paid_partial, loan_contracts!installments_contract_id_fkey(client_id, clients!loan_contracts_client_id_fkey(profiles!clients_profile_id_fkey(full_name)))').in('status', ['pendente', 'atrasada']),
    supa.from('renewal_cycles').select('full_debt_amount, new_due_date, status, interest_only_amount, loan_contracts!renewal_cycles_contract_id_fkey(client_id, principal_amount, clients!loan_contracts_client_id_fkey(profiles!clients_profile_id_fkey(full_name)))').in('status', ['pendente', 'atrasada']),
    supa.from('payments').select('operational_fee_amount').eq('has_operational_fee', true).gte('received_at', monthStart),
    supa.from('loan_contracts').select('operational_fee_amount').eq('has_operational_fee', true).gte('created_at', monthStart),
    supa.from('loan_contracts').select('operational_fee_amount').eq('has_operational_fee', true).gte('created_at', prevMonthStart).lte('created_at', prevMonthEnd),
  ]);

  const sum = (rows, field) => (rows || []).reduce((s, r) => s + Number(r[field] || 0), 0);
  const recebidoHoje = sum(paymentsToday, 'amount_received');
  const recebidoMes = sum(paymentsMonth, 'amount_received');
  const recebidoPrevPeriod = sum(paymentsPrevPeriod, 'amount_received');
  // Lucro líquido = payments.net_profit (juros − taxa de ENTRADA, já embutido
  // na coluna gerada) MENOS a taxa de SAÍDA dos contratos criados no período
  // — essa segunda parte NÃO está em net_profit (é cobrada uma vez, na
  // criação do contrato, tabela loan_contracts, não payments). Sem essa
  // subtração o card de lucro líquido do dashboard divergia do que
  // Relatórios (Lucro Analítico/Fluxo de Caixa/Analítico) mostrava pro MESMO
  // mês — os três já subtraem taxa de saída corretamente, só o dashboard
  // esquecia (bug real reportado pelo usuário, 2026-07-11). O ajuste do
  // período anterior (`taxaSaidaPrevPeriod`) existe pra comparação ▲/▼ do
  // trend badge não ficar comparando "ajustado" com "não ajustado".
  const taxaSaidaMes = sum(exitFeesMonth, 'operational_fee_amount');
  const taxaSaidaPrevPeriod = sum(exitFeesPrevPeriod, 'operational_fee_amount');
  const lucroMes = sum(paymentsMonth, 'net_profit') - taxaSaidaMes;
  const lucroPrevPeriod = sum(paymentsPrevPeriod, 'net_profit') - taxaSaidaPrevPeriod;
  const vencidosHoje = (dueSoon || []).filter((i) => i.due_date === today);
  // Compara due_date direto (não confia só na coluna status) — o cron que
  // marca status='atrasada' roda 1x/dia, então uma parcela vencida há poucas
  // horas ainda pode estar com status 'pendente' até o próximo ciclo do cron.
  const atrasados = (dueSoon || []).filter((i) => i.due_date < today);
  const aReceberMes = (dueSoon || []).filter((i) => i.due_date && i.due_date.slice(0, 7) === today.slice(0, 7));

  const statusCounts = { em_aberto: 0, atrasado: 0, quitado: 0, perda: 0 };
  (contractsStatus || []).forEach((c) => { statusCounts[c.status] = (statusCounts[c.status] || 0) + 1; });
  const openContracts = statusCounts.em_aberto + statusCounts.atrasado;
  const finishedContracts = statusCounts.quitado + statusCounts.perda;
  const newThisMonth = (contractsStatus || []).filter((c) => String(c.created_at).slice(0, 7) === today.slice(0, 7)).length;
  const newPrevPeriod = (contractsStatus || []).filter((c) => {
    const d = String(c.created_at).slice(0, 10);
    return d >= prevMonthStart && d <= prevMonthEnd;
  }).length;

  // Carteira ativa — capital (não saldo com juros) ainda emprestado, ou seja,
  // não recuperado ainda. Parcelas: principal_share menos o que já foi pago
  // parcialmente. Ciclos de renovação: a renovação só rola/quita JUROS (ver
  // renew_installment no schema), o capital original do contrato continua
  // intacto e em aberto, então usa-se loan_contracts.principal_amount do
  // ciclo — nunca full_debt_amount, que já embute juros acumulados.
  const principalOutstanding = (rows) => (rows || []).reduce((s, i) => s + Number(i.principal_share || 0) - Number(i.principal_paid_partial || 0), 0);
  const principalFromCycles = (rows) => (rows || []).reduce((s, c) => s + Number((c.loan_contracts || {}).principal_amount || 0), 0);
  const carteiraAtiva = principalOutstanding(dueSoon) + principalFromCycles(cyclesSoon);
  const carteiraEmAtraso = principalOutstanding(atrasados) + principalFromCycles((cyclesSoon || []).filter((c) => c.new_due_date < today));
  const pctCarteiraAtraso = carteiraAtiva > 0 ? (carteiraEmAtraso / carteiraAtiva) * 100 : 0;

  // Projeção de recebimentos — soma parcelas + ciclos de renovação em aberto
  // (pendente/atrasada) nos próximos 6 meses, agrupados por mês.
  const mesesPt = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const monthKeys = [];
  for (let m = 0; m < 6; m++) {
    const d = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + m, 1);
    monthKeys.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
  }
  const projectionByMonth = {};
  (dueSoon || []).forEach((i) => {
    const key = String(i.due_date).slice(0, 7);
    projectionByMonth[key] = (projectionByMonth[key] || 0) + Number(i.amount_due || 0);
  });
  (cyclesSoon || []).forEach((c) => {
    const key = String(c.new_due_date).slice(0, 7);
    projectionByMonth[key] = (projectionByMonth[key] || 0) + Number(c.full_debt_amount || 0);
  });
  const projectionSeries = monthKeys.map((key) => {
    const [y, m] = key.split('-');
    return { label: mesesPt[Number(m) - 1] + '/' + y, value: projectionByMonth[key] || 0 };
  });
  // Total geral a receber — TODAS as parcelas/ciclos pendentes/atrasados do
  // sistema, sem limite de data (não só os próximos 6 meses).
  const receberTotal = sum(dueSoon, 'amount_due') + sum(cyclesSoon, 'full_debt_amount');

  // Projeção de lucro — juros esperados (não o valor bruto da parcela/ciclo)
  // menos a taxa operacional de entrada estimada (% + fixo, config atual),
  // que é o que de fato sobra pra empresa em cada recebimento futuro. Taxa
  // de saída não entra aqui: para contratos já existentes ela já foi cobrada
  // na criação (é passado, não projeção); só se aplica a empréstimos novos,
  // que este gráfico não tenta prever.
  const entryPct = (App.settings && App.settings.default_entry_fee_percent) || 0;
  const entryFixed = (App.settings && App.settings.default_entry_fee_fixed) || 0;
  const estEntryFee = (amount) => amount * entryPct / 100 + entryFixed;
  const profitByMonth = {};
  (dueSoon || []).forEach((i) => {
    const key = String(i.due_date).slice(0, 7);
    const lucro = Number(i.interest_share || 0) - estEntryFee(Number(i.amount_due || 0));
    profitByMonth[key] = (profitByMonth[key] || 0) + lucro;
  });
  (cyclesSoon || []).forEach((c) => {
    const key = String(c.new_due_date).slice(0, 7);
    const lucro = Number(c.interest_only_amount || 0) - estEntryFee(Number(c.full_debt_amount || 0));
    profitByMonth[key] = (profitByMonth[key] || 0) + lucro;
  });
  // No mês corrente, a projeção soma o que já foi efetivamente recebido
  // (lucroMes) + o que ainda falta receber das parcelas/ciclos em aberto —
  // senão o card de destaque mostra 200 recebidos enquanto o gráfico mostra
  // só os 800 futuros, dando a impressão de que o mês vai render menos do
  // que já rendeu.
  const profitSeries = monthKeys.map((key, idx) => {
    const [y, m] = key.split('-');
    let value = profitByMonth[key] || 0;
    if (idx === 0) value += lucroMes;
    return { label: mesesPt[Number(m) - 1] + '/' + y, value: Math.max(0, value) };
  });

  // Taxa de entrada efetivamente cobrada no mês corrente (a cada recebimento
  // que optou por cobrar) — já compõe o net_profit de cada payment; aqui só
  // soma pra dar visibilidade agregada mensal na nota do card de lucro
  // (taxaSaidaMes já foi calculada mais acima, usada no próprio lucroMes).
  const taxaEntradaMes = sum(entryFeesMonth, 'operational_fee_amount');

  // Top clientes por saldo em aberto — soma o que falta de cada parcela
  // (amount_due menos o que já foi pago parcialmente) + ciclos de renovação
  // pendentes/atrasados, agrupado por cliente.
  const outstandingByClient = {};
  const addOutstanding = (clientId, name, amount) => {
    if (!clientId) return;
    if (!outstandingByClient[clientId]) outstandingByClient[clientId] = { name: name || '—', total: 0 };
    outstandingByClient[clientId].total += amount;
  };
  (dueSoon || []).forEach((i) => {
    const lc = i.loan_contracts || {};
    const name = ((lc.clients || {}).profiles || {}).full_name;
    const remaining = Number(i.amount_due || 0) - Number(i.principal_paid_partial || 0) - Number(i.interest_paid_partial || 0);
    addOutstanding(lc.client_id, name, remaining);
  });
  (cyclesSoon || []).forEach((c) => {
    const lc = c.loan_contracts || {};
    const name = ((lc.clients || {}).profiles || {}).full_name;
    addOutstanding(lc.client_id, name, Number(c.full_debt_amount || 0));
  });
  const topClientes = Object.values(outstandingByClient).sort((a, b) => b.total - a.total).slice(0, 5);

  const trendByDay = {};
  (paymentsTrend || []).forEach((p) => {
    const day = String(p.received_at).slice(0, 10);
    trendByDay[day] = (trendByDay[day] || 0) + Number(p.amount_received || 0);
  });
  const trendSeries = [];
  for (let i = 29; i >= 0; i--) {
    const day = addDaysISO(today, -i);
    trendSeries.push({ label: formatDate(day).slice(0, 5), value: trendByDay[day] || 0 });
  }

  root.innerHTML = `
    <div class="card" style="background:var(--brand-dark);color:#fff;border:none;padding:22px 24px">
      <div style="font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;opacity:.8">Lucro líquido — mês (até hoje)</div>
      <div class="mono" style="font-size:32px;font-weight:800;margin-top:6px">${formatMoney(lucroMes)}</div>
      <div style="font-size:13px;margin-top:8px;opacity:.95">${trendBadgeHtml(lucroMes, lucroPrevPeriod, true)} <span style="opacity:.8">vs. mesmo período do mês passado</span></div>
      <div style="font-size:12px;margin-top:10px;opacity:.8;border-top:1px solid rgba(255,255,255,.2);padding-top:8px">Já descontado: ${formatMoney(taxaEntradaMes + taxaSaidaMes)} em taxas operacionais (${formatMoney(taxaEntradaMes)} entrada + ${formatMoney(taxaSaidaMes)} saída)</div>
    </div>

    <div class="grid grid-2 mt-14">
      <div class="card stat-card">
        <div class="label">Carteira ativa (capital emprestado)</div>
        <div class="value mono">${formatMoney(carteiraAtiva)}</div>
        <div class="text-sm text-soft mt-8">Capital ainda não recuperado, em parcelas e renovações abertas</div>
      </div>
      <div class="card stat-card" style="border-top:3px solid ${pctCarteiraAtraso >= 20 ? 'var(--bad)' : 'var(--line)'}">
        <div class="label">Carteira em atraso</div>
        <div class="value mono" style="color:${pctCarteiraAtraso >= 20 ? 'var(--bad)' : 'var(--ink)'}">${formatNumber(pctCarteiraAtraso, 1)}%</div>
        <div class="text-sm text-soft mt-8">${formatMoney(carteiraEmAtraso)} do capital ativo em atraso</div>
      </div>
    </div>

    <div class="grid grid-4 mt-14">
      <div class="card stat-card">
        <div class="label">Recebido hoje</div>
        <div class="value mono">${formatMoney(recebidoHoje)}</div>
      </div>
      <div class="card stat-card">
        <div class="label">Recebido no mês</div>
        <div class="value mono">${formatMoney(recebidoMes)}</div>
        <div class="text-sm mt-8">${trendBadgeHtml(recebidoMes, recebidoPrevPeriod)}</div>
      </div>
      <div class="card stat-card">
        <div class="label">A receber este mês</div>
        <div class="value mono">${formatMoney(sum(aReceberMes, 'amount_due'))}</div>
      </div>
      <div class="card stat-card">
        <div class="label">A receber</div>
        <div class="value mono">${formatMoney(receberTotal)}</div>
      </div>
    </div>

    <div class="grid grid-2 mt-14">
      <div class="card" style="border-color:var(--bad)">
        <div class="flex justify-between items-center">
          <div>
            <div class="label text-soft text-sm">Vence hoje / atrasados</div>
            <div class="value mono" style="font-size:20px">${vencidosHoje.length + atrasados.length}</div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="router.navigate('#/gerente/cobrar')">Ir para Cobrar</button>
        </div>
      </div>
      <div class="card">
        <div class="flex justify-between items-center">
          <div>
            <div class="label text-soft text-sm">Solicitações pendentes</div>
            <div class="value mono" style="font-size:20px">${pendingRequests || 0}</div>
          </div>
          <button class="btn btn-outline btn-sm" onclick="router.navigate('#/gerente/solicitacoes')">Analisar</button>
        </div>
      </div>
    </div>

    <h3 class="mt-20">Visão geral dos contratos</h3>
    <p class="text-sm text-soft">Acompanhe o status e performance dos seus contratos</p>
    <div class="grid grid-3 mt-14">
      <div class="card stat-card overview-card" onclick="router.navigate('#/gerente/contratos')">
        <div class="label">Em andamento</div>
        <div class="value mono">${openContracts || 0}</div>
        <div class="text-sm text-soft mt-8">Contratos ativos e em execução</div>
        <span class="text-sm overview-card-link">Ver todos ${Icons.chevronRight}</span>
      </div>
      <div class="card stat-card overview-card" onclick="router.navigate('#/gerente/contratos')">
        <div class="label">Finalizados</div>
        <div class="value mono">${finishedContracts || 0}</div>
        <div class="text-sm text-soft mt-8">Contratos concluídos ou em perda</div>
        <span class="text-sm overview-card-link">Ver todos ${Icons.chevronRight}</span>
      </div>
      <div class="card stat-card">
        <div class="label">Novos do mês</div>
        <div class="value mono">${newThisMonth || 0}</div>
        <div class="text-sm mt-8">${trendBadgeHtml(newThisMonth, newPrevPeriod)}</div>
      </div>
    </div>

    <div class="card mt-14">
      <h3>Recebido — últimos 30 dias</h3>
      <div class="mt-8">${trendSeries.some((p) => p.value > 0) ? areaChartSVG(trendSeries, { color: CHART_COLORS.good, gradId: 'recebido30', ...chartSize(1180, 260, 320, 200) }) : '<p class="text-soft text-sm">Sem recebimentos no período.</p>'}</div>
    </div>

    <div class="grid grid-2 mt-14">
      <div class="card">
        <h3>Projeção de Recebimentos (6 meses)</h3>
        <div class="mt-8">${areaChartSVG(projectionSeries, { color: CHART_COLORS.purple, gradId: 'receb', ...chartSize(600, 220, 320, 200) })}</div>
      </div>
      <div class="card">
        <h3>Projeção de Lucro (6 meses)</h3>
        <div class="mt-8">${areaChartSVG(profitSeries, { color: CHART_COLORS.good, gradId: 'lucro', ...chartSize(600, 220, 320, 200) })}</div>
      </div>
    </div>

    <div class="card mt-14">
      <h3>Top clientes por saldo em aberto</h3>
      <p class="text-sm text-soft mt-8">Soma de parcelas e ciclos de renovação pendentes/atrasados de cada cliente</p>
      <div class="mt-14">
        ${!topClientes.length ? '<p class="text-soft text-sm">Nenhum saldo em aberto no momento.</p>' : topClientes.map((c, i) => `
          <div class="flex justify-between items-center" style="padding:9px 0;border-bottom:1px solid var(--line)">
            <div class="flex items-center gap-10"><span class="text-soft mono text-sm">${i + 1}º</span><span>${escapeHtml(c.name)}</span></div>
            <span class="mono" style="font-weight:700">${formatMoney(c.total)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

registerRoute('gerente/dashboard', { role: 'gerente', screenId: 'gerente-dashboard', title: 'Dashboard', render: renderGerenteDashboard });

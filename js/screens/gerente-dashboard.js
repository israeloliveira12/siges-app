/* ============================================================================
   Dashboard do gerente — visão geral de caixa, recebimentos e atalhos
   ============================================================================ */

async function renderGerenteDashboard() {
  const root = document.getElementById('screen-gerente-dashboard');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const today = todayISO();
  const monthStart = today.slice(0, 7) + '-01';
  const trend30Start = addDaysISO(today, -29);

  const [
    { data: paymentsToday },
    { data: paymentsMonth },
    { data: contractsStatus },
    { data: paymentsTrend },
    { count: clientsCount },
    { count: pendingRequests },
    { data: dueSoon },
  ] = await Promise.all([
    supa.from('payments').select('amount_received').gte('received_at', today),
    supa.from('payments').select('amount_received').gte('received_at', monthStart),
    supa.from('loan_contracts').select('status'),
    supa.from('payments').select('amount_received, received_at').gte('received_at', trend30Start),
    supa.from('clients').select('profile_id', { count: 'exact', head: true }),
    supa.from('loan_requests').select('id', { count: 'exact', head: true }).eq('status', 'pendente'),
    supa.from('installments').select('amount_due, due_date, status').in('status', ['pendente', 'atrasada']),
  ]);

  const sum = (rows, field) => (rows || []).reduce((s, r) => s + Number(r[field] || 0), 0);
  const recebidoHoje = sum(paymentsToday, 'amount_received');
  const recebidoMes = sum(paymentsMonth, 'amount_received');
  const vencidosHoje = (dueSoon || []).filter((i) => i.due_date === today);
  const atrasados = (dueSoon || []).filter((i) => i.status === 'atrasada');
  const aReceberMes = (dueSoon || []).filter((i) => i.due_date && i.due_date.slice(0, 7) === today.slice(0, 7));

  const statusCounts = { em_aberto: 0, atrasado: 0, quitado: 0, perda: 0 };
  (contractsStatus || []).forEach((c) => { statusCounts[c.status] = (statusCounts[c.status] || 0) + 1; });
  const openContracts = statusCounts.em_aberto + statusCounts.atrasado;
  const contractStatusSegments = [
    { label: 'Em aberto', value: statusCounts.em_aberto, color: CHART_COLORS.brand },
    { label: 'Atrasado', value: statusCounts.atrasado, color: CHART_COLORS.bad },
    { label: 'Quitado', value: statusCounts.quitado, color: CHART_COLORS.good },
    { label: 'Perda', value: statusCounts.perda, color: CHART_COLORS.warn },
  ];

  const trendByDay = {};
  (paymentsTrend || []).forEach((p) => {
    const day = String(p.received_at).slice(0, 10);
    trendByDay[day] = (trendByDay[day] || 0) + Number(p.amount_received || 0);
  });
  const trendSeries = [];
  for (let i = 29; i >= 0; i--) {
    const day = addDaysISO(today, -i);
    trendSeries.push({ label: day.slice(8, 10) + '/' + day.slice(5, 7), value: trendByDay[day] || 0 });
  }

  root.innerHTML = `
    <div class="grid grid-4">
      <div class="card stat-card">
        <div class="label">Recebido hoje</div>
        <div class="value mono">${formatMoney(recebidoHoje)}</div>
      </div>
      <div class="card stat-card">
        <div class="label">Recebido no mês</div>
        <div class="value mono">${formatMoney(recebidoMes)}</div>
      </div>
      <div class="card stat-card">
        <div class="label">A receber este mês</div>
        <div class="value mono">${formatMoney(sum(aReceberMes, 'amount_due'))}</div>
      </div>
      <div class="card stat-card">
        <div class="label">Contratos em aberto</div>
        <div class="value mono">${openContracts || 0}</div>
      </div>
    </div>

    <div class="grid grid-2 mt-14">
      <div class="card" style="border-color:var(--bad)">
        <div class="flex justify-between items-center">
          <div>
            <div class="label text-soft text-sm">Vencidos hoje / atrasados</div>
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

    <div class="grid grid-2 mt-14">
      <div class="card">
        <h3>Recebido — últimos 30 dias</h3>
        <div class="mt-8">${trendSeries.some((p) => p.value > 0) ? lineChartSVG(trendSeries, { color: CHART_COLORS.good }) : '<p class="text-soft text-sm">Sem recebimentos no período.</p>'}</div>
      </div>
      <div class="card">
        <h3>Contratos por status</h3>
        <div class="flex items-center gap-14 mt-14" style="flex-wrap:wrap">
          ${donutChartSVG(contractStatusSegments, { valueFormatter: (v) => String(v) })}
          <div style="flex:1;min-width:160px" class="flex flex-col gap-8">
            ${contractStatusSegments.map((s) => `
              <div class="flex items-center gap-8" style="font-size:12.5px">
                <span style="width:10px;height:10px;border-radius:50%;background:${s.color};display:inline-block;flex:none"></span>
                <span>${escapeHtml(s.label)}</span>
                <span class="text-soft mono" style="margin-left:auto">${s.value}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>

    <div class="grid grid-3 mt-14">
      <button class="card btn-block" style="text-align:left;border:1px solid var(--line)" onclick="router.navigate('#/gerente/contratos/novo')">
        <div class="flex items-center gap-10"><span class="icon-btn" style="background:var(--brand-soft);color:var(--brand);border:none">${Icons.plus}</span><strong>Novo contrato</strong></div>
      </button>
      <button class="card btn-block" style="text-align:left;border:1px solid var(--line)" onclick="router.navigate('#/gerente/clientes')">
        <div class="flex items-center gap-10"><span class="icon-btn" style="background:var(--accent-soft);color:var(--accent);border:none">${Icons.users}</span><strong>Clientes cadastrados: ${clientsCount || 0}</strong></div>
      </button>
      <button class="card btn-block" style="text-align:left;border:1px solid var(--line)" onclick="router.navigate('#/gerente/relatorios')">
        <div class="flex items-center gap-10"><span class="icon-btn" style="background:var(--warn-soft);color:var(--warn);border:none">${Icons.chart}</span><strong>Relatórios gerenciais</strong></div>
      </button>
    </div>
  `;
}

registerRoute('gerente/dashboard', { role: 'gerente', screenId: 'gerente-dashboard', title: 'Dashboard', render: renderGerenteDashboard });

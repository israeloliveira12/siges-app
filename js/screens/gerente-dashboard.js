/* ============================================================================
   Dashboard do gerente — visão geral de caixa, recebimentos e atalhos
   ============================================================================ */

async function renderGerenteDashboard() {
  const root = document.getElementById('screen-gerente-dashboard');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const today = todayISO();
  const monthStart = today.slice(0, 7) + '-01';

  const [
    { data: paymentsToday },
    { data: paymentsMonth },
    { count: openContracts },
    { count: clientsCount },
    { count: pendingRequests },
    { data: dueSoon },
  ] = await Promise.all([
    supa.from('payments').select('amount_received').gte('received_at', today),
    supa.from('payments').select('amount_received').gte('received_at', monthStart),
    supa.from('loan_contracts').select('id', { count: 'exact', head: true }).in('status', ['em_aberto', 'atrasado']),
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

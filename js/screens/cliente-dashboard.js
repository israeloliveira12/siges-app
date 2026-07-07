/* ============================================================================
   Painel do cliente — resumo de limite, score e atalhos
   ============================================================================ */

async function renderClienteDashboard() {
  const root = document.getElementById('screen-cliente-dashboard');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const clientId = App.session.user.id;
  const limit = App.client ? Number(App.client.credit_limit) : 0;

  let used = 0;
  try {
    const { data, error } = await supa.rpc('client_outstanding_balance', { p_client_id: clientId });
    if (!error) used = Number(data) || 0;
  } catch (e) { /* segue com 0 */ }

  const available = Math.max(0, limit - used);
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  const { count: pendingCount } = await supa
    .from('loan_requests').select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).eq('status', 'pendente');

  const { count: openCount } = await supa
    .from('loan_contracts').select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).in('status', ['em_aberto', 'atrasado']);

  const score = App.client ? App.client.score : 50;
  const tier = App.client ? App.client.score_tier : 'Bom';

  root.innerHTML = `
    <div class="grid grid-3">
      <div class="card stat-card">
        <div class="label">Limite disponível</div>
        <div class="value mono">${formatMoney(available)}</div>
        <div class="bar-wrap mt-8"><div class="bar-fill ${pct >= 100 ? 'over' : ''}" style="width:${pct}%"></div></div>
        <div class="hint mt-8">${formatMoney(used)} usado de ${formatMoney(limit)}</div>
      </div>
      <div class="card stat-card">
        <div class="label">Seu score</div>
        <div class="value mono">${score}</div>
        <div class="mt-8">${scoreTierBadge(tier)}</div>
      </div>
      <div class="card stat-card">
        <div class="label">Empréstimos em andamento</div>
        <div class="value mono">${openCount || 0}</div>
        <div class="hint mt-8">${pendingCount || 0} solicitação(ões) aguardando aprovação</div>
      </div>
    </div>

    <div class="grid grid-2 mt-14">
      <a href="#/cliente/solicitar" class="card" style="text-decoration:none;display:flex;align-items:center;gap:12px" onclick="event.preventDefault();router.navigate('#/cliente/solicitar')">
        <span class="icon-btn" style="background:var(--brand-soft);color:var(--brand);border:none">${Icons.plus}</span>
        <div><strong>Solicitar empréstimo</strong><div class="text-sm text-soft">Escolha um valor e envie para aprovação</div></div>
      </a>
      <a href="#/cliente/emprestimos" class="card" style="text-decoration:none;display:flex;align-items:center;gap:12px" onclick="event.preventDefault();router.navigate('#/cliente/emprestimos')">
        <span class="icon-btn" style="background:var(--accent-soft);color:var(--accent);border:none">${Icons.contract}</span>
        <div><strong>Meus empréstimos</strong><div class="text-sm text-soft">Parcelas, vencimentos e renovações</div></div>
      </a>
    </div>
  `;
}

registerRoute('cliente/dashboard', { role: 'cliente', screenId: 'cliente-dashboard', title: 'Início', render: renderClienteDashboard });

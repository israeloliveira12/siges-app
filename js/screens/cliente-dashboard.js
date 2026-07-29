/* ============================================================================
   Painel do cliente — resumo de limite, score e atalhos
   ============================================================================ */

async function renderClienteDashboard() {
  const root = document.getElementById('screen-cliente-dashboard');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const clientId = App.session.user.id;
  const limit = App.client ? Number(App.client.credit_limit) : 0;

  // Limite de crédito consome CAPITAL emprestado, não o saldo devedor total
  // (que inclui juros) — mesma regra usada em cliente-solicitar.js. Usar
  // outstanding_balance aqui fazia o "Limite disponível" do Início divergir
  // do "Limite disponível" da tela Solicitar pro mesmo cliente.
  let used = 0;
  try {
    const { data, error } = await supa.rpc('client_outstanding_principal', { p_client_id: clientId });
    if (!error) used = Number(data) || 0;
  } catch (e) { /* segue com 0 */ }

  const available = Math.max(0, limit - used);
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  const { count: pendingCount, error: e1 } = await supa
    .from('loan_requests').select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).eq('status', 'pendente');

  const { count: openCount, error: e2 } = await supa
    .from('loan_contracts').select('id', { count: 'exact', head: true })
    .eq('client_id', clientId).in('status', ['em_aberto', 'atrasado']);

  if (e1 || e2) {
    root.innerHTML = `<div class="card"><p class="auth-error">Não foi possível carregar seus dados agora. Recarregue a página ou tente novamente em instantes.</p></div>`;
    return;
  }

  const score = App.client ? App.client.score : 50;
  const tier = App.client ? App.client.score_tier : 'Bom';

  const firstName = (userDisplayName() || '').trim().split(' ')[0];

  root.innerHTML = `
    <h2 style="margin-bottom:16px">Olá, ${escapeHtml(firstName)}!</h2>
    <div class="card" style="background:var(--hero-dark);color:#fff;border:none;padding:22px 24px;border-radius:20px">
      <div style="font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;opacity:.8">Limite disponível</div>
      <div class="mono" style="font-size:38px;font-weight:800;margin-top:6px;letter-spacing:-0.01em">${formatMoney(available)}</div>
      <div class="bar-wrap mt-8" style="background:rgba(255,255,255,.16)"><div class="bar-fill ${pct >= 100 ? 'over' : ''}" style="width:${pct}%"></div></div>
      <div style="font-size:12px;margin-top:8px;opacity:.8">${formatMoney(used)} usado de ${formatMoney(limit)}</div>
    </div>

    <div class="grid grid-2 kpi-grid-2 mt-14">
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

    <div class="quick-actions-grid mt-14">
      <a href="#/cliente/solicitar" class="quick-action-btn" onclick="event.preventDefault();router.navigate('#/cliente/solicitar')">
        <span class="circle">${Icons.plus}</span>
        <span>Solicitar</span>
      </a>
      <a href="#/cliente/emprestimos" class="quick-action-btn" onclick="event.preventDefault();router.navigate('#/cliente/emprestimos')">
        <span class="circle">${Icons.contract}</span>
        <span>Empréstimos</span>
      </a>
    </div>
  `;
}

registerRoute('cliente/dashboard', { role: 'cliente', screenId: 'cliente-dashboard', title: 'Início', render: renderClienteDashboard });

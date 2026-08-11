/* ============================================================================
   Plataforma SaaS — Início: painel executivo do Administrador Master.
   Uma RPC só (get_platform_dashboard_stats) devolve tudo — assinantes,
   receita, uso agregado da plataforma inteira, saúde operacional e
   rankings — montado aqui em cima do jsonb devolvido, sem round-trips
   extras. Sem cobrança real nenhuma envolvida (MRR/ARR são só a soma de
   plans.price_monthly dos planos atribuídos, informativo).
   ============================================================================ */

function tenantHealthRowHtml(t, note) {
  return `
    <div class="flex items-center gap-8 mt-8" style="padding:6px 0;border-bottom:1px solid var(--line)">
      ${avatarHtml(t.name, 28)}
      <div style="min-width:0;flex:1 1 auto">
        <div class="text-sm" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.name)}</div>
        <div class="text-sm text-soft">${note}</div>
      </div>
    </div>
  `;
}

function planUsageNote(t) {
  const parts = [];
  const limits = t.plan_limits || {};
  if (typeof limits.max_gerentes === 'number' && limits.max_gerentes > 0) {
    const pct = Math.round((t.gerente_count / limits.max_gerentes) * 100);
    if (pct >= 90) parts.push(`${t.gerente_count}/${limits.max_gerentes} gerentes (${pct}%)`);
  }
  if (typeof limits.max_clientes === 'number' && limits.max_clientes > 0) {
    const pct = Math.round((t.cliente_count / limits.max_clientes) * 100);
    if (pct >= 90) parts.push(`${t.cliente_count}/${limits.max_clientes} clientes (${pct}%)`);
  }
  return parts.join(' · ') || 'Perto do limite do plano';
}

function inactivityNote(t) {
  if (!t.last_login_at) return 'Nenhum login registrado (na auditoria)';
  const days = Math.floor((Date.now() - new Date(t.last_login_at).getTime()) / 86400000);
  return `Último login há ${days} dia${days === 1 ? '' : 's'} · 0 contratos ativos`;
}

async function renderPlataformaInicio() {
  const root = document.getElementById('screen-plataforma-inicio');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const { data, error } = await supa.rpc('get_platform_dashboard_stats');
  if (error || !data) {
    root.innerHTML = `<div class="card"><p class="auth-error">Não foi possível carregar o painel agora. Recarregue a página ou tente novamente em instantes.</p></div>`;
    return;
  }
  paintPlataformaInicio(root, data);
}

function paintPlataformaInicio(root, data) {
  const s = data.summary;
  const tenants = data.tenants || [];
  const byPlan = data.by_plan || [];
  const arr = s.mrr * 12;

  const topByClients = [...tenants].filter((t) => t.cliente_count > 0).sort((a, b) => b.cliente_count - a.cliente_count).slice(0, 5);
  const topByCapital = [...tenants].filter((t) => t.capital_active > 0).sort((a, b) => b.capital_active - a.capital_active).slice(0, 5);
  const newest = [...tenants].slice(0, 5); // já vem ordenado por created_at desc

  const nearLimit = tenants.filter((t) => {
    if (!t.active || !t.plan_limits) return false;
    const l = t.plan_limits;
    return (typeof l.max_gerentes === 'number' && l.max_gerentes > 0 && t.gerente_count / l.max_gerentes >= 0.9) ||
      (typeof l.max_clientes === 'number' && l.max_clientes > 0 && t.cliente_count / l.max_clientes >= 0.9);
  });

  const inactive = tenants.filter((t) => {
    if (!t.active || t.contract_count > 0) return false;
    if (!t.last_login_at) return true;
    return (Date.now() - new Date(t.last_login_at).getTime()) > 30 * 86400000;
  });

  const withErrors = [...tenants].filter((t) => t.errors_recent > 0).sort((a, b) => b.errors_recent - a.errors_recent);

  const churnCount = s.suspended_this_month + s.deleted_this_month;
  const churnRate = s.total_tenants > 0 ? (churnCount / s.total_tenants) * 100 : 0;

  const planColors = [CHART_COLORS.brand, CHART_COLORS.accent, CHART_COLORS.purple, CHART_COLORS.warn, CHART_COLORS.good, CHART_COLORS.bad];
  const planSegments = byPlan.map((p, i) => ({ label: p.plan_name, value: p.tenant_count, color: planColors[i % planColors.length] }));
  const revenueBars = byPlan.filter((p) => p.mrr_contribution > 0).map((p, i) => ({ label: p.plan_name, value: p.mrr_contribution, color: planColors[i % planColors.length] }));

  root.innerHTML = `
    <div class="card" style="background:var(--hero-dark);color:#fff;border:none;padding:22px 24px;border-radius:20px">
      <div style="font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;opacity:.8">Receita mensal recorrente (MRR)</div>
      <div style="font-size:38px;font-weight:800;margin-top:6px;letter-spacing:-0.01em;font-variant-numeric:proportional-nums">${formatMoney(s.mrr)}</div>
      <div class="flex gap-20 mt-14" style="flex-wrap:wrap">
        <div>
          <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;opacity:.65">Projeção anual (ARR)</div>
          <div style="font-size:18px;font-weight:700;margin-top:2px">${formatMoney(arr)}</div>
        </div>
        <div>
          <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;opacity:.65">Ticket médio (empresas com plano pago)</div>
          <div style="font-size:18px;font-weight:700;margin-top:2px">${formatMoney(s.avg_ticket)}</div>
        </div>
      </div>
      <div style="font-size:12px;margin-top:10px;opacity:.8;border-top:1px solid rgba(255,255,255,.2);padding-top:8px">Sem cobrança automática nenhuma — preço de cada plano é só informativo, definido em Planos.</div>
    </div>

    <div class="grid grid-4 kpi-grid-4 mt-14">
      <div class="card stat-card">
        <div class="label">Empresas ativas</div>
        <div class="value mono">${s.active_tenants}</div>
        <div class="text-sm text-soft mt-8">${s.suspended_tenants} suspensa${s.suspended_tenants === 1 ? '' : 's'} · ${s.total_tenants} no total</div>
      </div>
      <div class="card stat-card">
        <div class="label">Novas empresas — mês</div>
        <div class="value mono">${s.new_this_month}</div>
        <div class="text-sm mt-8">${trendBadgeHtml(s.new_this_month, s.new_last_month)} <span class="text-soft">vs. mês passado</span></div>
      </div>
      <div class="card stat-card" style="border-top:3px solid ${churnCount > 0 ? 'var(--bad)' : 'var(--line)'}">
        <div class="label">Churn — mês</div>
        <div class="value mono" style="color:${churnCount > 0 ? 'var(--bad)' : 'var(--ink)'}">${formatNumber(churnRate, 1)}%</div>
        <div class="text-sm text-soft mt-8">${s.suspended_this_month} suspensa${s.suspended_this_month === 1 ? '' : 's'} + ${s.deleted_this_month} excluída${s.deleted_this_month === 1 ? '' : 's'}</div>
      </div>
      <div class="card stat-card">
        <div class="label">Tempo médio até suspensão</div>
        <div class="value mono">${s.avg_lifetime_days_suspended > 0 ? formatNumber(s.avg_lifetime_days_suspended, 0) + ' dias' : '—'}</div>
        <div class="text-sm text-soft mt-8">Só empresas já suspensas alguma vez (${s.deleted_total} excluída${s.deleted_total === 1 ? '' : 's'} no histórico, fora dessa média)</div>
      </div>
    </div>

    <div class="grid grid-2 mt-14">
      <div class="card">
        <h3>Distribuição por plano</h3>
        <div class="flex gap-20 mt-14 items-center" style="flex-wrap:wrap">
          ${donutChartSVG(planSegments, { valueFormatter: (v) => `${v} empresa${v === 1 ? '' : 's'}` })}
          <div style="flex:1 1 180px;min-width:180px">${donutLegendHtml(planSegments, { valueFormatter: (v) => `${v}` })}</div>
        </div>
      </div>
      <div class="card">
        <h3>Receita por plano (MRR)</h3>
        ${revenueBars.length
          ? barChartSVG(revenueBars, chartSize(520, 220, 300, 200))
          : '<p class="text-sm text-soft mt-14">Nenhum plano com preço definido em uso ainda.</p>'}
      </div>
    </div>

    <h3 class="mt-20">Uso agregado da plataforma</h3>
    <div class="grid grid-4 kpi-grid-4 mt-14">
      <div class="card stat-card"><div class="label">Clientes finais (todas as empresas)</div><div class="value mono">${s.total_clients}</div></div>
      <div class="card stat-card"><div class="label">Contratos ativos (todas as empresas)</div><div class="value mono">${s.total_contracts_active}</div></div>
      <div class="card stat-card"><div class="label">Capital emprestado (todas as empresas)</div><div class="value mono">${formatMoney(s.total_capital_active)}</div></div>
      <div class="card stat-card"><div class="label">Administradores/gerentes (todas as empresas)</div><div class="value mono">${s.total_gerentes}</div></div>
    </div>

    <h3 class="mt-20">Saúde operacional</h3>
    <div class="grid grid-3 mt-14" style="align-items:start">
      <div class="card">
        <h4>Perto do limite do plano</h4>
        ${nearLimit.length ? nearLimit.map((t) => tenantHealthRowHtml(t, planUsageNote(t))).join('') : '<p class="text-sm text-soft mt-8">Nenhuma empresa perto do limite.</p>'}
      </div>
      <div class="card">
        <h4>Sem atividade recente</h4>
        ${inactive.length ? inactive.map((t) => tenantHealthRowHtml(t, inactivityNote(t))).join('') : '<p class="text-sm text-soft mt-8">Nenhuma empresa parada.</p>'}
      </div>
      <div class="card">
        <h4>Erros do sistema (7 dias)</h4>
        ${withErrors.length ? withErrors.map((t) => tenantHealthRowHtml(t, `${t.errors_recent} erro${t.errors_recent === 1 ? '' : 's'} recente${t.errors_recent === 1 ? '' : 's'}`)).join('') : '<p class="text-sm text-soft mt-8">Nenhum erro recente.</p>'}
      </div>
    </div>

    <h3 class="mt-20">Rankings</h3>
    <div class="grid grid-3 mt-14" style="align-items:start">
      <div class="card">
        <h4>Top por clientes</h4>
        ${topByClients.length ? topByClients.map((t) => tenantHealthRowHtml(t, `${t.cliente_count} cliente${t.cliente_count === 1 ? '' : 's'}`)).join('') : '<p class="text-sm text-soft mt-8">Sem dados ainda.</p>'}
      </div>
      <div class="card">
        <h4>Top por capital emprestado</h4>
        ${topByCapital.length ? topByCapital.map((t) => tenantHealthRowHtml(t, formatMoney(t.capital_active))).join('') : '<p class="text-sm text-soft mt-8">Sem dados ainda.</p>'}
      </div>
      <div class="card">
        <h4>Empresas mais novas</h4>
        ${newest.length ? newest.map((t) => tenantHealthRowHtml(t, formatDate(t.created_at))).join('') : '<p class="text-sm text-soft mt-8">Sem dados ainda.</p>'}
      </div>
    </div>
  `;
}

registerRoute('plataforma/inicio', { role: 'plataforma', screenId: 'plataforma-inicio', title: 'Plataforma SaaS', render: renderPlataformaInicio });

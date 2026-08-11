/* ============================================================================
   Plataforma SaaS — Métricas históricas. Snapshot diário (capturado pelo
   cron já existente, api/cron-daily-check.js) alimentando gráficos de
   evolução mês a mês — diferente de "Início", que é um retrato do momento
   atual. Botão "Capturar agora" existe pra não precisar esperar o cron do
   dia seguinte pra ver o primeiro ponto.
   ============================================================================ */

async function renderPlataformaMetricas() {
  const root = document.getElementById('screen-plataforma-metricas');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const { data, error } = await supa.rpc('list_platform_metrics_snapshots');
  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }

  paintPlataformaMetricas(root, data || []);
}

function paintPlataformaMetricas(root, snapshots) {
  const mrrSeries = snapshots.map((s) => ({ label: formatDate(s.snapshot_date), value: Number(s.mrr) }));
  const tenantsSeries = snapshots.map((s) => ({ label: formatDate(s.snapshot_date), value: s.active_tenants }));
  const capitalSeries = snapshots.map((s) => ({ label: formatDate(s.snapshot_date), value: Number(s.total_capital_active) }));

  root.innerHTML = `
    <div class="flex justify-between items-center" style="flex-wrap:wrap;gap:10px">
      <p class="text-sm text-soft">${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'} guardado${snapshots.length === 1 ? '' : 's'}. Um ponto novo é capturado automaticamente todo dia.</p>
      <button class="btn btn-outline btn-sm" id="pm-capture-now">Capturar snapshot de hoje</button>
    </div>
    <div id="pm-feedback" class="mt-8"></div>

    ${snapshots.length < 2 ? `
      <div class="card mt-14">
        <p class="text-sm text-soft">Ainda não há histórico suficiente pra desenhar um gráfico de evolução — isso é normal logo depois de ativar esta tela. Volte em alguns dias, ou clique em "Capturar snapshot de hoje" pra adiantar o primeiro ponto.</p>
      </div>
    ` : `
      <div class="card mt-14">
        <h3>MRR ao longo do tempo</h3>
        ${lineChartSVG(mrrSeries, chartSize(1180, 240, 320, 200))}
      </div>
      <div class="grid grid-2 mt-14">
        <div class="card">
          <h3>Empresas ativas</h3>
          ${lineChartSVG(tenantsSeries, { ...chartSize(560, 220, 300, 200), valueFormatter: (v) => `${v} empresa${v === 1 ? '' : 's'}`, color: CHART_COLORS.brand })}
        </div>
        <div class="card">
          <h3>Capital emprestado (todas as empresas)</h3>
          ${lineChartSVG(capitalSeries, { ...chartSize(560, 220, 300, 200), color: CHART_COLORS.purple })}
        </div>
      </div>
    `}
  `;

  document.getElementById('pm-capture-now').onclick = async (e) => {
    const feedback = document.getElementById('pm-feedback');
    feedback.innerHTML = '';
    const btn = e.currentTarget;
    btn.disabled = true;
    const { error } = await supa.rpc('capture_platform_metrics_snapshot');
    btn.disabled = false;
    if (error) { feedback.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
    showToast('Snapshot de hoje capturado.');
    renderPlataformaMetricas();
  };
}

registerRoute('plataforma/metricas', { role: 'plataforma', screenId: 'plataforma-metricas', title: 'Métricas históricas', render: renderPlataformaMetricas });

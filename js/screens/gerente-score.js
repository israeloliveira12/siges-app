/* ============================================================================
   Gerente — Score de clientes (ranking + recalcular)
   ============================================================================ */

async function renderGerenteScore() {
  const root = document.getElementById('screen-gerente-score');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const { data, error } = await supa
    .from('clients')
    .select('*, profiles!clients_profile_id_fkey(full_name, email)')
    .order('score', { ascending: false });

  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }

  const rows = data || [];
  const melhores = rows.slice(0, 10);
  const piores = [...rows].sort((a, b) => a.score - b.score).slice(0, 10);

  root.innerHTML = `
    <div class="flex justify-between items-center" style="flex-wrap:wrap;gap:10px">
      <p class="text-sm text-soft">Score de 0 a 100, recalculado a partir do histórico de pagamentos de cada cliente.</p>
      <button class="btn btn-outline btn-sm" id="recalc-all">${Icons.renew} Recalcular todos</button>
    </div>

    <div class="card mt-14">
      <h3>Como o score é calculado</h3>
      <p class="text-sm text-soft mt-8">Todo cliente começa neutro e ganha ou perde pontos conforme o histórico real de pagamentos. Reprovação de solicitação de empréstimo <strong>nunca</strong> entra nessa conta.</p>
      <div class="grid grid-2 mt-14" style="gap:4px 24px">
        <div>
          <div class="text-sm" style="font-weight:700;color:var(--good);margin-bottom:6px">Aumenta o score</div>
          <div class="text-sm text-soft" style="line-height:1.9">
            <div>Pagar em dia — até <strong>40 pts</strong></div>
            <div>Pagar antecipado — até <strong>20 pts</strong></div>
            <div>Contratos quitados — até <strong>+10 pts</strong> (+2 cada, máx. 5)</div>
            <div>Recuperação após atraso (últimos 90 dias) — <strong>+5 pts</strong></div>
            <div>Renovações pagas em dia — até <strong>+5 pts</strong> (+1 cada, máx. 5)</div>
          </div>
        </div>
        <div>
          <div class="text-sm" style="font-weight:700;color:var(--bad);margin-bottom:6px">Reduz o score</div>
          <div class="text-sm text-soft" style="line-height:1.9">
            <div>Atraso médio nos pagamentos — até <strong>−20 pts</strong></div>
            <div>Qualquer contrato em perda — <strong>−30 pts</strong> (penalidade fixa)</div>
          </div>
        </div>
      </div>
    </div>

    <div class="grid grid-2 mt-14">
      <div class="card">
        <h3>Ranking — melhores scores</h3>
        <div class="mt-8">${scoreListHtml(melhores)}</div>
      </div>
      <div class="card" style="border-color:var(--bad)">
        <h3 style="color:var(--bad)">Atenção — menores scores</h3>
        <div class="mt-8">${scoreListHtml(piores)}</div>
      </div>
    </div>
  `;

  document.getElementById('recalc-all').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Recalculando...';
    await supa.rpc('recalculate_all_scores');
    showToast('Scores recalculados.');
    renderGerenteScore();
  };

  root.querySelectorAll('.score-row').forEach((el) => {
    el.onclick = () => renderClienteScoreDetalheGerente(el.dataset.id);
  });
}

function scoreListHtml(rows) {
  if (!rows.length) return `<div class="empty-state"><p>Sem clientes suficientes ainda.</p></div>`;
  return rows.map((c) => `
    <div class="score-row flex justify-between items-center" style="padding:9px 0;border-bottom:1px solid var(--line);cursor:pointer" data-id="${c.profile_id}">
      <div>${escapeHtml((c.profiles || {}).full_name || '—')}</div>
      <div class="flex items-center gap-8"><span class="mono">${c.score}</span>${scoreTierBadge(c.score_tier)}</div>
    </div>
  `).join('');
}

async function renderClienteScoreDetalheGerente(clientId) {
  const root = document.getElementById('screen-gerente-score');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const { data: client } = await supa.from('clients').select('*, profiles!clients_profile_id_fkey(full_name)').eq('profile_id', clientId).maybeSingle();
  const { data: clientContracts } = await supa.from('loan_contracts').select('id').eq('client_id', clientId);
  const contractIds = (clientContracts || []).map((c) => c.id);
  const { data: installments } = contractIds.length
    ? await supa.from('installments').select('*').in('contract_id', contractIds)
    : { data: [] };

  const paid = (installments || []).filter((i) => i.status === 'paga');
  const onTime = paid.filter((i) => new Date(i.paid_at) <= new Date(i.due_date + 'T23:59:59'));
  const late = paid.filter((i) => new Date(i.paid_at) > new Date(i.due_date + 'T23:59:59'));
  const pct = (n, d) => d ? Math.round((n / d) * 100) : 0;

  root.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="back-to-ranking">${Icons.chevronLeft} Voltar ao ranking</button>
    <div class="card mt-14" style="background:var(--brand-soft)">
      <div class="flex justify-between items-center">
        <div>
          <h3>${escapeHtml((client.profiles || {}).full_name || '')}</h3>
          <div class="mono" style="font-size:28px;font-weight:800">${client.score}</div>
          ${scoreTierBadge(client.score_tier)}
        </div>
        <button class="btn btn-primary btn-sm" id="recalc-one">${Icons.renew} Recalcular</button>
      </div>
    </div>
    <div class="grid grid-3 mt-14">
      <div class="card stat-card"><div class="label">Pagas em dia</div><div class="value mono">${pct(onTime.length, paid.length)}%</div><div class="hint">${onTime.length} de ${paid.length} parcelas</div></div>
      <div class="card stat-card"><div class="label">Pagas com atraso</div><div class="value mono">${pct(late.length, paid.length)}%</div></div>
      <div class="card stat-card"><div class="label">Total de parcelas pagas</div><div class="value mono">${paid.length}</div></div>
    </div>
  `;

  document.getElementById('back-to-ranking').onclick = () => renderGerenteScore();
  document.getElementById('recalc-one').onclick = async () => {
    await supa.rpc('recalculate_client_score', { p_client_id: clientId });
    showToast('Score recalculado.');
    renderClienteScoreDetalheGerente(clientId);
  };
}

registerRoute('gerente/score', { role: 'gerente', screenId: 'gerente-score', title: 'Score de Clientes', render: renderGerenteScore });

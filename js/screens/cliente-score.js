/* ============================================================================
   Cliente — meu score de crédito
   ============================================================================ */

async function renderClienteScore() {
  const root = document.getElementById('screen-cliente-score');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const { data: client, error: e1 } = await supa.from('clients').select('*').eq('profile_id', App.session.user.id).maybeSingle();
  const { data: contracts, error: e2 } = await supa.from('loan_contracts').select('id').eq('client_id', App.session.user.id);
  const contractIds = (contracts || []).map((c) => c.id);
  const { data: installments, error: e3 } = contractIds.length
    ? await supa.from('installments').select('*').in('contract_id', contractIds)
    : { data: [], error: null };

  if (e1 || e2 || e3) {
    root.innerHTML = `<div class="card"><p class="auth-error">Não foi possível carregar seu score agora. Recarregue a página ou tente novamente em instantes.</p></div>`;
    return;
  }

  const paid = (installments || []).filter((i) => i.status === 'paga');
  // Compara datas puras (paid_at::date <= due_date), mesma definição usada no
  // motor de score (recalculate_client_score, schema.sql) — comparar o
  // instante UTC de paid_at com due_date+'T23:59:59' parseado em fuso LOCAL
  // inflava o indicador (o cutoff local vira mais tarde em UTC, "perdoando"
  // pagamentos feitos até ~1 dia depois do vencimento).
  const onTime = paid.filter((i) => i.paid_at && String(i.paid_at).slice(0, 10) <= i.due_date);
  const pct = (n, d) => d ? Math.round((n / d) * 100) : 0;

  root.innerHTML = `
    <div class="card" style="background:var(--brand-soft)">
      <div class="label text-soft">Seu score de crédito</div>
      <div class="mono" style="font-size:36px;font-weight:800">${client ? client.score : 50}</div>
      ${scoreTierBadge(client ? client.score_tier : 'Bom')}
      <p class="text-sm text-soft mt-14">Pagar em dia (ou adiantado) é o que mais aumenta seu score. Atrasos reduzem sua pontuação.</p>
    </div>
    <div class="grid grid-2 mt-14">
      <div class="card stat-card"><div class="label">Parcelas pagas em dia</div><div class="value mono">${pct(onTime.length, paid.length)}%</div></div>
      <div class="card stat-card"><div class="label">Total de parcelas pagas</div><div class="value mono">${paid.length}</div></div>
    </div>
  `;
}

registerRoute('cliente/score', { role: 'cliente', screenId: 'cliente-score', title: 'Meu Score', render: renderClienteScore });

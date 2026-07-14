/* ============================================================================
   Gerente — Score de clientes (ranking + recalcular)
   ============================================================================ */

// Módulo-level (sobrevive a repaints) — controla se cada lista mostra só o
// top 15 ou todos os clientes daquela partição, igual ao padrão já usado em
// plExpandedMonths (gerente-planejamento.js).
let scoreShowAllMelhores = false;
let scoreShowAllPiores = false;

async function renderGerenteScore() {
  const root = document.getElementById('screen-gerente-score');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const [{ data, error }, { data: paidInstallments, error: error2 }] = await Promise.all([
    supa.from('clients').select('*, profiles!clients_profile_id_fkey(full_name, email)').order('score', { ascending: false }),
    // Só as 2 colunas necessárias pro KPI de "pagamento adiantado" — sem
    // join, leve mesmo somando toda a carteira (mesmo raciocínio de volume
    // já aceito em outras telas sem paginação).
    supa.from('installments').select('paid_at, due_date').eq('status', 'paga'),
  ]);

  if (error || error2) { root.innerHTML = `<div class="auth-error">${escapeHtml((error || error2).message)}</div>`; return; }

  paintGerenteScore(root, { rows: data || [], paidInstallments: paidInstallments || [] });
}

// Repintura pura (sem refetch) — usada pelos toggles "Ver todos/Ver menos",
// que só mudam quantos itens aparecem na lista já carregada. Chamar
// renderGerenteScore() (que refaz a consulta inteira) pra isso fazia a tela
// inteira "piscar" como um F5, mesmo o dado já estando em memória.
function paintGerenteScore(root, { rows, paidInstallments }) {
  // Partição estrita por limiar — nunca por "top N / bottom N" — pra um
  // cliente jamais poder cair nas duas listas ao mesmo tempo. `rows` já vem
  // ordenado desc pelo score (query acima), então melhores mantém a ordem
  // (melhor primeiro) e piores é reordenado asc (pior primeiro).
  const melhoresAll = rows.filter((c) => c.score >= 70);
  const pioresAll = rows.filter((c) => c.score < 70).sort((a, b) => a.score - b.score);
  const melhores = scoreShowAllMelhores ? melhoresAll : melhoresAll.slice(0, 15);
  const piores = scoreShowAllPiores ? pioresAll : pioresAll.slice(0, 15);

  const scoreMedio = rows.length ? rows.reduce((s, c) => s + Number(c.score || 0), 0) / rows.length : 0;

  // "Adiantado" usa a MESMA definição do motor de score (paid_at::date <
  // due_date, ver recalculate_client_score no schema.sql) — não a comparação
  // com fuso local usada no card de detalhe do cliente, pra não divergir do
  // que realmente alimenta o score.
  const paidList = paidInstallments || [];
  const totalPaid = paidList.length;
  const earlyPaid = paidList.filter((i) => i.paid_at && i.due_date && String(i.paid_at).slice(0, 10) < i.due_date).length;
  const pctAdiantado = totalPaid ? (earlyPaid / totalPaid) * 100 : 0;

  const tierCounts = { 'Ouro': 0, 'Bom': 0, 'Atenção': 0, 'Alto risco': 0 };
  rows.forEach((c) => { if (tierCounts[c.score_tier] != null) tierCounts[c.score_tier]++; });
  const tierSegments = [
    { label: 'Ouro', value: tierCounts['Ouro'], color: CHART_COLORS.warn },
    { label: 'Bom', value: tierCounts['Bom'], color: CHART_COLORS.good },
    { label: 'Atenção', value: tierCounts['Atenção'], color: CHART_COLORS.purple },
    { label: 'Alto risco', value: tierCounts['Alto risco'], color: CHART_COLORS.bad },
  ];
  const countFmt = (v) => `${v} cliente${v === 1 ? '' : 's'}`;

  injectScoreHelpButton();

  root.innerHTML = `
    <div class="flex justify-between items-center" style="flex-wrap:wrap;gap:10px">
      <p class="text-sm text-soft">Score de 0 a 100, recalculado a partir do histórico de pagamentos de cada cliente.</p>
      <button class="btn btn-outline btn-sm" id="recalc-all">${Icons.renew} Recalcular todos</button>
    </div>

    <div class="grid grid-score-summary mt-14">
      <div class="flex" style="flex-direction:column;gap:14px">
        <div class="card stat-card"><div class="label">Clientes analisados</div><div class="value mono">${rows.length}</div></div>
        <div class="card stat-card"><div class="label">Score médio</div><div class="value mono">${formatNumber(scoreMedio, 1)}</div></div>
        <div class="card stat-card">
          <div class="label">Pagamento adiantado</div>
          <div class="value mono">${formatNumber(pctAdiantado, 0)}%</div>
          <div class="hint mt-8">${earlyPaid} de ${totalPaid} parcelas pagas</div>
        </div>
      </div>
      ${rows.length ? `
      <div class="card">
        <h3>Distribuição por perfil</h3>
        <div class="flex items-center mt-14" style="gap:20px;flex-wrap:wrap">
          ${donutChartSVG(tierSegments, { valueFormatter: countFmt })}
          <div style="flex:1;min-width:220px">${donutLegendHtml(tierSegments, { valueFormatter: countFmt })}</div>
        </div>
      </div>` : '<div></div>'}
    </div>

    <div class="grid grid-2 mt-14">
      <div class="card">
        <h3>Ranking — melhores scores</h3>
        <div class="mt-8">${scoreListHtml(melhores)}</div>
        ${melhoresAll.length > 15 ? `<button class="btn btn-ghost btn-sm mt-8" id="toggle-melhores">${scoreShowAllMelhores ? 'Ver menos' : `Ver todos (${melhoresAll.length})`}</button>` : ''}
      </div>
      <div class="card" style="border-color:var(--bad)">
        <h3 style="color:var(--bad)">Atenção — menores scores</h3>
        <div class="mt-8">${scoreListHtml(piores)}</div>
        ${pioresAll.length > 15 ? `<button class="btn btn-ghost btn-sm mt-8" id="toggle-piores">${scoreShowAllPiores ? 'Ver menos' : `Ver todos (${pioresAll.length})`}</button>` : ''}
      </div>
    </div>
  `;

  document.getElementById('recalc-all').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Recalculando...';
    const { error: recalcError } = await supa.rpc('recalculate_all_scores');
    if (recalcError) {
      showToast('Erro ao recalcular: ' + recalcError.message);
      e.target.disabled = false;
      e.target.textContent = 'Recalcular todos';
      return;
    }
    showToast('Scores recalculados.');
    renderGerenteScore();
  };

  const toggleMelhoresBtn = document.getElementById('toggle-melhores');
  if (toggleMelhoresBtn) toggleMelhoresBtn.onclick = () => { scoreShowAllMelhores = !scoreShowAllMelhores; paintGerenteScore(root, { rows, paidInstallments }); };
  const togglePioresBtn = document.getElementById('toggle-piores');
  if (togglePioresBtn) togglePioresBtn.onclick = () => { scoreShowAllPiores = !scoreShowAllPiores; paintGerenteScore(root, { rows, paidInstallments }); };

  root.querySelectorAll('.score-row').forEach((el) => {
    el.onclick = () => renderClienteScoreDetalheGerente(el.dataset.id);
  });
}

// Ícone "?" ao lado do título "Score de Clientes" na topbar — abre em modal o
// texto que antes ficava fixo no topo da tela, poluindo o visual.
function injectScoreHelpButton() {
  const titleEl = document.getElementById('topbar-title');
  if (!titleEl) return;
  titleEl.innerHTML = `<span style="vertical-align:middle">Score de Clientes</span> <button class="title-help-btn" id="score-help-btn" title="Como o score é calculado">${Icons.help}</button>`;
  document.getElementById('score-help-btn').onclick = openScoreHelpModal;
}

function openScoreHelpModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>Como o score é calculado</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <p class="text-sm text-soft">Cliente novo começa com score-base <strong>50</strong>. Os <strong>bônus</strong> de comportamento só passam a valer depois que ele quita o primeiro contrato ou faz a primeira renovação — nesse marco o score pula pra <strong>70</strong> e passa a subir com o comportamento real. Já as <strong>penalidades</strong> de risco (atraso e perda) valem sempre, mesmo antes disso. Reprovação de solicitação de empréstimo <strong>nunca</strong> entra nessa conta.</p>
        <p class="text-sm text-soft mt-8">Depois da graduação, o bônus (até <strong>+30 pts</strong>) é o produto de dois fatores: <strong>qualidade</strong> (consistência de pagamento — em dia/adiantado) × <strong>maturidade</strong> (volume de histórico acumulado — parcelas pagas, contratos quitados e renovações em dia, com retornos decrescentes). Isso torna cada ponto progressivamente mais difícil: 1-2 contratos bons já chegam a 80, mas encostar em 90-100 exige um histórico bem mais longo e consistente — impossível de forçar rápido.</p>
        <div class="grid grid-2 mt-14" style="gap:4px 24px">
          <div>
            <div class="text-sm" style="font-weight:700;color:var(--good);margin-bottom:6px">Aumenta o score (só depois da graduação)</div>
            <div class="text-sm text-soft" style="line-height:1.9">
              <div>Qualidade × maturidade do histórico — até <strong>30 pts</strong></div>
              <div>Recuperação após atraso (últimos 90 dias) — <strong>+2 pts</strong></div>
            </div>
          </div>
          <div>
            <div class="text-sm" style="font-weight:700;color:var(--bad);margin-bottom:6px">Reduz o score (sempre, graduado ou não)</div>
            <div class="text-sm text-soft" style="line-height:1.9">
              <div>Atraso médio histórico nos pagamentos — até <strong>−20 pts</strong></div>
              <div>Parcela ou ciclo vencido e não pago agora — <strong>−15 pts</strong></div>
              <div>Qualquer contrato em perda — <strong>−30 pts</strong> (penalidade fixa)</div>
            </div>
          </div>
        </div>
        <p class="text-sm text-soft mt-14">De 70 a 100 o cliente aparece em "Ranking — melhores scores"; abaixo de 70, em "Atenção — menores scores" — nunca nas duas.</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="close-modal-2">Entendi</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('close-modal-2').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
}

function scoreListHtml(rows) {
  if (!rows.length) return `<div class="empty-state"><p>Sem clientes suficientes ainda.</p></div>`;
  return rows.map((c) => `
    <div class="score-row flex items-center gap-10" style="padding:9px 0;border-bottom:1px solid var(--line);cursor:pointer" data-id="${c.profile_id}">
      ${avatarHtml((c.profiles || {}).full_name, 28)}
      <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((c.profiles || {}).full_name || '—')}</div>
      <div class="flex items-center gap-8" style="flex:none"><span class="mono">${c.score}</span>${scoreTierBadge(c.score_tier)}</div>
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
  // Mesma definição do motor de score (paid_at::date <= due_date) — ver nota
  // em cliente-score.js sobre o bug de fuso horário da comparação anterior.
  const onTime = paid.filter((i) => i.paid_at && String(i.paid_at).slice(0, 10) <= i.due_date);
  const late = paid.filter((i) => i.paid_at && String(i.paid_at).slice(0, 10) > i.due_date);
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
  document.getElementById('recalc-one').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const { error } = await supa.rpc('recalculate_client_score', { p_client_id: clientId });
    if (error) { btn.disabled = false; showToast('Erro ao recalcular: ' + error.message); return; }
    showToast('Score recalculado.');
    renderClienteScoreDetalheGerente(clientId);
  };
}

registerRoute('gerente/score', { role: 'gerente', screenId: 'gerente-score', title: 'Score de Clientes', render: renderGerenteScore });

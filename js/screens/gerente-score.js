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

    <div class="card mt-14 score-hero card-hero" style="background:var(--hero-dark);color:#fff;border-radius:20px">
      <div class="flex" style="flex-wrap:wrap;gap:28px;align-items:center">
        <div style="min-width:170px">
          <div class="text-sm" style="opacity:.6">Score médio da carteira</div>
          <div class="mono" style="font-size:38px;font-weight:800;letter-spacing:-0.01em">${formatNumber(scoreMedio, 1)}</div>
          <div class="flex mt-14" style="flex-wrap:wrap;gap:20px">
            <div>
              <div class="text-sm" style="opacity:.6">Clientes analisados</div>
              <div class="mono" style="font-size:17px;font-weight:700">${rows.length}</div>
            </div>
            <div>
              <div class="text-sm" style="opacity:.6">Pagamento adiantado</div>
              <div class="mono" style="font-size:17px;font-weight:700">${formatNumber(pctAdiantado, 0)}%</div>
              <div class="text-sm" style="opacity:.6">${earlyPaid} de ${totalPaid} parcelas</div>
            </div>
          </div>
        </div>
        ${rows.length ? `
        <div class="flex items-center" style="gap:20px;flex-wrap:wrap;flex:1;min-width:260px">
          ${donutChart(tierSegments, { valueFormatter: countFmt })}
          <div style="flex:1;min-width:200px">${donutLegendHtml(tierSegments, { valueFormatter: countFmt })}</div>
        </div>` : ''}
      </div>
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
  // UX-02 (auditoria 2026-08-23): prende o foco dentro do modal, fecha com
  // Escape e devolve o foco a quem abriu. Antes, com o modal aberto, o Tab
  // passeava pela página ATRÁS dele e o Escape não fazia nada.
  wireModal(overlay, close);
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

/* ----------------------------------------------------------------------------
   Ficha analítica do cliente (menu Score -> clicar no cliente)

   Tudo que é dinheiro ou contagem vem SOMADO do banco (client_analytics,
   client_loan_history, client_payment_series — migration_054). Nada é somado
   aqui a partir de uma listagem: o PostgREST corta em 1.000 linhas e o total
   sairia menor que o real sem erro nenhum na tela (classe FIN-01).
---------------------------------------------------------------------------- */

// Classificação de risco a partir dos próprios números do cliente. É um
// RESUMO de leitura, não um motor de decisão: o score (0–100) continua sendo a
// nota oficial, calculada no banco. Aqui o objetivo é responder "posso
// emprestar de novo?" juntando o que o score não mostra sozinho — atraso em
// aberto agora, prejuízo já reconhecido e histórico de pontualidade.
function clientRiskAssessment(a, score) {
  const motivos = [];
  let nivel = 'baixo';
  const pagas = Number(a.parcelas_pagas || 0);
  const pontualidade = pagas ? (Number(a.parcelas_em_dia || 0) / pagas) * 100 : null;

  if (Number(a.prejuizo_reconhecido || 0) > 0) {
    nivel = 'alto';
    motivos.push(`já gerou ${formatMoney(a.prejuizo_reconhecido)} de prejuízo reconhecido`);
  }
  if (Number(a.parcelas_vencidas || 0) > 0) {
    nivel = 'alto';
    motivos.push(`tem ${a.parcelas_vencidas} parcela${Number(a.parcelas_vencidas) === 1 ? '' : 's'} vencida${Number(a.parcelas_vencidas) === 1 ? '' : 's'} agora (${a.atraso_atual_dias} dia${Number(a.atraso_atual_dias) === 1 ? '' : 's'} de atraso)`);
  }
  if (nivel !== 'alto') {
    if (pontualidade !== null && pontualidade < 60) {
      nivel = 'alto';
      motivos.push(`paga em dia em apenas ${formatNumber(pontualidade, 0)}% das vezes`);
    } else if (pontualidade !== null && pontualidade < 85) {
      nivel = 'medio';
      motivos.push(`paga em dia em ${formatNumber(pontualidade, 0)}% das vezes`);
    }
    if (Number(a.atraso_medio_dias || 0) >= 7 && nivel !== 'alto') {
      nivel = nivel === 'baixo' ? 'medio' : nivel;
      motivos.push(`quando atrasa, atrasa ${formatNumber(a.atraso_medio_dias, 0)} dias em média`);
    }
  }
  if (Number(score) < 40 && nivel === 'baixo') { nivel = 'medio'; motivos.push(`score ${score} abaixo de 40`); }
  if (!pagas && !Number(a.parcelas_vencidas || 0)) {
    nivel = 'novo';
    motivos.push('ainda não quitou nenhuma parcela — sem histórico para avaliar');
  }
  if (!motivos.length) motivos.push('sem atraso em aberto e com bom histórico de pagamento');

  return {
    nivel,
    label: { baixo: 'Risco baixo', medio: 'Risco médio', alto: 'Risco alto', novo: 'Sem histórico' }[nivel],
    cor: { baixo: 'var(--good)', medio: 'var(--warn)', alto: 'var(--bad)', novo: 'var(--ink-soft)' }[nivel],
    badge: { baixo: 'badge-good', medio: 'badge-warn', alto: 'badge-bad', novo: 'badge-purple' }[nivel],
    motivos,
    pontualidade,
  };
}

async function renderClienteScoreDetalheGerente(clientId) {
  const root = document.getElementById('screen-gerente-score');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const [{ data: client }, analyticsRes, historyRes, seriesRes] = await Promise.all([
    supa.from('clients').select('*, profiles!clients_profile_id_fkey(full_name, cpf, phone, email)').eq('profile_id', clientId).maybeSingle(),
    supa.rpc('client_analytics', { p_client_id: clientId }),
    supa.rpc('client_loan_history', { p_client_id: clientId }),
    supa.rpc('client_payment_series', { p_client_id: clientId, p_months: 12 }),
  ]);

  if (!client) { root.innerHTML = `<div class="card"><p class="auth-error">Cliente não encontrado.</p></div>`; return; }
  // A ficha inteira depende das funções da migration_054 — sem elas a tela não
  // tem o que mostrar, e dizer "o que fazer" é mais útil que um erro genérico.
  if (isMissingRpcError(analyticsRes.error)) {
    root.innerHTML = `<button class="btn btn-ghost btn-sm" id="back-to-ranking">${Icons.chevronLeft} Voltar ao ranking</button>
      ${missingMigrationHtml('as funções de análise do cliente (client_analytics)').replace('migration_048', 'migration_054').replace('migration_048.sql', 'migration_054.sql')}`;
    document.getElementById('back-to-ranking').onclick = () => renderGerenteScore();
    return;
  }
  if (analyticsRes.error) {
    root.innerHTML = `<div class="card"><p class="auth-error">${escapeHtml(analyticsRes.error.message)}</p></div>`;
    return;
  }

  const a = analyticsRes.data || {};
  const history = historyRes.data || [];
  const serie = (seriesRes.data || []).map((r) => ({ label: formatDate(r.mes).slice(0, 5), value: Number(r.lucro || 0) }));
  const serieRecebido = (seriesRes.data || []).map((r) => ({ label: formatDate(r.mes).slice(0, 5), value: Number(r.recebido || 0) }));
  const p = client.profiles || {};
  const risco = clientRiskAssessment(a, client.score);
  const pct = (n, d) => (d ? Math.round((Number(n) / Number(d)) * 100) : 0);

  const kpi = (label, valor, hint, cor) => `
    <div class="card stat-card">
      <div class="label">${label}</div>
      <div class="value mono"${cor ? ` style="color:${cor}"` : ''}>${valor}</div>
      ${hint ? `<div class="hint">${hint}</div>` : ''}
    </div>`;

  const linha = (label, valor, cor) => `
    <div class="flex justify-between text-sm" style="padding:7px 0;border-bottom:1px solid var(--line)">
      <span class="text-soft">${label}</span><span class="mono"${cor ? ` style="color:${cor};font-weight:700"` : ''}>${valor}</span>
    </div>`;

  root.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="back-to-ranking">${Icons.chevronLeft} Voltar ao ranking</button>

    <div class="card card-hero mt-14" style="background:var(--hero-dark);color:#fff;padding:22px 24px;border-radius:20px">
      <div class="flex justify-between items-start" style="gap:20px;flex-wrap:wrap">
        <div style="min-width:0">
          <h3 style="color:#fff;margin:0">${escapeHtml(p.full_name || 'Cliente')}</h3>
          <div class="text-sm" style="opacity:.75;margin-top:4px">
            ${escapeHtml(formatCpf(p.cpf || '') || 'CPF não informado')}${p.phone ? ' · ' + escapeHtml(formatPhoneBR(p.phone)) : ''}
          </div>
          <div class="flex items-center gap-8 mt-8" style="flex-wrap:wrap">
            <span class="mono" style="font-size:30px;font-weight:800;line-height:1">${client.score}</span>
            ${scoreTierBadge(client.score_tier)}
            <span class="badge ${risco.badge}">${risco.label}</span>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;opacity:.65">Lucro gerado por este cliente</div>
          <div class="mono" style="font-size:26px;font-weight:800;margin-top:4px">${formatMoney(a.lucro_liquido)}</div>
          <button class="btn btn-sm mt-8" id="recalc-one" style="background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.2)">${Icons.renew} Recalcular score</button>
        </div>
      </div>
      <div class="text-sm" style="margin-top:12px;opacity:.85;border-top:1px solid rgba(255,255,255,.2);padding-top:9px">
        ${escapeHtml(risco.motivos.join(' · '))}
      </div>
    </div>

    <div class="grid grid-4 mt-14">
      ${kpi('Empréstimos', a.contratos_total, `${a.contratos_em_aberto} em aberto · ${a.contratos_quitados} quitados`)}
      ${kpi('Já tomou emprestado', formatMoney(a.total_emprestado), `Ticket médio ${formatMoney(a.ticket_medio)}`)}
      ${kpi('Já me pagou', formatMoney(a.total_recebido), `${formatMoney(a.juros_pagos)} foram juros`)}
      ${kpi('Deve hoje', formatMoney(a.saldo_em_aberto), Number(a.capital_em_risco) > 0 ? `${formatMoney(a.capital_em_risco)} em atraso` : 'nada em atraso', Number(a.capital_em_risco) > 0 ? 'var(--bad)' : null)}
    </div>

    <div class="grid grid-2 mt-14">
      <div class="card">
        <h3>Pontualidade</h3>
        <p class="text-sm text-soft mt-8">Como ele se comporta quando a parcela vence.</p>
        <div class="grid grid-3 kpi-grid-3 mt-14">
          ${kpi('Paga em dia', (risco.pontualidade === null ? '—' : pct(a.parcelas_em_dia, a.parcelas_pagas) + '%'), `${a.parcelas_em_dia} de ${a.parcelas_pagas} parcelas`, risco.pontualidade !== null && risco.pontualidade >= 85 ? 'var(--good)' : (risco.pontualidade !== null && risco.pontualidade < 60 ? 'var(--bad)' : null))}
          ${kpi('Atraso médio', Number(a.atraso_medio_dias) > 0 ? formatNumber(a.atraso_medio_dias, 1) + 'd' : '—', 'quando atrasa')}
          ${kpi('Pior atraso', Number(a.atraso_maximo_dias) > 0 ? a.atraso_maximo_dias + 'd' : '—', 'histórico')}
        </div>
        <div class="mt-14">
          ${linha('Parcelas quitadas', a.parcelas_pagas)}
          ${linha('Quitadas com atraso', a.parcelas_atrasadas_pagas, Number(a.parcelas_atrasadas_pagas) > 0 ? 'var(--warn)' : null)}
          ${linha('Em aberto (a vencer)', a.parcelas_em_aberto)}
          ${linha('Vencidas agora', a.parcelas_vencidas, Number(a.parcelas_vencidas) > 0 ? 'var(--bad)' : null)}
          ${linha('Reconhecidas como perda', a.parcelas_perda, Number(a.parcelas_perda) > 0 ? 'var(--bad)' : null)}
        </div>
      </div>

      <div class="card">
        <h3>Retorno financeiro</h3>
        <p class="text-sm text-soft mt-8">Quanto este cliente já rendeu, líquido de taxas.</p>
        <div class="mt-14">
          ${linha('Lucro líquido gerado', formatMoney(a.lucro_liquido), Number(a.lucro_liquido) >= 0 ? 'var(--good)' : 'var(--bad)')}
          ${linha('Juros pagos', formatMoney(a.juros_pagos))}
          ${linha('Encargos de atraso pagos', formatMoney(a.encargos_atraso_pagos))}
          ${linha('Taxas operacionais cobradas', formatMoney(a.taxas_cobradas))}
          ${linha('Prejuízo reconhecido', formatMoney(a.prejuizo_reconhecido), Number(a.prejuizo_reconhecido) > 0 ? 'var(--bad)' : null)}
          ${linha('Renovações', a.renovacoes)}
          ${linha('Prorrogações', a.prorrogacoes)}
          ${linha('Lucro com renovações/prorrogações', formatMoney(a.lucro_renovacoes))}
        </div>
      </div>
    </div>

    <div class="card mt-14">
      <h3>Lucro gerado nos últimos 12 meses</h3>
      ${serie.some((x) => x.value !== 0)
        ? areaChart(serie, { color: CHART_COLORS.good, caption: 'Lucro por mês com este cliente', ...chartSize(1180, 240, 320, 200, 820, 220) })
        : `<p class="text-soft text-sm mt-8">Nenhum pagamento deste cliente nos últimos 12 meses.</p>`}
    </div>

    <div class="card mt-14">
      <h3>Valor recebido nos últimos 12 meses</h3>
      ${serieRecebido.some((x) => x.value !== 0)
        ? barChart(serieRecebido, { color: CHART_COLORS.accent, caption: 'Recebido por mês deste cliente', ...chartSize(1180, 240, 320, 200, 820, 220) })
        : `<p class="text-soft text-sm mt-8">Nenhum recebimento nos últimos 12 meses.</p>`}
    </div>

    <div class="card mt-14">
      <h3>Histórico de empréstimos</h3>
      <p class="text-sm text-soft mt-8">${history.length} contrato${history.length === 1 ? '' : 's'} — do mais recente para o mais antigo.</p>
      ${history.length ? `
      <table class="data-table table-scroll mt-8">
        <thead><tr><th>Contrato</th><th>Data</th><th>Valor</th><th>Parcelas</th><th>Recebido</th><th>Lucro</th><th>Em aberto</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${history.map((h) => `
            <tr>
              <td data-label="Contrato" class="mono">#${h.contract_number}</td>
              <td data-label="Data">${formatDate(h.contract_date)}</td>
              <td data-label="Valor" class="mono">${formatMoney(h.principal_amount)}</td>
              <td data-label="Parcelas">${h.installments_count}x ${dueTypeLabel(h.due_type)}${Number(h.renovacoes) ? ` · ${h.renovacoes} renov.` : ''}</td>
              <td data-label="Recebido" class="mono">${formatMoney(h.total_recebido)}</td>
              <td data-label="Lucro" class="mono" style="color:${Number(h.lucro) >= 0 ? 'var(--good)' : 'var(--bad)'}">${formatMoney(h.lucro)}</td>
              <td data-label="Em aberto" class="mono">${Number(h.saldo_aberto) > 0 ? formatMoney(h.saldo_aberto) : '—'}</td>
              <td data-label="Status">${statusBadge(h.status, { em_aberto: 'Em aberto', atrasado: 'Atrasado', quitado: 'Quitado', perda: 'Perda' }[h.status] || h.status)}</td>
              <td data-label=""><a href="#/gerente/contratos/${h.contract_id}" class="reference-link">Abrir ${Icons.chevronRight}</a></td>
            </tr>`).join('')}
        </tbody>
      </table>` : `<p class="text-soft text-sm mt-8">Este cliente ainda não tem nenhum empréstimo.</p>`}
    </div>

    <div class="grid grid-2 mt-14">
      <div class="card">
        <h3>Perfil</h3>
        <div class="mt-14">
          ${linha('E-mail', escapeHtml(p.email || '—'))}
          ${linha('Telefone', escapeHtml(p.phone ? formatPhoneBR(p.phone) : '—'))}
          ${linha('Empresa', escapeHtml(client.company || '—'))}
          ${linha('Cargo', escapeHtml(client.job_title || '—'))}
          ${linha('Renda declarada', escapeHtml(client.salary || '—'))}
          ${linha('Grupo', escapeHtml(client.client_group || '—'))}
          ${linha('Limite de crédito', formatMoney(client.credit_limit))}
          ${linha('Cliente desde', client.created_at ? formatDate(client.created_at) : '—')}
          ${linha('Clientes que indicou', a.indicados)}
        </div>
      </div>
      <div class="card">
        <h3>Relacionamento</h3>
        <div class="mt-14">
          ${linha('Primeiro empréstimo', a.primeiro_contrato ? formatDate(a.primeiro_contrato) : '—')}
          ${linha('Último empréstimo', a.ultimo_contrato ? formatDate(a.ultimo_contrato) : '—')}
          ${linha('Último acesso ao sistema', a.ultimo_acesso ? formatDateTime(a.ultimo_acesso) : 'nunca acessou')}
          ${linha('Acessos registrados', a.acessos_registrados)}
          ${linha('Score atualizado em', client.score_updated_at ? formatDateTime(client.score_updated_at) : '—')}
        </div>
        <p class="text-sm text-soft mt-14">
          A trilha de auditoria guarda os 500 eventos mais recentes do sistema inteiro,
          então "acessos registrados" conta só os logins que ainda estão nessa janela —
          não é o total histórico deste cliente.
        </p>
        ${client.notes ? `<div class="mt-14"><div class="form-section-title">Observações</div><p class="text-sm wrap-text">${escapeHtml(client.notes)}</p></div>` : ''}
      </div>
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

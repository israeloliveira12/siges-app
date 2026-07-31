/* ============================================================================
   Gerente — Cobrar: vencimentos de hoje e atrasados
   ============================================================================ */

// Módulo-level (sobrevive a repaints) — qual aba da lista única está ativa.
// Substituiu as duas seções fixas ("Vence hoje"/"Atrasados" empilhadas) por
// uma lista só com abas em pílula, fechando a lacuna do mockup aprovado
// (2026-07-28) — o gerente ainda enxerga os dois grupos, só que como filtro
// da mesma lista, não duas tabelas separadas.
let cobrarTab = 'todos';

function formatDateShortYear(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

function buildWhatsappUrl(item) {
  const p = ((item.contract || {}).clients || {}).profiles || {};
  const phoneDigits = String(p.phone || '').replace(/\D/g, '');
  if (!phoneDigits) return null;
  const withCountry = phoneDigits.startsWith('55') ? phoneDigits : '55' + phoneDigits;

  const parcelaLabel = item.type === 'installment'
    ? `${item.seq} de ${(item.contract || {}).installments_count || '?'}`
    : String(item.seq);

  // Mesma fórmula sugerida no modal de recebimento (juros compostos diários
  // + multa fixa) — só uma sugestão pro texto de cobrança, o valor final
  // cobrado continua sendo ajustável pelo gerente na hora de receber.
  const today = todayISO();
  const diasAtraso = item.due_date < today ? daysBetween(item.due_date, today) : 0;
  const lateInterestPercent = Number((item.contract || {}).late_interest_percent || 0);
  const lateFeePercent = Number((item.contract || {}).late_fee_percent || 0);
  const jurosAtraso = diasAtraso > 0 ? Math.round(item.amount * (Math.pow(1 + lateInterestPercent / 100, diasAtraso) - 1) * 100) / 100 : 0;
  const multaAtraso = diasAtraso > 0 ? Math.round(item.amount * (lateFeePercent / 100) * 100) / 100 : 0;
  const encargoAtraso = jurosAtraso + multaAtraso;
  const valorAtualizado = item.amount + encargoAtraso;

  // Valor de renovação: mesma regra de disponibilidade do modal de
  // recebimento (openReceberModal) — só contratos de parcela única com
  // renovação permitida. É só o juros da parcela/ciclo (interestPortion),
  // + o mesmo encargo de atraso já sugerido acima quando em atraso — o
  // cliente informado paga isso pra "rolar" o vencimento em vez de quitar.
  const contract = item.contract || {};
  const canRenew = contract.allows_renewal && Number(contract.installments_count) === 1;
  const interestPortion = item.type === 'installment'
    ? (Number((item.raw || {}).interest_share || 0) - Number((item.raw || {}).interest_paid_partial || 0))
    : (Number((item.raw || {}).full_debt_amount || 0) - Number(contract.principal_amount || 0));
  const valorRenovacao = interestPortion + encargoAtraso;

  const atencao = diasAtraso > 0
    ? `Efetue o pagamento da sua parcela atrasada (${diasAtraso} dia${diasAtraso > 1 ? 's' : ''} de atraso)`
    : 'Sua parcela vence hoje — efetue o pagamento para evitar atraso';

  // IMPORTANTE: linhas de espaçamento intencionais são string vazia (''),
  // linhas CONDICIONAIS que devem sumir são `null` — nunca usar '' pras
  // duas coisas ao mesmo tempo. Um bug antigo usava `.filter(Boolean)`, que
  // remove '' também, e sem querer engolia os parágrafos em branco pedidos
  // pelo usuário (o texto saía tudo grudado, sem separação visual).
  const texto = [
    '*Lembrete de Pagamento*',
    '',
    `*Cliente:* ${p.full_name || ''}`,
    `*Contrato:* ${(item.contract || {}).contract_number || ''}`,
    `*Parcela* ${parcelaLabel}`,
    `*Valor da Parcela:* ${formatMoney(item.amount)}`,
    diasAtraso > 0 && encargoAtraso > 0 ? `*Juros + multa por atraso:* ${formatMoney(encargoAtraso)}` : null,
    diasAtraso > 0 && encargoAtraso > 0 ? `*Valor atualizado a pagar:* ${formatMoney(valorAtualizado)}` : null,
    canRenew ? `*Valor para renovar (só juros):* ${formatMoney(valorRenovacao)}` : null,
    `*Data Vencimento:* ${formatDateShortYear(item.due_date)}`,
    `*Chave Pix:* ${(App.settings && App.settings.company_pix_key) || '—'}`,
    '',
    `*Atenção:* ${atencao}`,
  ].filter((linha) => linha !== null).join('\n');

  return `https://wa.me/${withCountry}?text=${encodeURIComponent(texto)}`;
}

async function renderGerenteCobrar() {
  const root = document.getElementById('screen-gerente-cobrar');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const today = todayISO();
  const monthStart = today.slice(0, 7) + '-01';

  const [
    { data: paymentsToday, error: e1 }, { data: paymentsMonth, error: e2 },
    { data: dueInstallments, error: e3 }, { data: dueCycles, error: e4 },
  ] = await Promise.all([
    supa.from('payments').select('amount_received').gte('received_at', today),
    supa.from('payments').select('amount_received').gte('received_at', monthStart),
    supa.from('installments').select('*, loan_contracts!installments_contract_id_fkey(id, contract_number, allows_renewal, installments_count, client_id, late_fee_percent, late_interest_percent, has_operational_fee, operational_fee_amount, clients!loan_contracts_client_id_fkey(profiles!clients_profile_id_fkey(full_name, phone, cpf)))').in('status', ['pendente', 'atrasada']),
    supa.from('renewal_cycles').select('*, loan_contracts!renewal_cycles_contract_id_fkey(id, contract_number, allows_renewal, installments_count, principal_amount, client_id, late_fee_percent, late_interest_percent, has_operational_fee, operational_fee_amount, clients!loan_contracts_client_id_fkey(profiles!clients_profile_id_fkey(full_name, phone, cpf)))').in('status', ['pendente', 'atrasada']),
  ]);

  if (e1 || e2 || e3 || e4) {
    console.error('Erro ao carregar dados de cobrança:', e1 || e2 || e3 || e4);
    root.innerHTML = `<div class="card"><p class="auth-error">Não foi possível carregar os vencimentos agora. Recarregue a página ou tente novamente em instantes.</p></div>`;
    return;
  }

  paintCobrar(root, { paymentsToday: paymentsToday || [], paymentsMonth: paymentsMonth || [], dueInstallments: dueInstallments || [], dueCycles: dueCycles || [] });
}

// Repintura pura (sem refetch) — usada pelas abas Tudo/Vence hoje/Atrasados,
// que só mudam qual fatia da lista já carregada é exibida. Antes cada clique
// de aba chamava renderGerenteCobrar() inteiro de novo (refetch completo),
// dando a impressão de um F5 na tela a cada troca — bug real corrigido
// (2026-07-30), mesmo padrão já usado em paintGerenteScore/paintPlanejamento.
function paintCobrar(root, state) {
  const { paymentsToday, paymentsMonth, dueInstallments, dueCycles } = state;
  const today = todayISO();
  const sum = (rows, f) => (rows || []).reduce((s, r) => s + Number(r[f] || 0), 0);

  const items = [
    ...(dueInstallments || []).map((i) => ({
      type: 'installment', id: i.id, due_date: i.due_date,
      // Saldo remanescente real (valor cheio menos o que já foi pago
      // parcialmente) — usar amount_due bruto infla a dívida exibida e a
      // cobrança de juros/multa calculada em buildWhatsappUrl().
      amount: Number(i.amount_due) - Number(i.principal_paid_partial || 0) - Number(i.interest_paid_partial || 0),
      status: i.status, contract: i.loan_contracts, seq: i.sequence_number, raw: i,
    })),
    ...(dueCycles || []).map((c) => ({
      type: 'renewal_cycle', id: c.id, due_date: c.new_due_date, amount: Number(c.full_debt_amount), status: c.status,
      contract: c.loan_contracts, seq: 'Renovação ' + c.cycle_number, raw: c,
    })),
  ];

  const vencidosHoje = items.filter((i) => i.due_date === today);
  // Compara due_date direto (não confia só na coluna status) — o cron que
  // marca status='atrasada' roda 1x/dia, então uma parcela vencida há poucas
  // horas ainda pode estar com status 'pendente' até o próximo ciclo do cron.
  const atrasados = items.filter((i) => i.due_date < today).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const dividaTotal = sum(atrasados, 'amount');

  function rowHtml(i) {
    const p = ((i.contract || {}).clients || {}).profiles || {};
    const waUrl = buildWhatsappUrl(i);
    const late = estimateLateCharge(i.amount, i.due_date, Number((i.contract || {}).late_interest_percent || 0), Number((i.contract || {}).late_fee_percent || 0));
    const encargo = late.jurosAtraso + late.multaAtraso;
    const isOverdue = i.due_date < today;
    return `
      <div class="extrato-row">
        <span class="row-dot" style="background:${isOverdue ? 'var(--bad)' : 'var(--brand)'}">${isOverdue ? '!' : '↓'}</span>
        <div style="min-width:0">
          <div class="name">${escapeHtml(p.full_name || '—')}</div>
          <div class="meta">${escapeHtml(formatCpf(p.cpf || '') || '')} · ${i.seq} · vence ${formatDate(i.due_date)}</div>
          <a href="#/gerente/contratos/${(i.contract || {}).id}" class="tag">#${(i.contract || {}).contract_number}</a>
        </div>
        <div class="amt-wrap">
          <div class="amt">${formatMoney(i.amount)}</div>
          ${encargo > 0 ? `<div class="text-sm mono" style="color:var(--bad)">Com atraso (${late.diasAtraso}d): ${formatMoney(late.total)}</div>` : ''}
          <div class="flex gap-8 mt-8" style="justify-content:flex-end">
            <button class="btn btn-accent btn-sm cobrar-item-btn" data-type="${i.type}" data-id="${i.id}">Receber</button>
            ${waUrl ? `<a class="btn btn-outline btn-sm" href="${waUrl}" target="_blank" rel="noopener" title="Cobrar via WhatsApp">${Icons.alarm} WhatsApp</a>` : ''}
          </div>
        </div>
      </div>`;
  }

  function listBlock(list, emptyMsg) {
    if (!list.length) return `<div class="empty-state">${Icons.check}<p>${emptyMsg}</p></div>`;
    return list.map(rowHtml).join('');
  }

  // Lista única (todos os itens, atrasados primeiro por vencimento) filtrada
  // pela aba ativa — mesmo conjunto de dados que antes, só que numa lista só
  // em vez de duas tabelas empilhadas.
  const todosOrdenados = [...atrasados, ...vencidosHoje];
  const listaAtiva = cobrarTab === 'hoje' ? vencidosHoje : cobrarTab === 'atrasados' ? atrasados : todosOrdenados;
  const emptyMsg = cobrarTab === 'hoje' ? 'Nenhum vencimento hoje.' : cobrarTab === 'atrasados' ? 'Nenhum contrato em atraso.' : 'Nenhuma cobrança em aberto.';

  root.innerHTML = `
    <div class="grid grid-4 kpi-grid-4">
      <div class="card stat-card"><div class="label">Recebido hoje</div><div class="value mono">${formatMoney(sum(paymentsToday, 'amount_received'))}</div></div>
      <div class="card stat-card"><div class="label">Recebido no mês</div><div class="value mono">${formatMoney(sum(paymentsMonth, 'amount_received'))}</div></div>
      <div class="card stat-card"><div class="label">Vence hoje</div><div class="value mono">${vencidosHoje.length}</div></div>
      <div class="card stat-card"><div class="label">Total em atraso</div><div class="value mono" style="color:var(--bad)">${formatMoney(dividaTotal)}</div></div>
    </div>

    <div class="card mt-14">
      <div class="auth-tabs" style="max-width:360px">
        <button class="auth-tab ${cobrarTab === 'todos' ? 'active' : ''}" id="cobrar-tab-todos">Tudo (${todosOrdenados.length})</button>
        <button class="auth-tab ${cobrarTab === 'hoje' ? 'active' : ''}" id="cobrar-tab-hoje">Vence hoje (${vencidosHoje.length})</button>
        <button class="auth-tab ${cobrarTab === 'atrasados' ? 'active' : ''}" id="cobrar-tab-atrasados">Atrasados (${atrasados.length})</button>
      </div>
      <div class="mt-14">${listBlock(listaAtiva, emptyMsg)}</div>
    </div>
  `;

  document.getElementById('cobrar-tab-todos').onclick = () => { cobrarTab = 'todos'; paintCobrar(root, state); };
  document.getElementById('cobrar-tab-hoje').onclick = () => { cobrarTab = 'hoje'; paintCobrar(root, state); };
  document.getElementById('cobrar-tab-atrasados').onclick = () => { cobrarTab = 'atrasados'; paintCobrar(root, state); };

  root.querySelectorAll('.cobrar-item-btn').forEach((btn) => {
    btn.onclick = () => {
      const list = btn.dataset.type === 'installment' ? dueInstallments : dueCycles;
      const raw = (list || []).find((x) => x.id === btn.dataset.id);
      const contract = raw.loan_contracts;
      openReceberModal({ sourceType: btn.dataset.type, id: raw.id, contract }, renderGerenteCobrar);
    };
  });
}

registerRoute('gerente/cobrar', { role: 'gerente', screenId: 'gerente-cobrar', title: 'Cobrar', render: renderGerenteCobrar });

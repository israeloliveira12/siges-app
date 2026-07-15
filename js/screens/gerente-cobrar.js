/* ============================================================================
   Gerente — Cobrar: vencimentos de hoje e atrasados
   ============================================================================ */

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
    supa.from('installments').select('*, loan_contracts!installments_contract_id_fkey(contract_number, allows_renewal, installments_count, client_id, late_fee_percent, late_interest_percent, has_operational_fee, operational_fee_amount, clients!loan_contracts_client_id_fkey(profiles!clients_profile_id_fkey(full_name, phone)))').in('status', ['pendente', 'atrasada']),
    supa.from('renewal_cycles').select('*, loan_contracts!renewal_cycles_contract_id_fkey(contract_number, allows_renewal, installments_count, principal_amount, client_id, late_fee_percent, late_interest_percent, has_operational_fee, operational_fee_amount, clients!loan_contracts_client_id_fkey(profiles!clients_profile_id_fkey(full_name, phone)))').in('status', ['pendente', 'atrasada']),
  ]);

  if (e1 || e2 || e3 || e4) {
    console.error('Erro ao carregar dados de cobrança:', e1 || e2 || e3 || e4);
    root.innerHTML = `<div class="card"><p class="auth-error">Não foi possível carregar os vencimentos agora. Recarregue a página ou tente novamente em instantes.</p></div>`;
    return;
  }

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

  function listBlock(list, emptyMsg) {
    if (!list.length) return `<div class="empty-state">${Icons.check}<p>${emptyMsg}</p></div>`;
    return `
      <table class="data-table table-scroll">
        <thead><tr><th>Cliente</th><th>Contrato</th><th>Vencimento</th><th>Valor</th><th></th></tr></thead>
        <tbody>
          ${list.map((i) => {
            const p = ((i.contract || {}).clients || {}).profiles || {};
            const waUrl = buildWhatsappUrl(i);
            const late = estimateLateCharge(i.amount, i.due_date, Number((i.contract || {}).late_interest_percent || 0), Number((i.contract || {}).late_fee_percent || 0));
            const encargo = late.jurosAtraso + late.multaAtraso;
            return `
            <tr>
              <td data-label="Cliente"><div>${escapeHtml(p.full_name || '—')}<div class="text-sm text-soft">${escapeHtml(p.phone || '')}</div></div></td>
              <td data-label="Contrato">#${(i.contract || {}).contract_number} · ${i.seq}</td>
              <td data-label="Vencimento">${formatDate(i.due_date)}</td>
              <td data-label="Valor"><div class="mono">${formatMoney(i.amount)}</div>${encargo > 0 ? `<div class="text-sm mono" style="color:var(--bad)">Com atraso (${late.diasAtraso}d): ${formatMoney(late.total)}</div>` : ''}</td>
              <td data-label="">
                <div class="flex gap-8">
                  <button class="btn btn-accent btn-sm cobrar-item-btn" data-type="${i.type}" data-id="${i.id}">Receber</button>
                  ${waUrl ? `<a class="btn btn-outline btn-sm" href="${waUrl}" target="_blank" rel="noopener" title="Cobrar via WhatsApp">${Icons.alarm} WhatsApp</a>` : ''}
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  root.innerHTML = `
    <div class="grid grid-4">
      <div class="card stat-card"><div class="label">Recebido hoje</div><div class="value mono">${formatMoney(sum(paymentsToday, 'amount_received'))}</div></div>
      <div class="card stat-card"><div class="label">Recebido no mês</div><div class="value mono">${formatMoney(sum(paymentsMonth, 'amount_received'))}</div></div>
      <div class="card stat-card"><div class="label">Vence hoje</div><div class="value mono">${vencidosHoje.length}</div></div>
      <div class="card stat-card"><div class="label">Total em atraso</div><div class="value mono" style="color:var(--bad)">${formatMoney(dividaTotal)}</div></div>
    </div>

    <div class="card mt-14">
      <h3>Vence hoje (${vencidosHoje.length})</h3>
      <div class="mt-8">${listBlock(vencidosHoje, 'Nenhum vencimento hoje.')}</div>
    </div>

    <div class="card mt-14" style="border-color:var(--bad)">
      <h3 style="color:var(--bad)">Atrasados (${atrasados.length}) — total ${formatMoney(dividaTotal)}</h3>
      <div class="mt-8">${listBlock(atrasados, 'Nenhum contrato em atraso.')}</div>
    </div>
  `;

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

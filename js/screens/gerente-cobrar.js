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

  const atencao = item.status === 'atrasada'
    ? 'Efetue o pagamento da sua parcela atrasada'
    : 'Sua parcela vence hoje — efetue o pagamento para evitar atraso';

  const texto = [
    '*Cobrança de Pagamento*',
    '',
    `*Empresa:* ${(App.settings && App.settings.company_name) || 'Siges Serviços Financeiros'}`,
    `*Cliente:* ${p.full_name || ''}`,
    `*Contrato:* ${(item.contract || {}).contract_number || ''}`,
    `*Parcela* ${parcelaLabel}`,
    `*Valor da Parcela:* ${formatMoney(item.amount)}`,
    `*Data Vencimento:* ${formatDateShortYear(item.due_date)}`,
    `*Chave Pix:* ${(App.settings && App.settings.company_pix_key) || '—'}`,
    '',
    `*Atenção:* ${atencao}`,
  ].join('\n');

  return `https://wa.me/${withCountry}?text=${encodeURIComponent(texto)}`;
}

async function renderGerenteCobrar() {
  const root = document.getElementById('screen-gerente-cobrar');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const today = todayISO();
  const monthStart = today.slice(0, 7) + '-01';

  const [
    { data: paymentsToday }, { data: paymentsMonth },
    { data: dueInstallments }, { data: dueCycles },
  ] = await Promise.all([
    supa.from('payments').select('amount_received').gte('received_at', today),
    supa.from('payments').select('amount_received').gte('received_at', monthStart),
    supa.from('installments').select('*, loan_contracts!installments_contract_id_fkey(contract_number, allows_renewal, installments_count, client_id, late_fee_percent, late_interest_percent, has_operational_fee, operational_fee_amount, clients!loan_contracts_client_id_fkey(profiles!clients_profile_id_fkey(full_name, phone)))').in('status', ['pendente', 'atrasada']),
    supa.from('renewal_cycles').select('*, loan_contracts!renewal_cycles_contract_id_fkey(contract_number, allows_renewal, installments_count, principal_amount, client_id, late_fee_percent, late_interest_percent, has_operational_fee, operational_fee_amount, clients!loan_contracts_client_id_fkey(profiles!clients_profile_id_fkey(full_name, phone)))').in('status', ['pendente', 'atrasada']),
  ]);

  const sum = (rows, f) => (rows || []).reduce((s, r) => s + Number(r[f] || 0), 0);

  const items = [
    ...(dueInstallments || []).map((i) => ({
      type: 'installment', id: i.id, due_date: i.due_date, amount: Number(i.amount_due), status: i.status,
      contract: i.loan_contracts, seq: i.sequence_number, raw: i,
    })),
    ...(dueCycles || []).map((c) => ({
      type: 'renewal_cycle', id: c.id, due_date: c.new_due_date, amount: Number(c.full_debt_amount), status: c.status,
      contract: c.loan_contracts, seq: 'Renovação ' + c.cycle_number, raw: c,
    })),
  ];

  const vencidosHoje = items.filter((i) => i.due_date === today);
  const atrasados = items.filter((i) => i.status === 'atrasada').sort((a, b) => a.due_date.localeCompare(b.due_date));
  const dividaTotal = sum(items, 'amount');

  function listBlock(list, emptyMsg) {
    if (!list.length) return `<div class="empty-state">${Icons.check}<p>${emptyMsg}</p></div>`;
    return `
      <table class="data-table table-scroll">
        <thead><tr><th>Cliente</th><th>Contrato</th><th>Vencimento</th><th>Valor</th><th></th></tr></thead>
        <tbody>
          ${list.map((i) => {
            const p = ((i.contract || {}).clients || {}).profiles || {};
            const waUrl = buildWhatsappUrl(i);
            return `
            <tr>
              <td data-label="Cliente"><div>${escapeHtml(p.full_name || '—')}<div class="text-sm text-soft">${escapeHtml(p.phone || '')}</div></div></td>
              <td data-label="Contrato">#${(i.contract || {}).contract_number} · ${i.seq}</td>
              <td data-label="Vencimento">${formatDate(i.due_date)}</td>
              <td data-label="Valor" class="mono">${formatMoney(i.amount)}</td>
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
      <div class="card stat-card"><div class="label">Vencidos hoje</div><div class="value mono">${vencidosHoje.length}</div></div>
      <div class="card stat-card"><div class="label">Total em atraso</div><div class="value mono" style="color:var(--bad)">${formatMoney(sum(atrasados, 'amount'))}</div></div>
    </div>

    <div class="card mt-14">
      <h3>Vencidos hoje (${vencidosHoje.length})</h3>
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

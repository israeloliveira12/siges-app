/* ============================================================================
   Gerente — Lista de contratos (Em aberto / Finalizados) + detalhe do contrato
   ============================================================================ */

let contratosTab = 'aberto';
let contratosSearch = '';

async function renderGerenteContratosLista() {
  const root = document.getElementById('screen-gerente-contratos');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const statuses = contratosTab === 'aberto' ? ['em_aberto', 'atrasado'] : ['quitado', 'perda'];
  const { data, error } = await supa
    .from('loan_contracts')
    .select('*, clients!loan_contracts_client_id_fkey(profile_id, profiles!clients_profile_id_fkey(full_name, cpf))')
    .in('status', statuses)
    .order('created_at', { ascending: false });

  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }

  const contractIds = (data || []).map((c) => c.id);
  let paymentsByContract = {};
  let outstandingByContract = {};
  if (contractIds.length) {
    const { data: payments } = await supa.from('payments').select('contract_id, amount_received, interest_component').in('contract_id', contractIds);
    (payments || []).forEach((p) => {
      paymentsByContract[p.contract_id] = paymentsByContract[p.contract_id] || { total: 0, interest: 0 };
      paymentsByContract[p.contract_id].total += Number(p.amount_received);
      paymentsByContract[p.contract_id].interest += Number(p.interest_component);
    });
    const { data: openInst } = await supa.from('installments').select('contract_id, amount_due').in('contract_id', contractIds).in('status', ['pendente', 'atrasada']);
    (openInst || []).forEach((i) => { outstandingByContract[i.contract_id] = (outstandingByContract[i.contract_id] || 0) + Number(i.amount_due); });
    const { data: openCycles } = await supa.from('renewal_cycles').select('contract_id, full_debt_amount, cycle_number').in('contract_id', contractIds).in('status', ['pendente', 'atrasada']);
    (openCycles || []).forEach((c) => {
      if (!outstandingByContract['cycle_' + c.contract_id] || c.cycle_number > outstandingByContract['cycle_' + c.contract_id].n) {
        outstandingByContract['cycle_' + c.contract_id] = { n: c.cycle_number, v: Number(c.full_debt_amount) };
      }
    });
  }

  const rows = (data || []).filter((c) => {
    const term = contratosSearch.trim().toLowerCase();
    if (!term) return true;
    const p = (c.clients || {}).profiles || {};
    return (p.full_name || '').toLowerCase().includes(term) || String(c.contract_number).includes(term);
  });

  root.innerHTML = `
    <div class="flex justify-between items-center gap-10" style="flex-wrap:wrap">
      <div class="flex gap-8">
        <button class="btn ${contratosTab === 'aberto' ? 'btn-primary' : 'btn-outline'} btn-sm" id="tab-aberto">Em aberto</button>
        <button class="btn ${contratosTab === 'finalizados' ? 'btn-primary' : 'btn-outline'} btn-sm" id="tab-finalizados">Finalizados</button>
      </div>
      <div class="flex gap-8" style="flex-wrap:wrap">
        <input type="text" id="contratos-search" placeholder="Buscar cliente ou nº contrato" value="${escapeHtml(contratosSearch)}" style="max-width:240px">
        <button class="btn btn-primary" onclick="router.navigate('#/gerente/contratos/novo')">${Icons.plus} Novo Contrato</button>
      </div>
    </div>

    <div class="card mt-14" style="padding:0">
      ${rows.length ? `
      <table class="data-table table-scroll">
        <thead><tr>
          <th>Código</th><th>Cliente</th><th>Aporte</th><th>Dívida atual</th><th>Juros (%)</th><th>Pago total</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.map((c) => {
            const cycleInfo = outstandingByContract['cycle_' + c.id];
            const outstanding = cycleInfo ? cycleInfo.v : (outstandingByContract[c.id] || 0);
            const paid = (paymentsByContract[c.id] || { total: 0 }).total;
            return `
            <tr class="contract-row" data-id="${c.id}" style="cursor:pointer">
              <td data-label="Código">#${c.contract_number}</td>
              <td data-label="Cliente">${escapeHtml((c.clients.profiles || {}).full_name || '—')}</td>
              <td data-label="Aporte" class="mono">${formatMoney(c.principal_amount)}</td>
              <td data-label="Dívida atual" class="mono">${formatMoney(outstanding)}</td>
              <td data-label="Juros">${formatNumber(c.interest_rate, 2)}%</td>
              <td data-label="Pago" class="mono">${formatMoney(paid)}</td>
              <td data-label="Status">${statusBadge(c.status, { em_aberto: 'Em aberto', atrasado: 'Atrasado', quitado: 'Quitado', perda: 'Perda' }[c.status])}</td>
              <td data-label=""><button class="icon-btn view-contract-btn" data-id="${c.id}">${Icons.chevronRight}</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : `<div class="empty-state">${Icons.contract}<p>Nenhum contrato ${contratosTab === 'aberto' ? 'em aberto' : 'finalizado'}.</p></div>`}
    </div>
  `;

  document.getElementById('tab-aberto').onclick = () => { contratosTab = 'aberto'; renderGerenteContratosLista(); };
  document.getElementById('tab-finalizados').onclick = () => { contratosTab = 'finalizados'; renderGerenteContratosLista(); };
  document.getElementById('contratos-search').oninput = debounce((e) => { contratosSearch = e.target.value; renderGerenteContratosLista(); }, 250);
  root.querySelectorAll('.contract-row, .view-contract-btn').forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); router.navigate('#/gerente/contratos/' + (el.dataset.id)); };
  });
}

registerRoute('gerente/contratos', { role: 'gerente', screenId: 'gerente-contratos', title: 'Contratos', render: renderGerenteContratosLista });

// ---------------------------------------------------------------------------
// Detalhe do contrato
// ---------------------------------------------------------------------------

async function renderGerenteContratoDetalhe(params) {
  const root = document.getElementById('screen-gerente-contratos');
  root.innerHTML = `<div class="text-soft">Carregando contrato...</div>`;

  const contractId = params.id;
  const [{ data: contract }, { data: installments }, { data: cycles }, { data: payments }] = await Promise.all([
    supa.from('loan_contracts').select('*, clients!loan_contracts_client_id_fkey(profile_id, credit_limit, profiles!clients_profile_id_fkey(full_name, cpf, phone))').eq('id', contractId).maybeSingle(),
    supa.from('installments').select('*').eq('contract_id', contractId).order('sequence_number'),
    supa.from('renewal_cycles').select('*').eq('contract_id', contractId).order('cycle_number'),
    supa.from('payments').select('*').eq('contract_id', contractId).order('received_at', { ascending: false }),
  ]);

  if (!contract) { root.innerHTML = `<div class="auth-error">Contrato não encontrado.</div>`; return; }

  const p = contract.clients.profiles || {};
  const totalPago = (payments || []).reduce((s, x) => s + Number(x.amount_received), 0);
  const abertas = (installments || []).filter((i) => i.status === 'pendente' || i.status === 'atrasada');
  const pagas = (installments || []).filter((i) => i.status === 'paga');

  root.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="back-to-list">${Icons.chevronLeft} Voltar para contratos</button>

    <div class="card mt-14">
      <div class="flex justify-between items-center" style="flex-wrap:wrap">
        <div>
          <h3>Contrato #${contract.contract_number} — ${escapeHtml(p.full_name || '')}</h3>
          <div class="text-sm text-soft">CPF ${escapeHtml(p.cpf || '—')} · ${escapeHtml(p.phone || '')}</div>
        </div>
        <div class="flex items-center gap-8">
          ${statusBadge(contract.status, { em_aberto: 'Em aberto', atrasado: 'Atrasado', quitado: 'Quitado', perda: 'Perda' }[contract.status])}
          <button class="btn btn-outline btn-sm" id="print-extrato-btn">${Icons.printer} Extrato PDF</button>
        </div>
      </div>
      <div class="grid grid-4 mt-14">
        <div class="stat-card"><div class="label">Aporte</div><div class="value mono">${formatMoney(contract.principal_amount)}</div></div>
        <div class="stat-card"><div class="label">Juros</div><div class="value mono">${formatNumber(contract.interest_rate, 2)}%</div></div>
        <div class="stat-card"><div class="label">Pago total</div><div class="value mono">${formatMoney(totalPago)}</div></div>
        <div class="stat-card"><div class="label">Líquido desembolsado</div><div class="value mono">${formatMoney(contract.net_disbursed_amount)}</div></div>
      </div>
      ${contract.observations ? `<p class="text-sm text-soft mt-14">Obs: ${escapeHtml(contract.observations)}</p>` : ''}
    </div>

    <div class="card mt-14">
      <h3>Parcelas</h3>
      <table class="data-table table-scroll mt-8">
        <thead><tr><th>Nº</th><th>Vencimento</th><th>Capital</th><th>Juros</th><th>Total</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${(installments || []).map((i) => `
            <tr>
              <td data-label="Nº">${i.sequence_number}</td>
              <td data-label="Vencimento">${formatDate(i.due_date)}</td>
              <td data-label="Capital" class="mono">${formatMoney(i.principal_share)}</td>
              <td data-label="Juros" class="mono">${formatMoney(i.interest_share)}</td>
              <td data-label="Total" class="mono">${formatMoney(i.amount_due)}</td>
              <td data-label="Status">${statusBadge(i.status, { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada', renovada: 'Renovada', cancelada: 'Cancelada' }[i.status])}</td>
              <td data-label="" class="flex gap-8">
                ${(i.status === 'pendente' || i.status === 'atrasada') ? `<button class="btn btn-accent btn-sm receive-inst-btn" data-id="${i.id}">Receber</button>` : ''}
                <button class="icon-btn print-inst-btn" data-id="${i.id}" title="Imprimir nota promissória">${Icons.printer}</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    ${(cycles || []).length ? `
    <div class="card mt-14">
      <h3>Ciclos de renovação</h3>
      <table class="data-table table-scroll mt-8">
        <thead><tr><th>Ciclo</th><th>Juros pago</th><th>Dívida renovada</th><th>Novo vencimento</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${cycles.map((c) => `
            <tr>
              <td data-label="Ciclo">${c.cycle_number}</td>
              <td data-label="Juros pago" class="mono">${formatMoney(c.interest_only_amount)}</td>
              <td data-label="Dívida renovada" class="mono">${formatMoney(c.full_debt_amount)}</td>
              <td data-label="Novo vencimento">${formatDate(c.new_due_date)}</td>
              <td data-label="Status">${statusBadge(c.status, { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada', renovada: 'Renovada' }[c.status])}</td>
              <td data-label="">${(c.status === 'pendente' || c.status === 'atrasada') ? `<button class="btn btn-accent btn-sm receive-cycle-btn" data-id="${c.id}">Receber</button>` : ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>` : ''}

    <div class="card mt-14">
      <h3>Pagamentos recebidos</h3>
      ${(payments || []).length ? `
      <table class="data-table table-scroll mt-8">
        <thead><tr><th>Data</th><th>Tipo</th><th>Valor</th><th>Lucro líquido</th></tr></thead>
        <tbody>
          ${payments.map((pay) => `
            <tr>
              <td data-label="Data">${formatDateTime(pay.received_at)}</td>
              <td data-label="Tipo">${{ quitacao_parcela: 'Quitação', renovacao_juros: 'Renovação (juros)', quitacao_final: 'Quitação final' }[pay.payment_kind]}</td>
              <td data-label="Valor" class="mono">${formatMoney(pay.amount_received)}</td>
              <td data-label="Lucro líquido" class="mono">${formatMoney(pay.net_profit)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : `<p class="text-sm text-soft mt-8">Nenhum pagamento registrado ainda.</p>`}
    </div>
  `;

  document.getElementById('back-to-list').onclick = () => router.navigate('#/gerente/contratos');

  document.getElementById('print-extrato-btn').onclick = async () => {
    const { data: clientData } = await supa.from('clients').select('score').eq('profile_id', contract.client_id).maybeSingle();
    gerarExtratoPDF({
      contract, installments: installments || [], clientProfile: p,
      score: clientData ? clientData.score : null,
      companyName: (App.settings && App.settings.company_name) || 'Siges Serviços Financeiros',
    });
  };

  root.querySelectorAll('.print-inst-btn').forEach((btn) => {
    btn.onclick = () => {
      const inst = (installments || []).find((i) => i.id === btn.dataset.id);
      gerarPromissoriaPDF({
        contract, installment: inst, clientProfile: p,
        companyName: (App.settings && App.settings.company_name) || 'Siges Serviços Financeiros',
      });
    };
  });

  root.querySelectorAll('.receive-inst-btn').forEach((btn) => {
    btn.onclick = () => openReceberModal({ sourceType: 'installment', id: btn.dataset.id, contract }, () => renderGerenteContratoDetalhe(params));
  });
  root.querySelectorAll('.receive-cycle-btn').forEach((btn) => {
    btn.onclick = () => openReceberModal({ sourceType: 'renewal_cycle', id: btn.dataset.id, contract }, () => renderGerenteContratoDetalhe(params));
  });
}

registerRoute('gerente/contratos/:id', { role: 'gerente', screenId: 'gerente-contratos', title: 'Detalhe do Contrato', render: renderGerenteContratoDetalhe });

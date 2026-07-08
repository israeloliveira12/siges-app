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

  const totalInterestReceived = (payments || []).reduce((s, p) => s + Number(p.interest_component), 0);
  const totalEntryFees = (payments || []).reduce((s, p) => s + Number(p.operational_fee_amount), 0);
  const exitFee = Number(contract.operational_fee_amount || 0);
  const netContractProfit = totalInterestReceived - exitFee - totalEntryFees;

  root.innerHTML = `
    <button class="btn btn-ghost btn-sm" id="back-to-list">${Icons.chevronLeft} Voltar para contratos</button>

    <div class="card mt-14">
      <div class="flex justify-between items-center" style="flex-wrap:wrap">
        <div>
          <h3>Contrato #${contract.contract_number} — ${escapeHtml(p.full_name || '')}</h3>
          <div class="text-sm text-soft">CPF ${escapeHtml(p.cpf || '—')} · ${escapeHtml(p.phone || '')}</div>
        </div>
        <div class="flex items-center gap-8" style="flex-wrap:wrap">
          ${statusBadge(contract.status, { em_aberto: 'Em aberto', atrasado: 'Atrasado', quitado: 'Quitado', perda: 'Perda' }[contract.status])}
          <button class="btn btn-outline btn-sm" id="print-extrato-btn">${Icons.printer} Extrato PDF</button>
          <button class="btn btn-outline btn-sm" id="edit-contract-btn">${Icons.edit} Editar contrato</button>
          <button class="btn btn-outline btn-sm" id="delete-contract-btn" style="color:var(--bad)">${Icons.trash} Excluir contrato</button>
        </div>
      </div>
      <div class="grid grid-4 mt-14">
        <div class="stat-card"><div class="label">Aporte (dívida-base)</div><div class="value mono">${formatMoney(contract.principal_amount)}</div></div>
        <div class="stat-card"><div class="label">Juros</div><div class="value mono">${formatNumber(contract.interest_rate, 2)}%</div></div>
        <div class="stat-card"><div class="label">Pago total</div><div class="value mono">${formatMoney(totalPago)}</div></div>
        <div class="stat-card"><div class="label">Total desembolsado (contrato + taxa)</div><div class="value mono">${formatMoney(contract.total_disbursed_amount)}</div></div>
      </div>
      <div class="grid grid-2 mt-14">
        <div class="stat-card" style="background:var(--brand-soft)">
          <div class="label">Lucro líquido do contrato (juros − taxa de saída − taxas de entrada)</div>
          <div class="value mono" style="font-size:20px">${formatMoney(netContractProfit)}</div>
          <div class="hint">Juros recebidos ${formatMoney(totalInterestReceived)} − taxa de saída ${formatMoney(exitFee)} − taxas de entrada ${formatMoney(totalEntryFees)}</div>
        </div>
      </div>
      ${contract.observations ? `<p class="text-sm text-soft mt-14">Obs: ${escapeHtml(contract.observations)}</p>` : ''}
    </div>

    <div class="card mt-14">
      <div class="flex justify-between items-center">
        <h3>Parcelas</h3>
        <button class="btn btn-outline btn-sm" id="print-promissorias-btn">${Icons.printer} Notas promissórias (PDF)</button>
      </div>
      <table class="data-table table-scroll mt-8">
        <thead><tr><th>Nº</th><th>Vencimento</th><th>Capital</th><th>Juros</th><th>Total</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${(installments || []).map((i) => `
            <tr>
              <td data-label="Nº">${i.sequence_number}</td>
              <td data-label="Vencimento">${formatDate(i.due_date)}</td>
              <td data-label="Capital" class="mono">${formatMoney(i.principal_share)}</td>
              <td data-label="Juros" class="mono">${formatMoney(i.interest_share)}</td>
              <td data-label="Total"><div><div class="mono">${formatMoney(i.amount_due)}</div>${(i.principal_paid_partial > 0 || i.interest_paid_partial > 0) ? `<div class="text-sm text-soft">Pago parcial: ${formatMoney(Number(i.principal_paid_partial) + Number(i.interest_paid_partial))} · resta ${formatMoney(i.amount_due - i.principal_paid_partial - i.interest_paid_partial)}</div>` : ''}</div></td>
              <td data-label="Status">${(() => { const st = effectiveInstallmentStatus(i.status, i.due_date); return statusBadge(st, { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada', renovada: 'Renovada', cancelada: 'Cancelada' }[st]); })()}</td>
              <td data-label="">
                <div class="flex gap-8">
                  ${(i.status === 'pendente' || i.status === 'atrasada') ? `
                    <button class="btn btn-accent btn-sm receive-inst-btn" data-id="${i.id}">Receber</button>
                    <button class="icon-btn edit-inst-btn" data-id="${i.id}" title="Editar/reagendar parcela">${Icons.edit}</button>
                  ` : ''}
                </div>
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
              <td data-label="Status">${(() => { const st = effectiveInstallmentStatus(c.status, c.new_due_date); return statusBadge(st, { pendente: 'Pendente', paga: 'Paga', atrasada: 'Atrasada', renovada: 'Renovada' }[st]); })()}</td>
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
    await gerarExtratoPDF({
      contract, installments: installments || [], clientProfile: p,
      score: clientData ? clientData.score : null,
      companyName: (App.settings && App.settings.company_name) || 'Siges Serviços Financeiros',
    });
  };

  document.getElementById('print-promissorias-btn').onclick = () => {
    gerarNotasPromissoriasPDF({
      contract, installments: installments || [], clientProfile: p,
      companyName: (App.settings && App.settings.company_name) || 'Siges Serviços Financeiros',
    });
  };

  document.getElementById('edit-contract-btn').onclick = () => openEditContratoModal(contract, () => renderGerenteContratoDetalhe(params));
  document.getElementById('delete-contract-btn').onclick = () => openDeleteContratoConfirm(contract);

  root.querySelectorAll('.receive-inst-btn').forEach((btn) => {
    btn.onclick = () => openReceberModal({ sourceType: 'installment', id: btn.dataset.id, contract }, () => renderGerenteContratoDetalhe(params));
  });
  root.querySelectorAll('.edit-inst-btn').forEach((btn) => {
    btn.onclick = () => {
      const inst = (installments || []).find((i) => i.id === btn.dataset.id);
      openEditInstallmentModal(inst, () => renderGerenteContratoDetalhe(params));
    };
  });
  root.querySelectorAll('.receive-cycle-btn').forEach((btn) => {
    btn.onclick = () => openReceberModal({ sourceType: 'renewal_cycle', id: btn.dataset.id, contract }, () => renderGerenteContratoDetalhe(params));
  });
}

function openEditContratoModal(contract, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>Editar contrato #${contract.contract_number}</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="ec-feedback"></div>
        <p class="text-sm text-soft">O valor emprestado e o número de parcelas não podem ser alterados aqui (isso exigiria recalcular todas as parcelas já geradas) — para isso, edite as parcelas individualmente ou exclua e crie um novo contrato.</p>
        <div class="field mt-14"><label>Juros (%) do período contratado</label><input type="number" min="0" step="0.01" id="ec-rate" value="${contract.interest_rate}"></div>
        <div class="toggle-row mt-8"><label class="switch"><input type="checkbox" id="ec-fee-toggle" ${contract.has_operational_fee ? 'checked' : ''}><span class="track"></span></label><span>Aplicar taxa operacional de saída?</span></div>
        <div id="ec-fee-fields" class="mt-8 ${contract.has_operational_fee ? '' : 'hidden'}">
          <div class="field"><label>Valor da taxa de saída (R$)</label><input type="text" id="ec-fee-amount"></div>
        </div>
        <div class="toggle-row mt-14"><label class="switch"><input type="checkbox" id="ec-renewal" ${contract.allows_renewal ? 'checked' : ''}><span class="track"></span></label><span>Permite renovação</span></div>
        <div class="field-row mt-14">
          <div class="field"><label>Multa por atraso (%)</label><input type="number" min="0" step="0.01" id="ec-late-fee" value="${contract.late_fee_percent}"></div>
          <div class="field"><label>Juros por atraso (% ao dia)</label><input type="number" min="0" step="0.01" id="ec-late-interest" value="${contract.late_interest_percent}"></div>
        </div>
        <span class="help">Juros compostos diariamente sobre o saldo em atraso (ex: 2% ao dia) + multa fixa uma vez — ajustável em cada recebimento.</span>
        <div class="field"><label>Observações</label><textarea id="ec-observations">${escapeHtml(contract.observations || '')}</textarea></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-primary" id="save-modal">Salvar alterações</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;

  const feeToggle = document.getElementById('ec-fee-toggle');
  const feeInput = document.getElementById('ec-fee-amount');
  setMoneyValue(feeInput, contract.operational_fee_amount);
  attachMoneyMask(feeInput);
  feeToggle.onchange = () => document.getElementById('ec-fee-fields').classList.toggle('hidden', !feeToggle.checked);

  document.getElementById('save-modal').onclick = async () => {
    const btn = document.getElementById('save-modal');
    btn.disabled = true;
    const { error } = await supa.rpc('update_contract', {
      p_contract_id: contract.id,
      p_interest_rate: Number(document.getElementById('ec-rate').value || 0),
      p_has_operational_fee: feeToggle.checked,
      p_operational_fee_amount: feeToggle.checked ? getMoneyValue(feeInput) : 0,
      p_allows_renewal: document.getElementById('ec-renewal').checked,
      p_late_fee_percent: Number(document.getElementById('ec-late-fee').value || 0),
      p_late_interest_percent: Number(document.getElementById('ec-late-interest').value || 0),
      p_observations: document.getElementById('ec-observations').value.trim() || null,
    });
    if (error) {
      document.getElementById('ec-feedback').innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`;
      btn.disabled = false;
      return;
    }
    close();
    showToast('Contrato atualizado.');
    if (typeof onDone === 'function') onDone();
  };
}

function openDeleteContratoConfirm(contract) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:460px">
      <div class="modal-head"><h3 style="color:var(--bad)">Excluir contrato</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <p class="text-sm">Tem certeza que deseja excluir o contrato <strong>#${contract.contract_number}</strong> permanentemente? Isso apaga todas as parcelas, pagamentos e ciclos de renovação ligados a ele. Essa ação não pode ser desfeita.</p>
        <div id="dc-feedback" class="mt-8"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-danger" id="confirm-delete">Excluir permanentemente</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  document.getElementById('confirm-delete').onclick = async () => {
    const btn = document.getElementById('confirm-delete');
    btn.disabled = true;
    const { error } = await supa.rpc('delete_contract', { p_contract_id: contract.id });
    if (error) {
      document.getElementById('dc-feedback').innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`;
      btn.disabled = false;
      return;
    }
    close();
    showToast('Contrato excluído.');
    router.navigate('#/gerente/contratos');
  };
}

function openEditInstallmentModal(installment, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>Editar/reagendar parcela ${installment.sequence_number}</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="ei-feedback"></div>
        <div class="field"><label>Nova data de vencimento</label><input type="date" id="ei-due-date" value="${installment.due_date}"></div>
        <div class="field-row">
          <div class="field"><label>Capital (R$)</label><input type="text" id="ei-principal"></div>
          <div class="field"><label>Juros (R$)</label><input type="text" id="ei-interest"></div>
        </div>
        <p class="text-sm text-soft">Novo total da parcela: <strong class="mono" id="ei-total-preview">${formatMoney(installment.amount_due)}</strong></p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-primary" id="save-modal">Salvar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;

  const principalInput = document.getElementById('ei-principal');
  const interestInput = document.getElementById('ei-interest');
  setMoneyValue(principalInput, installment.principal_share);
  setMoneyValue(interestInput, installment.interest_share);
  attachMoneyMask(principalInput);
  attachMoneyMask(interestInput);
  const updatePreview = () => {
    document.getElementById('ei-total-preview').textContent = formatMoney(getMoneyValue(principalInput) + getMoneyValue(interestInput));
  };
  principalInput.oninput = updatePreview;
  interestInput.oninput = updatePreview;

  document.getElementById('save-modal').onclick = async () => {
    const btn = document.getElementById('save-modal');
    btn.disabled = true;
    const { error } = await supa.rpc('update_installment_schedule', {
      p_installment_id: installment.id,
      p_due_date: document.getElementById('ei-due-date').value,
      p_principal_share: getMoneyValue(principalInput),
      p_interest_share: getMoneyValue(interestInput),
    });
    if (error) {
      document.getElementById('ei-feedback').innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`;
      btn.disabled = false;
      return;
    }
    close();
    showToast('Parcela atualizada.');
    if (typeof onDone === 'function') onDone();
  };
}

registerRoute('gerente/contratos/:id', { role: 'gerente', screenId: 'gerente-contratos', title: 'Detalhe do Contrato', render: renderGerenteContratoDetalhe });

/* ============================================================================
   Gerente — Novo Contrato (wizard: Cliente > Configuração > Revisão)
   ============================================================================ */

let wiz = null;
let wizClientsList = [];

function freshWizard() {
  return {
    step: 1,
    client_id: null,
    client_name: '',
    client_limit: 0,
    client_used: 0,
    origin_request_id: null,
    principal_amount: '',
    interest_rate: '',
    installments_count: 1,
    due_type: 'mensal',
    contract_date: todayISO(),
    first_installment_date: addDaysISO(todayISO(), 30),
    has_operational_fee: false,
    operational_fee_amount: 0,
    allows_renewal: true,
    late_fee_percent: 0,
    late_interest_percent: 0,
    observations: '',
    installmentsPreview: [],
  };
}

// Sempre busca limite/consumo direto do banco (nunca confia em cache) — evita
// mostrar "Limite disponível" desatualizado se o admin mudou o limite do
// cliente em outra tela nesta mesma sessão.
async function refreshClientLimit(clientId) {
  const { data: freshClient } = await supa.from('clients').select('credit_limit').eq('profile_id', clientId).maybeSingle();
  wiz.client_limit = Number(freshClient ? freshClient.credit_limit : 0);
  const { data } = await supa.rpc('client_outstanding_principal', { p_client_id: clientId });
  wiz.client_used = Number(data) || 0;
}

async function renderGerenteContratoNovo() {
  if (pendingContractPrefill) {
    wiz = freshWizard();
    Object.assign(wiz, pendingContractPrefill);
    wiz.step = 2;
    pendingContractPrefill = null;
    await refreshClientLimit(wiz.client_id);
  } else if (!wiz) {
    wiz = freshWizard();
  }

  if (wiz.step === 1 && !wizClientsList.length) {
    const { data } = await supa.from('clients').select('profile_id, credit_limit, profiles!clients_profile_id_fkey(full_name, email, cpf)').order('created_at', { ascending: false });
    wizClientsList = data || [];
  }

  paintWizard();
}

function paintWizard() {
  const root = document.getElementById('screen-gerente-contrato-novo');
  root.innerHTML = `
    <div class="wizard-steps">
      ${['Cliente', 'Configuração', 'Revisão'].map((label, i) => {
        const n = i + 1;
        const cls = wiz.step === n ? 'active' : wiz.step > n ? 'done' : '';
        return `<div class="wizard-step ${cls}"><div class="dot">${wiz.step > n ? '✓' : n}</div><div>${label}</div></div>`;
      }).join('')}
    </div>
    <div id="wizard-body"></div>
  `;

  if (wiz.step === 1) paintWizardStep1();
  else if (wiz.step === 2) paintWizardStep2();
  else paintWizardStep3();
}

let wizClientSearch = '';
let wizSelectedClientId = null;

function paintWizardStep1() {
  wizSelectedClientId = wiz.client_id || null;
  const body = document.getElementById('wizard-body');
  body.innerHTML = `
    <div class="card">
      <h3>Selecione o cliente</h3>
      <div class="field mt-14">
        <input type="text" id="w-client-search" placeholder="Buscar cliente por nome, e-mail ou CPF..." value="${escapeHtml(wizClientSearch)}">
      </div>
      <div id="w-client-list" style="max-height:320px;overflow-y:auto;border:1px solid var(--line);border-radius:var(--radius-sm)"></div>
      <div class="modal-foot" style="border:none;padding:14px 0 0">
        <button class="btn btn-primary" id="w-next">Próximo ${Icons.chevronRight}</button>
      </div>
    </div>
  `;

  function paintClientList() {
    const term = wizClientSearch.trim().toLowerCase();
    const termDigits = term.replace(/\D/g, '');
    const listEl = document.getElementById('w-client-list');
    if (!term) {
      listEl.innerHTML = `<div class="empty-state" style="padding:20px"><p>Digite para buscar um cliente.</p></div>`;
      return;
    }
    const filtered = wizClientsList.filter((c) => {
      const p = c.profiles || {};
      const nameOrEmailMatch = (p.full_name || '').toLowerCase().includes(term) || (p.email || '').toLowerCase().includes(term);
      const cpfMatch = termDigits && (p.cpf || '').replace(/\D/g, '').includes(termDigits);
      return nameOrEmailMatch || cpfMatch;
    });
    if (!filtered.length) {
      listEl.innerHTML = `<div class="empty-state" style="padding:20px"><p>Nenhum cliente encontrado.</p></div>`;
      return;
    }
    listEl.innerHTML = filtered.map((c) => `
      <div class="w-client-row" data-id="${c.profile_id}" style="padding:10px 14px;border-bottom:1px solid var(--line);cursor:pointer;${wizSelectedClientId === c.profile_id ? 'background:var(--brand-soft)' : ''}">
        <strong>${escapeHtml((c.profiles || {}).full_name || (c.profiles || {}).email)}</strong>
        <div class="text-sm text-soft">${escapeHtml((c.profiles || {}).email || '')} — limite ${formatMoney(c.credit_limit)}</div>
      </div>
    `).join('');
    listEl.querySelectorAll('.w-client-row').forEach((row) => {
      row.onclick = () => { wizSelectedClientId = row.dataset.id; paintClientList(); };
    });
  }
  paintClientList();

  document.getElementById('w-client-search').oninput = debounce((e) => { wizClientSearch = e.target.value; paintClientList(); }, 200);

  document.getElementById('w-next').onclick = async () => {
    if (!wizSelectedClientId) { showToast('Selecione um cliente.'); return; }
    const c = wizClientsList.find((x) => x.profile_id === wizSelectedClientId);
    wiz.client_id = c.profile_id;
    wiz.client_name = (c.profiles || {}).full_name || (c.profiles || {}).email;
    await refreshClientLimit(c.profile_id);
    wiz.step = 2;
    paintWizard();
  };
}

function paintWizardStep2() {
  const body = document.getElementById('wizard-body');
  const totalDisbursed = Number(wiz.principal_amount || 0) + (wiz.has_operational_fee ? Number(wiz.operational_fee_amount || 0) : 0);
  const availableForClient = Math.max(0, wiz.client_limit - wiz.client_used);

  body.innerHTML = `
    <div class="card">
      <div class="flex justify-between items-center">
        <h3>Configuração do empréstimo</h3>
        <span class="badge badge-brand">${escapeHtml(wiz.client_name)}</span>
      </div>
      <p class="text-sm text-soft mt-8">Limite disponível para este cliente: <strong class="mono">${formatMoney(availableForClient)}</strong></p>

      <div class="form-section-title">Valor e datas</div>
      <div class="field-row">
        <div class="field"><label>Valor emprestado — dívida-base (R$)</label><input type="text" id="w-principal" value=""></div>
        <div class="field"><label>Data do contrato</label><input type="date" id="w-contract-date" value="${wiz.contract_date}" max="${todayISO()}"></div>
        <div class="field"><label>Data da 1ª parcela</label><input type="date" id="w-first-date" value="${wiz.first_installment_date}"></div>
      </div>

      <div class="form-section-title">Prazo e parcelas</div>
      <div class="field-row">
        <div class="field">
          <label>Juros (%) do período contratado</label>
          <input type="number" min="0" step="0.01" id="w-rate" value="${wiz.interest_rate}">
        </div>
        <div class="field">
          <label>Tipo de vencimento *</label>
          <select id="w-due-type">
            <option value="mensal" ${wiz.due_type === 'mensal' ? 'selected' : ''}>Mensal</option>
            <option value="quinzenal" ${wiz.due_type === 'quinzenal' ? 'selected' : ''}>Quinzenal</option>
            <option value="personalizado" ${wiz.due_type === 'personalizado' ? 'selected' : ''}>Personalizado (dias)</option>
          </select>
        </div>
        <div class="field">
          <label>Parcelas</label>
          <input type="number" min="1" step="1" id="w-installments" value="${wiz.installments_count}">
        </div>
      </div>
      <div class="field ${wiz.due_type === 'personalizado' ? '' : 'hidden'}" id="w-custom-days-field">
        <label>Intervalo (dias)</label>
        <input type="number" min="1" step="1" id="w-custom-days" value="${wiz.custom_interval_days || 3}">
      </div>

      <div class="form-section-title">Taxa operacional</div>
      <div class="toggle-row">
        <label class="switch"><input type="checkbox" id="w-fee-toggle" ${wiz.has_operational_fee ? 'checked' : ''}><span class="track"></span></label>
        <span>Aplicar taxa operacional de saída neste contrato?</span>
      </div>
      <div id="w-fee-fields" class="mt-14 ${wiz.has_operational_fee ? '' : 'hidden'}">
        <div class="field">
          <label>Valor da taxa operacional de saída (R$)</label>
          <input type="text" id="w-fee-amount" value="">
          <span class="help">Sugestão: ${formatNumber((App.settings && App.settings.default_exit_fee_percent) || 0, 2)}% do valor emprestado + ${formatMoney((App.settings && App.settings.default_exit_fee_fixed) || 0)} fixo (editável).</span>
        </div>
      </div>
      <div class="grid grid-2 mt-8">
        <div class="stat-card"><div class="label">Valor do contrato (dívida-base)</div><div class="value mono" style="font-size:16px" id="w-gross-preview">${formatMoney(wiz.principal_amount || 0)}</div></div>
        <div class="stat-card"><div class="label">Valor total a desembolsar (contrato + taxa)</div><div class="value mono" style="font-size:16px" id="w-net-preview">${formatMoney(totalDisbursed)}</div></div>
      </div>

      <div class="form-section-title">Renovação e encargo de atraso</div>
      <div class="toggle-row">
        <label class="switch"><input type="checkbox" id="w-renewal" ${wiz.allows_renewal ? 'checked' : ''}><span class="track"></span></label>
        <span>Permite renovação (juros repete)</span>
      </div>
      <div class="field-row mt-14">
        <div class="field"><label>Multa por atraso (%)</label><input type="number" min="0" step="0.01" id="w-late-fee" placeholder="0" value="${wiz.late_fee_percent ? wiz.late_fee_percent : ''}"></div>
        <div class="field"><label>Juros por atraso (% ao dia)</label><input type="number" min="0" step="0.01" id="w-late-interest" placeholder="0" value="${wiz.late_interest_percent ? wiz.late_interest_percent : ''}"></div>
      </div>
      <span class="help">Aplicados no momento do recebimento: juros compostos diariamente sobre o saldo da parcela/ciclo em atraso (ex: 2% ao dia) + multa fixa uma vez — o gerente pode ajustar ou zerar em cada recebimento.</span>

      <div class="form-section-title">Observações</div>
      <div class="field"><textarea id="w-observations">${escapeHtml(wiz.observations)}</textarea></div>

      <div class="modal-foot" style="border:none;padding:14px 0 0">
        <button class="btn btn-ghost" id="w-back">${Icons.chevronLeft} Voltar</button>
        <button class="btn btn-primary" id="w-next">Próximo ${Icons.chevronRight}</button>
      </div>
    </div>
  `;

  const principalInput = document.getElementById('w-principal');
  const feeAmountInput = document.getElementById('w-fee-amount');
  if (wiz.principal_amount) setMoneyValue(principalInput, wiz.principal_amount);
  if (wiz.operational_fee_amount) setMoneyValue(feeAmountInput, wiz.operational_fee_amount);
  attachMoneyMask(principalInput);
  attachMoneyMask(feeAmountInput);

  const feeToggle = document.getElementById('w-fee-toggle');
  const recomputeNet = () => {
    const principal = getMoneyValue(principalInput);
    const fee = feeToggle.checked ? getMoneyValue(feeAmountInput) : 0;
    document.getElementById('w-gross-preview').textContent = formatMoney(principal);
    document.getElementById('w-net-preview').textContent = formatMoney(principal + fee);
  };
  feeToggle.onchange = () => {
    document.getElementById('w-fee-fields').classList.toggle('hidden', !feeToggle.checked);
    if (feeToggle.checked && !getMoneyValue(feeAmountInput)) {
      const principal = getMoneyValue(principalInput);
      const pct = (App.settings && App.settings.default_exit_fee_percent) || 0;
      const fixed = (App.settings && App.settings.default_exit_fee_fixed) || 0;
      setMoneyValue(feeAmountInput, principal * pct / 100 + fixed);
    }
    recomputeNet();
  };
  principalInput.oninput = recomputeNet;
  feeAmountInput.oninput = recomputeNet;
  document.getElementById('w-due-type').onchange = (e) => {
    document.getElementById('w-custom-days-field').classList.toggle('hidden', e.target.value !== 'personalizado');
  };

  document.getElementById('w-back').onclick = () => { wiz.step = 1; paintWizard(); };
  document.getElementById('w-next').onclick = async () => {
    wiz.contract_date = document.getElementById('w-contract-date').value;
    wiz.first_installment_date = document.getElementById('w-first-date').value;
    wiz.principal_amount = getMoneyValue(document.getElementById('w-principal'));
    wiz.interest_rate = Number(document.getElementById('w-rate').value || 0);
    wiz.installments_count = Math.max(1, parseInt(document.getElementById('w-installments').value || '1', 10));
    wiz.due_type = document.getElementById('w-due-type').value;
    wiz.custom_interval_days = wiz.due_type === 'personalizado' ? Math.max(1, parseInt(document.getElementById('w-custom-days').value || '3', 10)) : null;
    wiz.has_operational_fee = document.getElementById('w-fee-toggle').checked;
    wiz.operational_fee_amount = wiz.has_operational_fee ? getMoneyValue(document.getElementById('w-fee-amount')) : 0;
    wiz.allows_renewal = document.getElementById('w-renewal').checked;
    wiz.late_fee_percent = Number(document.getElementById('w-late-fee').value || 0);
    wiz.late_interest_percent = Number(document.getElementById('w-late-interest').value || 0);
    wiz.observations = document.getElementById('w-observations').value.trim();

    if (!wiz.principal_amount || wiz.principal_amount <= 0) { showToast('Informe o valor emprestado.'); return; }
    if (!wiz.first_installment_date) { showToast('Informe a data da 1ª parcela.'); return; }

    const availableForClient = Math.max(0, wiz.client_limit - wiz.client_used);
    if (wiz.principal_amount > availableForClient) {
      showToast(`Atenção: valor ultrapassa o limite disponível (${formatMoney(availableForClient)}). O contrato será bloqueado ao confirmar.`);
    }

    const { data, error } = await supa.rpc('calc_installments_preview', {
      p_principal: wiz.principal_amount, p_interest_rate: wiz.interest_rate,
      p_installments_count: wiz.installments_count, p_due_type: wiz.due_type,
      p_first_installment_date: wiz.first_installment_date,
      p_custom_interval_days: wiz.custom_interval_days,
    });
    if (error) { showToast('Erro ao calcular parcelas: ' + error.message); return; }
    wiz.installmentsPreview = data || [];
    wiz.step = 3;
    paintWizard();
  };
}

function paintWizardStep3() {
  const body = document.getElementById('wizard-body');
  const totalInterest = wiz.installmentsPreview.reduce((s, i) => s + Number(i.interest_share), 0);
  const totalPrincipal = wiz.installmentsPreview.reduce((s, i) => s + Number(i.principal_share), 0);
  const totalAmount = totalInterest + totalPrincipal;

  body.innerHTML = `
    <div class="card">
      <h3>Revisão e confirmação</h3>
      <div class="grid grid-3 mt-14">
        <div class="stat-card"><div class="label">Cliente</div><div class="value" style="font-size:17px">${escapeHtml(wiz.client_name)}</div></div>
        <div class="stat-card"><div class="label">Valor liberado</div><div class="value mono" style="font-size:17px">${formatMoney(wiz.principal_amount)}</div></div>
        <div class="stat-card"><div class="label">Juros</div><div class="value" style="font-size:17px">${formatNumber(wiz.interest_rate, 2)}% (Simples)</div></div>
        <div class="stat-card"><div class="label">Parcelas</div><div class="value" style="font-size:17px">${wiz.installments_count}x (${dueTypeLabel(wiz.due_type, wiz.custom_interval_days)})</div></div>
        <div class="stat-card"><div class="label">Valor total a receber</div><div class="value mono" style="font-size:17px">${formatMoney(totalAmount)}</div></div>
        <div class="stat-card"><div class="label">Total a desembolsar (contrato + taxa)</div><div class="value mono" style="font-size:17px">${formatMoney(Number(wiz.principal_amount) + (wiz.has_operational_fee ? Number(wiz.operational_fee_amount) : 0))}</div></div>
      </div>

      <div class="flex justify-between items-center mt-20">
        <h3 style="margin:0">Parcelas editáveis</h3>
        <button class="btn btn-outline btn-sm" id="w-reset-installments">${Icons.renew} Resetar</button>
      </div>
      <p class="text-sm text-soft mt-8">O capital de cada parcela é fixo (parte do valor emprestado); ao editar o valor da parcela, o sistema recalcula os juros automaticamente (valor da parcela − capital).</p>
      <div class="card mt-8" style="padding:0">
        <table class="data-table table-scroll">
          <thead><tr><th>Parcela</th><th>Vencimento</th><th>Valor da parcela</th></tr></thead>
          <tbody id="w-installments-body">
            ${wiz.installmentsPreview.map((inst, idx) => `
              <tr>
                <td data-label="Parcela">${inst.sequence_number}</td>
                <td data-label="Vencimento"><input type="date" class="inst-date" data-idx="${idx}" value="${inst.due_date}"></td>
                <td data-label="Valor da parcela"><input type="text" class="inst-total" data-idx="${idx}"></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div id="w-confirm-feedback" class="mt-14"></div>
      <div class="modal-foot" style="border:none;padding:14px 0 0">
        <button class="btn btn-ghost" id="w-back">${Icons.chevronLeft} Voltar</button>
        <button class="btn btn-primary" id="w-confirm">${Icons.check} Confirmar contrato</button>
      </div>
    </div>
  `;

  function wireRowInputs() {
    document.querySelectorAll('.inst-date').forEach((el) => el.onchange = () => { wiz.installmentsPreview[el.dataset.idx].due_date = el.value; });
    document.querySelectorAll('.inst-total').forEach((el) => {
      const inst = wiz.installmentsPreview[el.dataset.idx];
      setMoneyValue(el, Number(inst.principal_share) + Number(inst.interest_share));
      attachMoneyMask(el);
      el.oninput = () => {
        const idx = el.dataset.idx;
        const principal = Number(wiz.installmentsPreview[idx].principal_share);
        let newTotal = getMoneyValue(el);
        // capital é fixo (parte do valor emprestado) — juros absorve a
        // diferença quando o gerente edita o valor total da parcela. Se o
        // gerente digitar um total abaixo do próprio capital, juros ficaria
        // negativo (viraria "lucro negativo" silencioso no relatório) — trava
        // o total no mínimo igual ao capital e corrige o campo na tela.
        if (newTotal < principal) {
          newTotal = principal;
          setMoneyValue(el, newTotal);
        }
        wiz.installmentsPreview[idx].interest_share = Math.round((newTotal - principal) * 100) / 100;
      };
    });
  }
  wireRowInputs();

  document.getElementById('w-reset-installments').onclick = async () => {
    const { data, error } = await supa.rpc('calc_installments_preview', {
      p_principal: wiz.principal_amount, p_interest_rate: wiz.interest_rate,
      p_installments_count: wiz.installments_count, p_due_type: wiz.due_type,
      p_first_installment_date: wiz.first_installment_date,
      p_custom_interval_days: wiz.custom_interval_days,
    });
    if (error) { showToast('Erro: ' + error.message); return; }
    wiz.installmentsPreview = data || [];
    paintWizardStep3();
  };

  document.getElementById('w-back').onclick = () => { wiz.step = 2; paintWizard(); };
  document.getElementById('w-confirm').onclick = async () => {
    const btn = document.getElementById('w-confirm');
    btn.disabled = true;
    const feedback = document.getElementById('w-confirm-feedback');
    feedback.innerHTML = '';
    try {
      const { error } = await supa.rpc('create_loan_contract', {
        p_client_id: wiz.client_id,
        p_principal_amount: wiz.principal_amount,
        p_interest_rate: wiz.interest_rate,
        p_installments_count: wiz.installments_count,
        p_due_type: wiz.due_type,
        p_contract_date: wiz.contract_date,
        p_first_installment_date: wiz.first_installment_date,
        p_has_operational_fee: wiz.has_operational_fee,
        p_operational_fee_amount: wiz.operational_fee_amount,
        p_allows_renewal: wiz.allows_renewal,
        p_late_fee_percent: wiz.late_fee_percent,
        p_late_interest_percent: wiz.late_interest_percent,
        p_observations: wiz.observations || null,
        p_origin_request_id: wiz.origin_request_id || null,
        p_custom_interval_days: wiz.custom_interval_days,
        p_installments_override: wiz.installmentsPreview.map((i) => ({
          sequence_number: i.sequence_number, due_date: i.due_date,
          principal_share: i.principal_share, interest_share: i.interest_share,
        })),
      });
      if (error) throw error;
      notifyEvent('contrato_criado', wiz.client_id, 'Novo contrato criado',
        `Seu contrato no valor de ${formatMoney(wiz.principal_amount)} foi aprovado e criado.`);
      logAudit('contrato_criado', `Contrato de ${formatMoney(wiz.principal_amount)} criado para ${wiz.client_name}`, { client_id: wiz.client_id, principal_amount: wiz.principal_amount });
      showToast('Contrato criado com sucesso!');
      wiz = null;
      wizClientSearch = '';
      wizSelectedClientId = null;
      router.navigate('#/gerente/contratos');
    } catch (e) {
      const msg = (e.message || '').includes('CREDIT_LIMIT_EXCEEDED')
        ? 'Este valor ultrapassa o limite de crédito disponível do cliente.'
        : (e.message || String(e));
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(msg)}</div>`;
      btn.disabled = false;
    }
  };
}

registerRoute('gerente/contratos/novo', { role: 'gerente', screenId: 'gerente-contrato-novo', title: 'Novo Contrato', render: renderGerenteContratoNovo });

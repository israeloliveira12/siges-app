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

async function renderGerenteContratoNovo() {
  if (pendingContractPrefill) {
    wiz = freshWizard();
    Object.assign(wiz, pendingContractPrefill);
    wiz.step = 2;
    pendingContractPrefill = null;
  } else if (!wiz) {
    wiz = freshWizard();
  }

  if (wiz.step === 1 && !wizClientsList.length) {
    const { data } = await supa.from('clients').select('profile_id, credit_limit, profiles!clients_profile_id_fkey(full_name, email)').order('created_at', { ascending: false });
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

function paintWizardStep1() {
  const body = document.getElementById('wizard-body');
  body.innerHTML = `
    <div class="card">
      <h3>Selecione o cliente</h3>
      <div class="field mt-14">
        <select id="w-client">
          <option value="">Selecione uma opção</option>
          ${wizClientsList.map((c) => `<option value="${c.profile_id}" ${wiz.client_id === c.profile_id ? 'selected' : ''}>${escapeHtml((c.profiles || {}).full_name || (c.profiles || {}).email)} — limite ${formatMoney(c.credit_limit)}</option>`).join('')}
        </select>
      </div>
      <div class="modal-foot" style="border:none;padding:14px 0 0">
        <button class="btn btn-primary" id="w-next">Próximo ${Icons.chevronRight}</button>
      </div>
    </div>
  `;
  document.getElementById('w-next').onclick = async () => {
    const sel = document.getElementById('w-client');
    if (!sel.value) { showToast('Selecione um cliente.'); return; }
    const c = wizClientsList.find((x) => x.profile_id === sel.value);
    wiz.client_id = c.profile_id;
    wiz.client_name = (c.profiles || {}).full_name || (c.profiles || {}).email;
    wiz.client_limit = Number(c.credit_limit);
    const { data } = await supa.rpc('client_outstanding_balance', { p_client_id: c.profile_id });
    wiz.client_used = Number(data) || 0;
    wiz.step = 2;
    paintWizard();
  };
}

function rateReferenceTooltip() {
  const amount = Number(wiz.principal_amount) || 0;
  if (!amount) return '';
  const matches = App.rateReference.filter((r) => r.due_type === wiz.due_type && amount >= Number(r.min_amount) && (r.max_amount == null || amount <= Number(r.max_amount)));
  if (!matches.length) return '<span class="help">Sem sugestão da Tabela VIP para este valor/prazo — defina a taxa livremente.</span>';
  return '<span class="help">Tabela VIP (referência, não obrigatória): ' + matches.map((m) => `${m.periods}x → ${formatNumber(m.rate_percent, 1)}%`).join(' · ') + '</span>';
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

      <div class="field-row mt-14">
        <div class="field"><label>Data do contrato</label><input type="date" id="w-contract-date" value="${wiz.contract_date}"></div>
        <div class="field"><label>Data da 1ª parcela</label><input type="date" id="w-first-date" value="${wiz.first_installment_date}"></div>
      </div>

      <div class="field">
        <label>Valor emprestado — dívida-base (R$)</label>
        <input type="number" min="1" step="0.01" id="w-principal" value="${wiz.principal_amount}">
      </div>

      <div class="field-row">
        <div class="field">
          <label>Juros (%) do período contratado</label>
          <input type="number" min="0" step="0.01" id="w-rate" value="${wiz.interest_rate}">
          ${rateReferenceTooltip()}
        </div>
        <div class="field">
          <label>Parcelas</label>
          <input type="number" min="1" step="1" id="w-installments" value="${wiz.installments_count}">
        </div>
      </div>

      <div class="field">
        <label>Tipo de vencimento *</label>
        <select id="w-due-type">
          <option value="mensal" ${wiz.due_type === 'mensal' ? 'selected' : ''}>Mensal</option>
          <option value="quinzenal" ${wiz.due_type === 'quinzenal' ? 'selected' : ''}>Quinzenal</option>
          <option value="semanal" ${wiz.due_type === 'semanal' ? 'selected' : ''}>Semanal</option>
        </select>
      </div>

      <div class="card" style="background:var(--bg);box-shadow:none;margin:16px 0">
        <div class="toggle-row">
          <label class="switch"><input type="checkbox" id="w-fee-toggle" ${wiz.has_operational_fee ? 'checked' : ''}><span class="track"></span></label>
          <strong>Aplicar taxas operacionais neste contrato?</strong>
        </div>
        <div id="w-fee-fields" class="mt-14 ${wiz.has_operational_fee ? '' : 'hidden'}">
          <div class="field">
            <label>Valor da taxa operacional de saída (R$)</label>
            <input type="number" min="0" step="0.01" id="w-fee-amount" value="${wiz.operational_fee_amount}">
            <span class="help">Sugestão: ${formatNumber((App.settings && App.settings.default_exit_fee_percent) || 0, 2)}% do valor emprestado (editável).</span>
          </div>
        </div>
        <div class="grid grid-2 mt-14">
          <div class="stat-card" style="background:#fff;border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px">
            <div class="label">Valor do contrato (dívida-base)</div>
            <div class="value mono" style="font-size:16px" id="w-gross-preview">${formatMoney(wiz.principal_amount || 0)}</div>
          </div>
          <div class="stat-card" style="background:#fff;border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px">
            <div class="label">Valor total a desembolsar (contrato + taxa)</div>
            <div class="value mono" style="font-size:16px" id="w-net-preview">${formatMoney(totalDisbursed)}</div>
          </div>
        </div>
      </div>

      <div class="field-row">
        <div class="toggle-row field"><label class="switch"><input type="checkbox" id="w-renewal" ${wiz.allows_renewal ? 'checked' : ''}><span class="track"></span></label><span>Permite renovação (juros repete)</span></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Multa por atraso (%)</label><input type="number" min="0" step="0.01" id="w-late-fee" value="${wiz.late_fee_percent}"></div>
        <div class="field"><label>Juros por atraso (% a.m.)</label><input type="number" min="0" step="0.01" id="w-late-interest" value="${wiz.late_interest_percent}"></div>
      </div>
      <div class="field"><label>Observações</label><textarea id="w-observations">${escapeHtml(wiz.observations)}</textarea></div>

      <div class="modal-foot" style="border:none;padding:14px 0 0">
        <button class="btn btn-ghost" id="w-back">${Icons.chevronLeft} Voltar</button>
        <button class="btn btn-primary" id="w-next">Próximo ${Icons.chevronRight}</button>
      </div>
    </div>
  `;

  const feeToggle = document.getElementById('w-fee-toggle');
  const recomputeNet = () => {
    const principal = Number(document.getElementById('w-principal').value || 0);
    const fee = feeToggle.checked ? Number(document.getElementById('w-fee-amount').value || 0) : 0;
    document.getElementById('w-gross-preview').textContent = formatMoney(principal);
    document.getElementById('w-net-preview').textContent = formatMoney(principal + fee);
  };
  feeToggle.onchange = () => {
    document.getElementById('w-fee-fields').classList.toggle('hidden', !feeToggle.checked);
    const feeInput = document.getElementById('w-fee-amount');
    if (feeToggle.checked && !Number(feeInput.value)) {
      const principal = Number(document.getElementById('w-principal').value || 0);
      const pct = (App.settings && App.settings.default_exit_fee_percent) || 0;
      feeInput.value = (principal * pct / 100).toFixed(2);
    }
    recomputeNet();
  };
  document.getElementById('w-principal').oninput = () => { recomputeNet(); refreshRateHint(); };
  document.getElementById('w-fee-amount').oninput = recomputeNet;
  document.getElementById('w-due-type').onchange = refreshRateHint;

  function refreshRateHint() {
    wiz.principal_amount = document.getElementById('w-principal').value;
    wiz.due_type = document.getElementById('w-due-type').value;
    const wrap = document.getElementById('w-rate').parentElement;
    const helpEl = wrap.querySelector('.help');
    if (helpEl) helpEl.outerHTML = rateReferenceTooltip();
  }

  document.getElementById('w-back').onclick = () => { wiz.step = 1; paintWizard(); };
  document.getElementById('w-next').onclick = async () => {
    wiz.contract_date = document.getElementById('w-contract-date').value;
    wiz.first_installment_date = document.getElementById('w-first-date').value;
    wiz.principal_amount = Number(document.getElementById('w-principal').value || 0);
    wiz.interest_rate = Number(document.getElementById('w-rate').value || 0);
    wiz.installments_count = Math.max(1, parseInt(document.getElementById('w-installments').value || '1', 10));
    wiz.due_type = document.getElementById('w-due-type').value;
    wiz.has_operational_fee = document.getElementById('w-fee-toggle').checked;
    wiz.operational_fee_amount = wiz.has_operational_fee ? Number(document.getElementById('w-fee-amount').value || 0) : 0;
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
        <div class="stat-card"><div class="label">Cliente</div><div class="value" style="font-size:15px">${escapeHtml(wiz.client_name)}</div></div>
        <div class="stat-card"><div class="label">Valor liberado</div><div class="value mono">${formatMoney(wiz.principal_amount)}</div></div>
        <div class="stat-card"><div class="label">Juros</div><div class="value mono">${formatNumber(wiz.interest_rate, 2)}% (Simples)</div></div>
        <div class="stat-card"><div class="label">Parcelas</div><div class="value mono">${wiz.installments_count}x (${dueTypeLabel(wiz.due_type)})</div></div>
        <div class="stat-card"><div class="label">Valor total a receber</div><div class="value mono">${formatMoney(totalAmount)}</div></div>
        <div class="stat-card"><div class="label">Total a desembolsar (contrato + taxa)</div><div class="value mono">${formatMoney(Number(wiz.principal_amount) + (wiz.has_operational_fee ? Number(wiz.operational_fee_amount) : 0))}</div></div>
      </div>

      <div class="flex justify-between items-center mt-20">
        <h3 style="margin:0">Parcelas editáveis</h3>
        <button class="btn btn-outline btn-sm" id="w-reset-installments">${Icons.renew} Resetar</button>
      </div>
      <div class="card mt-8" style="padding:0">
        <table class="data-table table-scroll">
          <thead><tr><th>Parcela</th><th>Vencimento</th><th>Capital</th><th>Juros</th><th>Total</th></tr></thead>
          <tbody id="w-installments-body">
            ${wiz.installmentsPreview.map((inst, idx) => `
              <tr>
                <td data-label="Parcela">${inst.sequence_number}</td>
                <td data-label="Vencimento"><input type="date" class="inst-date" data-idx="${idx}" value="${inst.due_date}"></td>
                <td data-label="Capital"><input type="number" step="0.01" class="inst-principal" data-idx="${idx}" value="${inst.principal_share}"></td>
                <td data-label="Juros"><input type="number" step="0.01" class="inst-interest" data-idx="${idx}" value="${inst.interest_share}"></td>
                <td data-label="Total" class="mono inst-total" data-idx="${idx}">${formatMoney(Number(inst.principal_share) + Number(inst.interest_share))}</td>
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
    document.querySelectorAll('.inst-principal, .inst-interest').forEach((el) => {
      el.oninput = () => {
        const idx = el.dataset.idx;
        wiz.installmentsPreview[idx].principal_share = Number(document.querySelector(`.inst-principal[data-idx="${idx}"]`).value || 0);
        wiz.installmentsPreview[idx].interest_share = Number(document.querySelector(`.inst-interest[data-idx="${idx}"]`).value || 0);
        const total = wiz.installmentsPreview[idx].principal_share + wiz.installmentsPreview[idx].interest_share;
        document.querySelector(`.inst-total[data-idx="${idx}"]`).textContent = formatMoney(total);
      };
    });
  }
  wireRowInputs();

  document.getElementById('w-reset-installments').onclick = async () => {
    const { data, error } = await supa.rpc('calc_installments_preview', {
      p_principal: wiz.principal_amount, p_interest_rate: wiz.interest_rate,
      p_installments_count: wiz.installments_count, p_due_type: wiz.due_type,
      p_first_installment_date: wiz.first_installment_date,
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
        p_installments_override: wiz.installmentsPreview.map((i) => ({
          sequence_number: i.sequence_number, due_date: i.due_date,
          principal_share: i.principal_share, interest_share: i.interest_share,
        })),
      });
      if (error) throw error;
      notifyEvent('contrato_criado', wiz.client_id, 'Novo contrato criado',
        `Seu contrato no valor de ${formatMoney(wiz.principal_amount)} foi aprovado e criado.`);
      showToast('Contrato criado com sucesso!');
      wiz = null;
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

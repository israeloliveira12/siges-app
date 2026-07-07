/* ============================================================================
   Modal de recebimento — quitar parcela/ciclo OU renovar (só juros, dívida
   inteira renova por mais um período)
   ============================================================================ */

let receberMode = 'quitar'; // 'quitar' | 'renovar'

async function openReceberModal(source, onDone) {
  receberMode = 'quitar';
  let item = null;

  if (source.sourceType === 'installment') {
    const { data } = await supa.from('installments').select('*').eq('id', source.id).maybeSingle();
    item = data;
  } else {
    const { data } = await supa.from('renewal_cycles').select('*').eq('id', source.id).maybeSingle();
    item = data;
  }
  if (!item) { showToast('Não foi possível carregar os dados.'); return; }

  const contract = source.contract;
  const isInstallment = source.sourceType === 'installment';
  const totalDue = isInstallment ? Number(item.amount_due) : Number(item.full_debt_amount);
  const interestPortion = isInstallment ? Number(item.interest_share) : (Number(item.full_debt_amount) - Number(contract.principal_amount));

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  document.body.appendChild(overlay);

  function paint() {
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-head">
          <h3>Receber pagamento — ${isInstallment ? 'Parcela ' + item.sequence_number : 'Ciclo de renovação ' + item.cycle_number}</h3>
          <button class="icon-btn" id="close-modal">${Icons.x}</button>
        </div>
        <div class="modal-body">
          <div class="grid grid-2 mt-0">
            <div class="stat-card"><div class="label">Vencimento</div><div class="value" style="font-size:15px">${formatDate(isInstallment ? item.due_date : item.new_due_date)}</div></div>
            <div class="stat-card"><div class="label">Total com encargos</div><div class="value mono">${formatMoney(totalDue)}</div></div>
          </div>

          <div class="auth-tabs mt-14">
            <button class="auth-tab ${receberMode === 'quitar' ? 'active' : ''}" id="tab-quitar">Quitar</button>
            ${contract.allows_renewal ? `<button class="auth-tab ${receberMode === 'renovar' ? 'active' : ''}" id="tab-renovar">Renovar</button>` : ''}
          </div>

          <div id="receber-feedback"></div>
          <div id="receber-fields"></div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
          <button class="btn btn-primary" id="confirm-receber">Confirmar</button>
        </div>
      </div>
    `;

    document.getElementById('close-modal').onclick = () => overlay.remove();
    document.getElementById('cancel-modal').onclick = () => overlay.remove();
    document.getElementById('confirm-receber').onclick = confirmReceber;
    const tabQuitar = document.getElementById('tab-quitar');
    const tabRenovar = document.getElementById('tab-renovar');
    if (tabQuitar) tabQuitar.onclick = () => { receberMode = 'quitar'; paint(); };
    if (tabRenovar) tabRenovar.onclick = () => { receberMode = 'renovar'; paint(); };

    paintFields();
  }

  function paintFields() {
    const fields = document.getElementById('receber-fields');
    if (receberMode === 'quitar') {
      fields.innerHTML = `
        <div class="field"><label>Valor recebido (R$)</label><input type="number" step="0.01" id="r-amount" value="${totalDue}"></div>
        <div class="toggle-row mt-8"><label class="switch"><input type="checkbox" id="r-fee-toggle"><span class="track"></span></label><span>Aplicar taxas operacionais neste recebimento?</span></div>
        <div id="r-fee-fields" class="hidden mt-8"><div class="field"><label>Valor da taxa operacional (R$)</label><input type="number" step="0.01" id="r-fee-amount" value="0"></div></div>
        <div class="grid grid-2 mt-14">
          <div class="stat-card" style="background:var(--bg)"><div class="label">Lucro bruto (juros)</div><div class="value mono" id="r-gross-profit" style="font-size:16px">${formatMoney(interestPortion)}</div></div>
          <div class="stat-card" style="background:var(--bg)"><div class="label">Lucro líquido</div><div class="value mono" id="r-net-profit" style="font-size:16px">${formatMoney(interestPortion)}</div></div>
        </div>
      `;
      const feeToggle = document.getElementById('r-fee-toggle');
      const recompute = () => {
        const fee = feeToggle.checked ? Number(document.getElementById('r-fee-amount').value || 0) : 0;
        document.getElementById('r-net-profit').textContent = formatMoney(interestPortion - fee);
      };
      feeToggle.onchange = () => { document.getElementById('r-fee-fields').classList.toggle('hidden', !feeToggle.checked); recompute(); };
      document.getElementById('r-fee-amount').oninput = recompute;
    } else {
      fields.innerHTML = `
        <p class="text-sm text-soft mt-8">O cliente paga só os juros deste ciclo, e a dívida cheia (${formatMoney(totalDue)}) renova para o próximo período.</p>
        <div class="field mt-8"><label>Valor de juros recebido (R$)</label><input type="number" step="0.01" id="r-interest-amount" value="${interestPortion}"></div>
        <div class="toggle-row mt-8"><label class="switch"><input type="checkbox" id="r-fee-toggle"><span class="track"></span></label><span>Aplicar taxas operacionais neste recebimento?</span></div>
        <div id="r-fee-fields" class="hidden mt-8"><div class="field"><label>Valor da taxa operacional (R$)</label><input type="number" step="0.01" id="r-fee-amount" value="0"></div></div>
        <div class="grid grid-2 mt-14">
          <div class="stat-card" style="background:var(--bg)"><div class="label">Lucro bruto (juros)</div><div class="value mono" id="r-gross-profit" style="font-size:16px">${formatMoney(interestPortion)}</div></div>
          <div class="stat-card" style="background:var(--bg)"><div class="label">Lucro líquido</div><div class="value mono" id="r-net-profit" style="font-size:16px">${formatMoney(interestPortion)}</div></div>
        </div>
      `;
      const feeToggle = document.getElementById('r-fee-toggle');
      const recompute = () => {
        const interestAmount = Number(document.getElementById('r-interest-amount').value || 0);
        const fee = feeToggle.checked ? Number(document.getElementById('r-fee-amount').value || 0) : 0;
        document.getElementById('r-gross-profit').textContent = formatMoney(interestAmount);
        document.getElementById('r-net-profit').textContent = formatMoney(interestAmount - fee);
      };
      feeToggle.onchange = () => { document.getElementById('r-fee-fields').classList.toggle('hidden', !feeToggle.checked); recompute(); };
      document.getElementById('r-fee-amount').oninput = recompute;
      document.getElementById('r-interest-amount').oninput = recompute;
    }
  }

  paint();

  async function confirmReceber() {
    const btn = document.getElementById('confirm-receber');
    const feedback = document.getElementById('receber-feedback');
    btn.disabled = true;
    feedback.innerHTML = '';
    try {
      if (receberMode === 'quitar') {
        const amount = Number(document.getElementById('r-amount').value || 0);
        const hasFee = document.getElementById('r-fee-toggle').checked;
        const feeAmount = hasFee ? Number(document.getElementById('r-fee-amount').value || 0) : 0;
        if (!amount || amount <= 0) throw new Error('Informe um valor válido.');

        if (isInstallment) {
          const { error } = await supa.rpc('receive_payment', {
            p_installment_id: item.id, p_amount_received: amount,
            p_has_operational_fee: hasFee, p_operational_fee_amount: feeAmount,
          });
          if (error) throw error;
        } else {
          const { error } = await supa.rpc('receive_cycle_payment', {
            p_cycle_id: item.id, p_amount_received: amount,
            p_has_operational_fee: hasFee, p_operational_fee_amount: feeAmount,
          });
          if (error) throw error;
        }
        notifyEvent('pagamento_recebido', contract.client_id, 'Pagamento recebido',
          `Recebemos seu pagamento de ${formatMoney(amount)}.`);
        showToast('Pagamento registrado.');
      } else {
        const interestAmount = Number(document.getElementById('r-interest-amount').value || 0);
        const hasFee = document.getElementById('r-fee-toggle').checked;
        const feeAmount = hasFee ? Number(document.getElementById('r-fee-amount').value || 0) : 0;
        if (interestAmount < 0) throw new Error('Valor inválido.');

        const { error } = await supa.rpc('renew_installment', {
          p_source_type: isInstallment ? 'installment' : 'renewal_cycle',
          p_source_id: item.id,
          p_interest_only_amount: interestAmount,
          p_has_operational_fee: hasFee,
          p_operational_fee_amount: feeAmount,
        });
        if (error) throw error;
        notifyEvent('renovacao_registrada', contract.client_id, 'Renovação registrada',
          `Recebemos os juros de ${formatMoney(interestAmount)}. Sua dívida foi renovada por mais um período.`);
        showToast('Renovação registrada. Dívida renovada por mais um período.');
      }
      overlay.remove();
      if (typeof onDone === 'function') onDone();
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message || String(e))}</div>`;
      btn.disabled = false;
    }
  }
}

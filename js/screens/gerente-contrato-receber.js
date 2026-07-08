/* ============================================================================
   Modal de recebimento — quitar (total ou parcial) parcela/ciclo OU renovar
   (só juros, dívida inteira renova por mais um período — só para contratos
   de parcela única)
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

  // Para parcelas, considera o que já foi pago parcialmente antes.
  const alreadyPaid = isInstallment ? (Number(item.principal_paid_partial || 0) + Number(item.interest_paid_partial || 0)) : 0;
  const totalDue = isInstallment ? (Number(item.amount_due) - alreadyPaid) : Number(item.full_debt_amount);
  const interestPortion = isInstallment
    ? (Number(item.interest_share) - Number(item.interest_paid_partial || 0))
    : (Number(item.full_debt_amount) - Number(contract.principal_amount));

  // Renovação só é permitida em contratos de parcela única (senão a
  // renovação de UMA parcela deixaria as outras parcelas do contrato
  // com uma relação ambígua com o ciclo renovado).
  const canRenew = contract.allows_renewal && Number(contract.installments_count) === 1;

  // Encargo de atraso: juros simples proporcional aos dias em atraso (sobre o
  // saldo desta parcela/ciclo) + multa fixa — sugestão editável pelo gerente,
  // cobrada por cima do saldo contratual, sem alterar o amount_due histórico.
  const dueDateStr = isInstallment ? item.due_date : item.new_due_date;
  const diasAtraso = Math.max(0, Math.round((new Date(todayISO()) - new Date(dueDateStr)) / 86400000));
  const lateInterestPercent = Number(contract.late_interest_percent || 0);
  const lateFeePercent = Number(contract.late_fee_percent || 0);
  const jurosAtrasoSugerido = diasAtraso > 0 ? Math.round(totalDue * (lateInterestPercent / 100 / 30) * diasAtraso * 100) / 100 : 0;
  const multaAtrasoSugerida = diasAtraso > 0 ? Math.round(totalDue * (lateFeePercent / 100) * 100) / 100 : 0;
  const exitFeeAmount = contract.has_operational_fee ? Number(contract.operational_fee_amount || 0) : 0;

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
            <div class="stat-card"><div class="label">${alreadyPaid > 0 ? 'Restante em aberto' : 'Total com encargos'}</div><div class="value mono">${formatMoney(totalDue + jurosAtrasoSugerido + multaAtrasoSugerida)}</div></div>
          </div>
          ${alreadyPaid > 0 ? `<p class="text-sm text-soft mt-8">Já foi recebido ${formatMoney(alreadyPaid)} desta parcela em pagamento(s) parcial(is) anterior(es).</p>` : ''}
          ${diasAtraso > 0 ? `<p class="text-sm mt-8" style="color:var(--bad)">Em atraso há ${diasAtraso} dia(s).</p>` : ''}
          ${exitFeeAmount > 0 ? `<p class="text-sm text-soft mt-8">Taxa de saída deste contrato: ${formatMoney(exitFeeAmount)} (já cobrada na criação do contrato — não entra na conta deste recebimento).</p>` : ''}

          ${canRenew ? `
          <div class="auth-tabs mt-14">
            <button class="auth-tab ${receberMode === 'quitar' ? 'active' : ''}" id="tab-quitar">Quitar</button>
            <button class="auth-tab ${receberMode === 'renovar' ? 'active' : ''}" id="tab-renovar">Renovar</button>
          </div>` : ''}

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
      const suggestedTotal = totalDue + jurosAtrasoSugerido + multaAtrasoSugerida;
      fields.innerHTML = `
        ${diasAtraso > 0 ? `
        <div class="field-row">
          <div class="field"><label>Juros de atraso (${diasAtraso}d)</label><input type="text" id="r-late-interest"></div>
          <div class="field"><label>Multa por atraso</label><input type="text" id="r-late-fee"></div>
        </div>
        <span class="help">Sugestão calculada automaticamente — pode ajustar ou zerar antes de confirmar.</span>
        ` : ''}
        <div class="field mt-8">
          <label>Valor recebido (R$)</label>
          <input type="text" id="r-amount">
          <span class="help" id="r-partial-hint"></span>
        </div>
        <div class="toggle-row mt-8"><label class="switch"><input type="checkbox" id="r-fee-toggle"><span class="track"></span></label><span>Aplicar taxas operacionais neste recebimento?</span></div>
        <div id="r-fee-fields" class="hidden mt-8"><div class="field"><label>Valor da taxa operacional (R$)</label><input type="text" id="r-fee-amount"></div></div>
        <div class="grid grid-2 mt-14">
          <div class="stat-card" style="background:var(--bg)"><div class="label">Valor coletado (bruto)</div><div class="value mono" id="r-gross-collected" style="font-size:16px">${formatMoney(suggestedTotal)}</div></div>
          <div class="stat-card" style="background:var(--bg)"><div class="label">Valor coletado (líquido)</div><div class="value mono" id="r-net-collected" style="font-size:16px">${formatMoney(suggestedTotal)}</div></div>
          <div class="stat-card" style="background:var(--bg)"><div class="label">Lucro bruto (juros + encargo de atraso)</div><div class="value mono" id="r-gross-profit" style="font-size:16px">${formatMoney(interestPortion)}</div></div>
          <div class="stat-card" style="background:var(--bg)"><div class="label">Lucro líquido</div><div class="value mono" id="r-net-profit" style="font-size:16px">${formatMoney(interestPortion)}</div></div>
        </div>
      `;
      const amountInput = document.getElementById('r-amount');
      const feeInput = document.getElementById('r-fee-amount');
      const lateInterestInput = document.getElementById('r-late-interest');
      const lateFeeInput = document.getElementById('r-late-fee');
      setMoneyValue(amountInput, suggestedTotal);
      attachMoneyMask(amountInput);
      attachMoneyMask(feeInput);
      const feeToggle = document.getElementById('r-fee-toggle');
      const recompute = () => {
        const amount = getMoneyValue(amountInput);
        const fee = feeToggle.checked ? getMoneyValue(feeInput) : 0;
        const lateAuthorized = (lateInterestInput ? getMoneyValue(lateInterestInput) : 0) + (lateFeeInput ? getMoneyValue(lateFeeInput) : 0);
        // pagamento parcial: juros contratual é priorizado, depois capital;
        // o encargo de atraso só entra na conta quando o valor recebido
        // ultrapassa o saldo contratual da parcela (totalDue).
        const contractualNow = Math.min(amount, totalDue);
        const interestNow = Math.min(contractualNow, interestPortion);
        const lateNow = Math.max(0, Math.min(amount - totalDue, lateAuthorized));
        const grossProfit = interestNow + lateNow;
        document.getElementById('r-gross-collected').textContent = formatMoney(amount);
        document.getElementById('r-net-collected').textContent = formatMoney(amount - fee);
        document.getElementById('r-gross-profit').textContent = formatMoney(grossProfit);
        document.getElementById('r-net-profit').textContent = formatMoney(grossProfit - fee);
        const hint = document.getElementById('r-partial-hint');
        if (amount > 0 && amount < totalDue - 0.005) {
          hint.textContent = `Pagamento parcial — R$ ${formatNumber(totalDue - amount, 2)} continuam em aberto para esta parcela.`;
        } else {
          hint.textContent = '';
        }
      };
      feeToggle.onchange = () => {
        document.getElementById('r-fee-fields').classList.toggle('hidden', !feeToggle.checked);
        if (feeToggle.checked && !getMoneyValue(feeInput)) {
          const amount = getMoneyValue(amountInput);
          const pct = (App.settings && App.settings.default_entry_fee_percent) || 0;
          const fixed = (App.settings && App.settings.default_entry_fee_fixed) || 0;
          setMoneyValue(feeInput, amount * pct / 100 + fixed);
        }
        recompute();
      };
      feeInput.oninput = recompute;
      amountInput.oninput = recompute;
      if (lateInterestInput) {
        attachMoneyMask(lateInterestInput);
        setMoneyValue(lateInterestInput, jurosAtrasoSugerido);
        lateInterestInput.oninput = () => {
          setMoneyValue(amountInput, totalDue + getMoneyValue(lateInterestInput) + getMoneyValue(lateFeeInput));
          recompute();
        };
      }
      if (lateFeeInput) {
        attachMoneyMask(lateFeeInput);
        setMoneyValue(lateFeeInput, multaAtrasoSugerida);
        lateFeeInput.oninput = () => {
          setMoneyValue(amountInput, totalDue + getMoneyValue(lateInterestInput) + getMoneyValue(lateFeeInput));
          recompute();
        };
      }
      recompute();
    } else {
      const suggestedInterest = interestPortion + jurosAtrasoSugerido + multaAtrasoSugerida;
      fields.innerHTML = `
        <p class="text-sm text-soft mt-8">O cliente paga só os juros deste ciclo, e a dívida cheia (${formatMoney(totalDue)}) renova para o próximo período.</p>
        ${diasAtraso > 0 ? `
        <div class="field-row">
          <div class="field"><label>Juros de atraso (${diasAtraso}d)</label><input type="text" id="r-late-interest"></div>
          <div class="field"><label>Multa por atraso</label><input type="text" id="r-late-fee"></div>
        </div>
        <span class="help">Sugestão calculada automaticamente — pode ajustar ou zerar antes de confirmar.</span>
        ` : ''}
        <div class="field mt-8"><label>Valor de juros recebido (R$)</label><input type="text" id="r-interest-amount"></div>
        <div class="toggle-row mt-8"><label class="switch"><input type="checkbox" id="r-fee-toggle"><span class="track"></span></label><span>Aplicar taxas operacionais neste recebimento?</span></div>
        <div id="r-fee-fields" class="hidden mt-8"><div class="field"><label>Valor da taxa operacional (R$)</label><input type="text" id="r-fee-amount"></div></div>
        <div class="grid grid-2 mt-14">
          <div class="stat-card" style="background:var(--bg)"><div class="label">Lucro bruto (juros + encargo de atraso)</div><div class="value mono" id="r-gross-profit" style="font-size:16px">${formatMoney(suggestedInterest)}</div></div>
          <div class="stat-card" style="background:var(--bg)"><div class="label">Lucro líquido</div><div class="value mono" id="r-net-profit" style="font-size:16px">${formatMoney(suggestedInterest)}</div></div>
        </div>
      `;
      const interestInput = document.getElementById('r-interest-amount');
      const feeInput = document.getElementById('r-fee-amount');
      const lateInterestInput = document.getElementById('r-late-interest');
      const lateFeeInput = document.getElementById('r-late-fee');
      setMoneyValue(interestInput, suggestedInterest);
      attachMoneyMask(interestInput);
      attachMoneyMask(feeInput);
      const feeToggle = document.getElementById('r-fee-toggle');
      const recompute = () => {
        const interestAmount = getMoneyValue(interestInput);
        const fee = feeToggle.checked ? getMoneyValue(feeInput) : 0;
        document.getElementById('r-gross-profit').textContent = formatMoney(interestAmount);
        document.getElementById('r-net-profit').textContent = formatMoney(interestAmount - fee);
      };
      feeToggle.onchange = () => {
        document.getElementById('r-fee-fields').classList.toggle('hidden', !feeToggle.checked);
        if (feeToggle.checked && !getMoneyValue(feeInput)) {
          const interestAmount = getMoneyValue(interestInput);
          const pct = (App.settings && App.settings.default_entry_fee_percent) || 0;
          const fixed = (App.settings && App.settings.default_entry_fee_fixed) || 0;
          setMoneyValue(feeInput, interestAmount * pct / 100 + fixed);
        }
        recompute();
      };
      feeInput.oninput = recompute;
      interestInput.oninput = recompute;
      if (lateInterestInput) {
        attachMoneyMask(lateInterestInput);
        setMoneyValue(lateInterestInput, jurosAtrasoSugerido);
        lateInterestInput.oninput = () => {
          setMoneyValue(interestInput, interestPortion + getMoneyValue(lateInterestInput) + getMoneyValue(lateFeeInput));
          recompute();
        };
      }
      if (lateFeeInput) {
        attachMoneyMask(lateFeeInput);
        setMoneyValue(lateFeeInput, multaAtrasoSugerida);
        lateFeeInput.oninput = () => {
          setMoneyValue(interestInput, interestPortion + getMoneyValue(lateInterestInput) + getMoneyValue(lateFeeInput));
          recompute();
        };
      }
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
        const amount = getMoneyValue(document.getElementById('r-amount'));
        const hasFee = document.getElementById('r-fee-toggle').checked;
        const feeAmount = hasFee ? getMoneyValue(document.getElementById('r-fee-amount')) : 0;
        const lateInterestEl = document.getElementById('r-late-interest');
        const lateFeeEl = document.getElementById('r-late-fee');
        const lateChargeAmount = (lateInterestEl ? getMoneyValue(lateInterestEl) : 0) + (lateFeeEl ? getMoneyValue(lateFeeEl) : 0);
        if (!amount || amount <= 0) throw new Error('Informe um valor válido.');
        if (amount > totalDue + lateChargeAmount + 0.01) throw new Error(`O valor não pode ser maior que o restante desta parcela mais o encargo de atraso (${formatMoney(totalDue + lateChargeAmount)}).`);

        if (isInstallment) {
          const { error } = await supa.rpc('receive_payment', {
            p_installment_id: item.id, p_amount_received: amount,
            p_has_operational_fee: hasFee, p_operational_fee_amount: feeAmount,
            p_late_charge_amount: lateChargeAmount,
          });
          if (error) throw error;
        } else {
          const { error } = await supa.rpc('receive_cycle_payment', {
            p_cycle_id: item.id, p_amount_received: amount,
            p_has_operational_fee: hasFee, p_operational_fee_amount: feeAmount,
            p_late_charge_amount: lateChargeAmount,
          });
          if (error) throw error;
        }
        const isPartial = amount < totalDue - 0.005;
        notifyEvent('pagamento_recebido', contract.client_id, isPartial ? 'Pagamento parcial recebido' : 'Pagamento recebido',
          isPartial
            ? `Recebemos ${formatMoney(amount)}. Restam ${formatMoney(totalDue - amount)} desta parcela.`
            : `Recebemos seu pagamento de ${formatMoney(amount)}.`);
        showToast(isPartial ? 'Pagamento parcial registrado.' : 'Pagamento registrado.');
      } else {
        const interestAmount = getMoneyValue(document.getElementById('r-interest-amount'));
        const hasFee = document.getElementById('r-fee-toggle').checked;
        const feeAmount = hasFee ? getMoneyValue(document.getElementById('r-fee-amount')) : 0;
        const lateInterestEl = document.getElementById('r-late-interest');
        const lateFeeEl = document.getElementById('r-late-fee');
        const lateChargeAmount = Math.min(interestAmount, (lateInterestEl ? getMoneyValue(lateInterestEl) : 0) + (lateFeeEl ? getMoneyValue(lateFeeEl) : 0));
        if (interestAmount < 0) throw new Error('Valor inválido.');

        const { error } = await supa.rpc('renew_installment', {
          p_source_type: isInstallment ? 'installment' : 'renewal_cycle',
          p_source_id: item.id,
          p_interest_only_amount: interestAmount - lateChargeAmount,
          p_has_operational_fee: hasFee,
          p_operational_fee_amount: feeAmount,
          p_late_charge_amount: lateChargeAmount,
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

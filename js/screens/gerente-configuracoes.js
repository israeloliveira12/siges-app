/* ============================================================================
   Gerente — Configurações do sistema
   ============================================================================ */

async function renderGerenteConfiguracoes() {
  const root = document.getElementById('screen-gerente-configuracoes');
  const { data: settings } = await supa.from('system_settings').select('*').maybeSingle();
  App.settings = settings;

  root.innerHTML = `
    <div class="card">
      <h3>Dados da empresa</h3>
      <div class="field mt-14"><label>Nome da empresa</label><input type="text" id="cfg-company-name" value="${escapeHtml(settings.company_name)}"></div>
      <div class="field-row">
        <div class="field"><label>WhatsApp da empresa</label><input type="tel" id="cfg-company-whatsapp" placeholder="Ex: 5511999990000" value="${escapeHtml(settings.company_whatsapp || '')}">
          <span class="help">Com DDI+DDD, só números (ex: 5511999990000). Usado para futuros contatos da empresa.</span>
        </div>
        <div class="field"><label>Chave Pix da empresa</label><input type="text" id="cfg-company-pix" value="${escapeHtml(settings.company_pix_key || '')}">
          <span class="help">Aparece nas mensagens de cobrança enviadas ao cliente.</span>
        </div>
      </div>
    </div>

    <div class="card mt-14">
      <h3>Configurações de atraso e perda</h3>
      <p class="text-sm text-soft mt-8">Esses dias controlam quando um contrato atrasado passa a ser tratado como "perda" nos relatórios.</p>
      <div class="field-row mt-14">
        <div class="field"><label>Dias para considerar contrato crítico</label><input type="number" min="1" id="cfg-critical-days" value="${settings.critical_days_threshold}"></div>
        <div class="field"><label>Dias para considerar perda</label><input type="number" min="1" id="cfg-loss-days" value="${settings.loss_days_threshold}"></div>
      </div>
    </div>

    <div class="card mt-14">
      <h3>Taxas operacionais padrão</h3>
      <p class="text-sm text-soft mt-8">Usadas como sugestão automática (sempre editável) ao criar um contrato (taxa de saída) e ao receber um pagamento (taxa de entrada).</p>
      <div class="field-row mt-14">
        <div class="field">
          <label>Taxa de saída (%)</label>
          <input type="number" min="0" step="0.01" id="cfg-exit-fee" value="${settings.default_exit_fee_percent}">
          <span class="help">Calculada sobre o valor emprestado (dívida-base) ao criar um contrato.</span>
        </div>
        <div class="field">
          <label>Taxa de entrada (%)</label>
          <input type="number" min="0" step="0.01" id="cfg-entry-fee" value="${settings.default_entry_fee_percent}">
          <span class="help">Calculada sobre o valor recebido ao quitar/renovar uma parcela.</span>
        </div>
      </div>
    </div>

    <div id="cfg-feedback" class="mt-14"></div>
    <button class="btn btn-primary mt-8" id="cfg-save">Salvar configurações</button>

    <div class="card mt-20">
      <h3>Tabela de referência de taxas (Tabela VIP)</h3>
      <p class="text-sm text-soft mt-8">Usada só como sugestão visual ao criar contratos — nunca trava o valor digitado pelo administrador.</p>
      <table class="data-table table-scroll mt-14">
        <thead><tr><th>Tipo</th><th>Faixa de valor</th><th>Períodos</th><th>Taxa</th></tr></thead>
        <tbody>
          ${App.rateReference.map((r) => `
            <tr>
              <td data-label="Tipo">${dueTypeLabel(r.due_type)}</td>
              <td data-label="Faixa">${formatMoney(r.min_amount)} ${r.max_amount ? '– ' + formatMoney(r.max_amount) : '+'}</td>
              <td data-label="Períodos">${r.periods}x</td>
              <td data-label="Taxa" class="mono">${formatNumber(r.rate_percent, 1)}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    ${App.profile.is_primary_admin ? `
    <div class="card mt-20" style="border-color:var(--bad)">
      <h3 style="color:var(--bad)">Zona de risco</h3>
      <p class="text-sm text-soft mt-8">Esta ação apaga <strong>permanentemente</strong> todos os clientes, contratos, parcelas, pagamentos e notificações do sistema. Contas de administrador não são afetadas. Não há como desfazer.</p>
      <button class="btn btn-danger mt-14" id="wipe-data-btn">Apagar todos os dados do sistema</button>
    </div>` : ''}
  `;

  document.getElementById('cfg-save').onclick = async () => {
    const feedback = document.getElementById('cfg-feedback');
    feedback.innerHTML = '';
    const payload = {
      company_name: document.getElementById('cfg-company-name').value.trim(),
      company_whatsapp: document.getElementById('cfg-company-whatsapp').value.replace(/\D/g, '') || null,
      company_pix_key: document.getElementById('cfg-company-pix').value.trim() || null,
      critical_days_threshold: parseInt(document.getElementById('cfg-critical-days').value || '15', 10),
      loss_days_threshold: parseInt(document.getElementById('cfg-loss-days').value || '60', 10),
      default_exit_fee_percent: Number(document.getElementById('cfg-exit-fee').value || 0),
      default_entry_fee_percent: Number(document.getElementById('cfg-entry-fee').value || 0),
    };
    const { error } = await supa.from('system_settings').update(payload).eq('id', true);
    if (error) { feedback.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
    App.settings = { ...App.settings, ...payload };
    showToast('Configurações salvas.');
  };

  const wipeBtn = document.getElementById('wipe-data-btn');
  if (wipeBtn) wipeBtn.onclick = openWipeDataModal;
}

function openWipeDataModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:460px">
      <div class="modal-head"><h3 style="color:var(--bad)">Apagar todos os dados</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <p class="text-sm">Isso vai apagar <strong>permanentemente</strong>: todos os clientes, solicitações, contratos, parcelas, pagamentos, ciclos de renovação e notificações. Contas de administrador continuam intactas.</p>
        <p class="text-sm mt-8">Para confirmar, digite <strong>APAGAR TUDO</strong> no campo abaixo.</p>
        <div id="wipe-feedback"></div>
        <div class="field mt-8"><input type="text" id="wipe-confirm-text" placeholder="APAGAR TUDO"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-danger" id="confirm-wipe">Apagar tudo permanentemente</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  document.getElementById('confirm-wipe').onclick = async () => {
    const feedback = document.getElementById('wipe-feedback');
    feedback.innerHTML = '';
    if (document.getElementById('wipe-confirm-text').value.trim() !== 'APAGAR TUDO') {
      feedback.innerHTML = '<div class="auth-error">Digite exatamente "APAGAR TUDO" para confirmar.</div>';
      return;
    }
    const btn = document.getElementById('confirm-wipe');
    btn.disabled = true;
    try {
      const resp = await fetch('/api/wipe-all-data', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + App.session.access_token },
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Falha ao apagar os dados.');
      close();
      showToast(`Dados apagados. ${result.deleted_clients || 0} cliente(s) removido(s).`);
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
    }
  };
}

registerRoute('gerente/configuracoes', { role: 'gerente', screenId: 'gerente-configuracoes', title: 'Configurações', render: renderGerenteConfiguracoes });

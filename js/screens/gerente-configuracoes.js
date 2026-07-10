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
        <div class="field"><label>WhatsApp da empresa</label><input type="tel" id="cfg-company-whatsapp" placeholder="(00) 00000-0000" value="${escapeHtml(formatPhoneBR(settings.company_whatsapp || ''))}">
          <span class="help">Usado nas mensagens de cobrança e futuros contatos da empresa.</span>
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
          <label>Taxa de saída — percentual (%)</label>
          <input type="number" min="0" step="0.01" id="cfg-exit-fee" value="${settings.default_exit_fee_percent}">
        </div>
        <div class="field">
          <label>Taxa de saída — valor fixo (R$)</label>
          <input type="text" id="cfg-exit-fee-fixed" value="">
          <span class="help">Ex: 0,99. Somado à % — sobre o valor emprestado, ao criar um contrato.</span>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Taxa de entrada — percentual (%)</label>
          <input type="number" min="0" step="0.01" id="cfg-entry-fee" value="${settings.default_entry_fee_percent}">
        </div>
        <div class="field">
          <label>Taxa de entrada — valor fixo (R$)</label>
          <input type="text" id="cfg-entry-fee-fixed" value="">
          <span class="help">Ex: 0,99. Somado à % — sobre o valor recebido, ao quitar/renovar.</span>
        </div>
      </div>
    </div>

    <div id="cfg-feedback" class="mt-14"></div>
    <button class="btn btn-primary mt-8" id="cfg-save">Salvar configurações</button>

    <div class="card mt-20">
      <h3>Backup e exportação de dados</h3>
      <p class="text-sm text-soft mt-8">O backup baixa um arquivo .json com todos os dados do sistema (clientes, contratos, parcelas, pagamentos, solicitações) direto para este computador.</p>
      <div class="toggle-row mt-14"><label class="switch"><input type="checkbox" id="cfg-backup-toggle" ${settings.backup_auto_enabled ? 'checked' : ''}><span class="track"></span></label><span>Backup automático ao abrir o sistema</span></div>
      <div id="cfg-backup-fields" class="mt-14 ${settings.backup_auto_enabled ? '' : 'hidden'}">
        <div class="field-row">
          <div class="field">
            <label>Frequência</label>
            <select id="cfg-backup-frequency">
              <option value="diario" ${settings.backup_frequency === 'diario' ? 'selected' : ''}>Diário</option>
              <option value="semanal" ${settings.backup_frequency === 'semanal' ? 'selected' : ''}>Semanal</option>
              <option value="quinzenal" ${settings.backup_frequency === 'quinzenal' ? 'selected' : ''}>Quinzenal</option>
              <option value="mensal" ${settings.backup_frequency === 'mensal' ? 'selected' : ''}>Mensal</option>
              <option value="personalizado" ${settings.backup_frequency === 'personalizado' ? 'selected' : ''}>Personalizado</option>
            </select>
          </div>
          <div class="field ${settings.backup_frequency === 'personalizado' ? '' : 'hidden'}" id="cfg-backup-custom-field">
            <label>A cada quantos dias?</label>
            <input type="number" min="1" step="1" id="cfg-backup-custom-days" value="${settings.backup_custom_days || 7}">
          </div>
        </div>
        <span class="help">Verificado 1x por dia, no primeiro acesso ao sistema — se já tiver rodado no período, não baixa de novo.</span>
      </div>
      <div id="cfg-backup-feedback" class="mt-8"></div>
      <div class="flex gap-8 mt-14" style="flex-wrap:wrap">
        <button class="btn btn-primary" id="cfg-backup-save">Salvar backup automático</button>
        <button class="btn btn-outline" id="cfg-backup-now-btn">${Icons.printer} Fazer backup agora (.json)</button>
      </div>

      <h3 class="mt-20">Exportar dados</h3>
      <p class="text-sm text-soft mt-8">Exporta clientes, contratos, parcelas e pagamentos nos formatos abaixo.</p>
      <div class="field-row mt-14">
        <div class="field">
          <label>Formato</label>
          <select id="cfg-export-format">
            <option value="xlsx">Excel (.xlsx) — todas as tabelas</option>
            <option value="csv">CSV — uma tabela por vez</option>
            <option value="pdf">PDF — relatório Siges</option>
          </select>
        </div>
        <div class="field" id="cfg-export-table-field">
          <label>Tabela</label>
          <select id="cfg-export-table">
            ${Object.keys(BACKUP_TABLE_LABELS).map((k) => `<option value="${k}">${BACKUP_TABLE_LABELS[k]}</option>`).join('')}
          </select>
        </div>
      </div>
      <button class="btn btn-primary mt-8" id="cfg-export-btn">Exportar</button>
    </div>

    ${App.profile.is_primary_admin ? `
    <div class="card mt-20" style="border-color:var(--bad)">
      <h3 style="color:var(--bad)">Zona de risco</h3>
      <p class="text-sm text-soft mt-8">Esta ação apaga <strong>permanentemente</strong> todos os clientes, contratos, parcelas, pagamentos e notificações do sistema. Contas de administrador não são afetadas. Não há como desfazer.</p>
      <button class="btn btn-danger mt-14" id="wipe-data-btn">Apagar todos os dados do sistema</button>
    </div>` : ''}
  `;

  attachPhoneMask(document.getElementById('cfg-company-whatsapp'));
  setMoneyValue(document.getElementById('cfg-exit-fee-fixed'), settings.default_exit_fee_fixed);
  setMoneyValue(document.getElementById('cfg-entry-fee-fixed'), settings.default_entry_fee_fixed);
  attachMoneyMask(document.getElementById('cfg-exit-fee-fixed'));
  attachMoneyMask(document.getElementById('cfg-entry-fee-fixed'));

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
      default_exit_fee_fixed: getMoneyValue(document.getElementById('cfg-exit-fee-fixed')),
      default_entry_fee_percent: Number(document.getElementById('cfg-entry-fee').value || 0),
      default_entry_fee_fixed: getMoneyValue(document.getElementById('cfg-entry-fee-fixed')),
      backup_auto_enabled: document.getElementById('cfg-backup-toggle').checked,
      backup_frequency: document.getElementById('cfg-backup-frequency').value,
      backup_custom_days: parseInt(document.getElementById('cfg-backup-custom-days').value || '7', 10),
    };
    const { error } = await supa.from('system_settings').update(payload).eq('id', true);
    if (error) { feedback.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
    App.settings = { ...App.settings, ...payload };
    showToast('Configurações salvas.');
  };

  const backupToggle = document.getElementById('cfg-backup-toggle');
  backupToggle.onchange = () => document.getElementById('cfg-backup-fields').classList.toggle('hidden', !backupToggle.checked);
  document.getElementById('cfg-backup-frequency').onchange = (e) => {
    document.getElementById('cfg-backup-custom-field').classList.toggle('hidden', e.target.value !== 'personalizado');
  };
  document.getElementById('cfg-backup-save').onclick = async (e) => {
    const btn = e.currentTarget;
    const feedback = document.getElementById('cfg-backup-feedback');
    feedback.innerHTML = '';
    btn.disabled = true;
    const payload = {
      backup_auto_enabled: backupToggle.checked,
      backup_frequency: document.getElementById('cfg-backup-frequency').value,
      backup_custom_days: parseInt(document.getElementById('cfg-backup-custom-days').value || '7', 10),
    };
    const { error } = await supa.from('system_settings').update(payload).eq('id', true);
    btn.disabled = false;
    if (error) { feedback.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
    App.settings = { ...App.settings, ...payload };
    showToast('Backup automático salvo.');
  };
  document.getElementById('cfg-backup-now-btn').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await runBackupJSON(false); } finally { btn.disabled = false; }
  };

  const exportFormatSelect = document.getElementById('cfg-export-format');
  const toggleExportTableField = () => document.getElementById('cfg-export-table-field').classList.toggle('hidden', exportFormatSelect.value !== 'csv');
  exportFormatSelect.onchange = toggleExportTableField;
  toggleExportTableField();
  document.getElementById('cfg-export-btn').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const format = exportFormatSelect.value;
      if (format === 'xlsx') await runExportXLSX();
      else if (format === 'csv') await runExportCSV(document.getElementById('cfg-export-table').value);
      else await runExportPDF();
      showToast('Exportação concluída.');
    } catch (e2) {
      showToast('Erro ao exportar: ' + (e2.message || String(e2)));
    } finally {
      btn.disabled = false;
    }
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

registerRoute('gerente/configuracoes', { role: 'gerente', primaryOnly: true, screenId: 'gerente-configuracoes', title: 'Configurações', render: renderGerenteConfiguracoes });

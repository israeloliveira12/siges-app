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
      <h3>Taxa operacional padrão</h3>
      <p class="text-sm text-soft mt-8">Usada como sugestão inicial ao criar um contrato novo (sempre editável).</p>
      <div class="field mt-14"><label>Taxa operacional padrão (%)</label><input type="number" min="0" step="0.01" id="cfg-default-fee" value="${settings.default_operational_fee_percent}"></div>
    </div>

    <div id="cfg-feedback" class="mt-14"></div>
    <button class="btn btn-primary mt-8" id="cfg-save">Salvar configurações</button>

    <div class="card mt-20">
      <h3>Tabela de referência de taxas (Tabela VIP)</h3>
      <p class="text-sm text-soft mt-8">Usada só como sugestão visual ao criar contratos — nunca trava o valor digitado pelo gerente.</p>
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
  `;

  document.getElementById('cfg-save').onclick = async () => {
    const feedback = document.getElementById('cfg-feedback');
    feedback.innerHTML = '';
    const payload = {
      company_name: document.getElementById('cfg-company-name').value.trim(),
      critical_days_threshold: parseInt(document.getElementById('cfg-critical-days').value || '15', 10),
      loss_days_threshold: parseInt(document.getElementById('cfg-loss-days').value || '60', 10),
      default_operational_fee_percent: Number(document.getElementById('cfg-default-fee').value || 0),
    };
    const { error } = await supa.from('system_settings').update(payload).eq('id', true);
    if (error) { feedback.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
    App.settings = { ...App.settings, ...payload };
    showToast('Configurações salvas.');
  };
}

registerRoute('gerente/configuracoes', { role: 'gerente', screenId: 'gerente-configuracoes', title: 'Configurações', render: renderGerenteConfiguracoes });

/* ============================================================================
   Plataforma SaaS — Configurações da Plataforma. Dados globais do SaaS EM
   SI (contato de suporte, mensagem de boas-vindas, dias de trial padrão) —
   diferente de Configurações (gerente/configuracoes), que é por-empresa.
   ============================================================================ */

async function renderPlataformaConfiguracoes() {
  const root = document.getElementById('screen-plataforma-configuracoes');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const { data, error } = await supa.rpc('get_platform_settings');
  if (error) { root.innerHTML = `<div class="card"><p class="auth-error">Não foi possível carregar as configurações agora. Recarregue a página ou tente novamente em instantes.</p></div>`; return; }

  paintPlataformaConfiguracoes(root, data || {});
}

function paintPlataformaConfiguracoes(root, s) {
  root.innerHTML = `
    <div class="card" style="max-width:560px">
      <h3>Contato de suporte</h3>
      <p class="text-sm text-soft">Usado internamente pra você lembrar o canal de contato oficial da plataforma — não aparece pros clientes finais de nenhuma empresa assinante.</p>
      <div class="field mt-14"><label>E-mail de suporte</label><input type="email" id="pc-support-email" value="${escapeHtml(s.support_email || '')}"></div>
      <div class="field"><label>Telefone/WhatsApp de suporte</label><input type="text" id="pc-support-phone" value="${escapeHtml(s.support_phone || '')}"></div>

      <h3 class="mt-20">Cadastro de novas empresas</h3>
      <div class="field"><label>Mensagem de boas-vindas</label><textarea id="pc-welcome-message" rows="3" placeholder="Mostrada como referência ao criar uma empresa nova (opcional)">${escapeHtml(s.welcome_message || '')}</textarea></div>
      <div class="field"><label>Dias de teste grátis padrão (sugestão)</label><input type="number" min="1" step="1" id="pc-default-trial-days" placeholder="Sem sugestão" value="${s.default_trial_days ? s.default_trial_days : ''}">
        <span class="help">Só um lembrete pra você mesmo — não aplica trial automaticamente em nenhum plano. Configure o trial de cada plano em Planos.</span>
      </div>

      <div id="pc-feedback" class="mt-14"></div>
      <button class="btn btn-primary mt-8" id="pc-save">Salvar configurações</button>
    </div>
  `;

  document.getElementById('pc-save').onclick = async (e) => {
    const feedback = document.getElementById('pc-feedback');
    feedback.innerHTML = '';
    const trialRaw = document.getElementById('pc-default-trial-days').value.trim();
    if (trialRaw !== '' && (!/^\d+$/.test(trialRaw) || Number(trialRaw) <= 0)) {
      feedback.innerHTML = '<div class="auth-error">Dias de teste padrão deve ser um número maior que zero, ou em branco.</div>';
      return;
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    const { error } = await supa.rpc('update_platform_settings', {
      p_support_email: document.getElementById('pc-support-email').value.trim() || null,
      p_support_phone: document.getElementById('pc-support-phone').value.trim() || null,
      p_welcome_message: document.getElementById('pc-welcome-message').value.trim() || null,
      p_default_trial_days: trialRaw === '' ? null : Number(trialRaw),
    });
    btn.disabled = false;
    if (error) { feedback.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
    logAudit('config_plataforma_editada', 'Configurações da plataforma editadas', {});
    showToast('Configurações salvas.');
  };
}

registerRoute('plataforma/configuracoes', { role: 'plataforma', screenId: 'plataforma-configuracoes', title: 'Configurações da Plataforma', render: renderPlataformaConfiguracoes });

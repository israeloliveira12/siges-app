/* ============================================================================
   Plataforma SaaS — Planos (Fase 5). Planos configuráveis manualmente pelo
   Administrador Master — nome/preço/descrição livres, mais um conjunto de
   limites/recursos (jsonb) que ele liga/desliga por plano. Sem cobrança
   nenhuma envolvida ainda (isso é uma fase futura) — só o desenho de quais
   limites cada empresa tem, atribuído a cada uma na tela "Empresas".
   ============================================================================ */

// Chaves de limite conhecidas hoje — adicionar uma nova no futuro é só uma
// entrada nova aqui + tratamento no ponto de checagem (nenhuma migration).
const PLAN_LIMIT_FIELDS = [
  // O Administrador (dono da conta) nunca entra nessa conta — sempre existe
  // 1, à parte, garantido pra toda empresa. Esse limite é só sobre contas
  // de Gerente adicionais que o Administrador cria (2026-08-11, correção de
  // um bug real: a contagem antes somava os dois juntos, então um plano
  // com "1 gerente" já nascia sem nenhuma vaga sobrando pro Administrador
  // criar um gerente de verdade).
  { key: 'max_gerentes', label: 'Máximo de gerentes', type: 'number', help: 'O Administrador (dono da conta) nunca entra nessa conta — sempre existe 1, à parte. Esse limite é só sobre gerentes adicionais.' },
  { key: 'max_clientes', label: 'Máximo de clientes', type: 'number' },
  { key: 'allow_extrato_pdf', label: 'Gerar extrato em PDF', type: 'boolean' },
  { key: 'allow_promissoria_pdf', label: 'Gerar nota promissória em PDF', type: 'boolean' },
  { key: 'allow_backup_export', label: 'Backup e exportação de dados', type: 'boolean' },
];

let plansCache = [];

async function renderPlataformaPlanos() {
  const root = document.getElementById('screen-plataforma-planos');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const { data, error } = await supa.rpc('list_plans');
  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
  plansCache = data || [];

  paintPlataformaPlanos(root);
}

function planLimitSummary(limits) {
  const parts = [];
  const l = limits || {};
  // "1 administrador +" sempre na frente — o Administrador é fixo, nunca
  // entra na conta de max_gerentes (mesmo raciocínio já aplicado na
  // listagem de Empresas). Sem isso, o card do plano parecia dizer que "1
  // gerente" era o total de gente da empresa inteira.
  parts.push(typeof l.max_gerentes === 'number' ? `1 administrador + ${l.max_gerentes} gerente${l.max_gerentes === 1 ? '' : 's'}` : '1 administrador + gerentes ilimitados');
  parts.push(typeof l.max_clientes === 'number' ? `${l.max_clientes} cliente${l.max_clientes === 1 ? '' : 's'}` : 'Clientes ilimitados');
  const recursos = PLAN_LIMIT_FIELDS.filter((f) => f.type === 'boolean' && l[f.key] !== false).map((f) => f.label);
  if (recursos.length) parts.push(recursos.join(', '));
  return parts.join(' · ');
}

function paintPlataformaPlanos(root) {
  root.innerHTML = `
    <div class="flex justify-between items-center">
      <p class="text-sm text-soft">${plansCache.length} plano${plansCache.length === 1 ? '' : 's'} cadastrado${plansCache.length === 1 ? '' : 's'}.</p>
      <button class="btn btn-primary" id="novo-plano-btn">${Icons.plus} Novo plano</button>
    </div>
    <div class="mt-14">
      ${plansCache.map((p) => `
        <div class="extrato-row">
          <div style="min-width:0;flex:1 1 auto">
            <div class="name">${escapeHtml(p.name)}${p.price_monthly != null ? ` <span class="text-soft text-sm">— ${p.price_monthly === 0 ? 'Grátis' : formatMoney(p.price_monthly) + '/mês'}</span>` : ''}</div>
            <div class="meta">${escapeHtml(planLimitSummary(p.limits))}${p.trial_days ? ` · ${p.trial_days} dia${p.trial_days === 1 ? '' : 's'} de teste grátis` : ''}</div>
          </div>
          <div class="amt-wrap">
            <div class="flex gap-8 items-center" style="justify-content:flex-end;flex-wrap:wrap">
              ${p.active ? statusBadge('quitado', 'Ativo') : statusBadge('reprovada', 'Inativo')}
              <button class="icon-btn edit-plan-btn" data-id="${p.id}">${Icons.edit}</button>
            </div>
          </div>
        </div>
      `).join('')}
      ${!plansCache.length ? '<p class="text-sm text-soft">Nenhum plano cadastrado ainda — empresas sem plano atribuído não têm nenhum limite.</p>' : ''}
    </div>
  `;

  document.getElementById('novo-plano-btn').onclick = () => openPlanoModal(null);
  root.querySelectorAll('.edit-plan-btn').forEach((btn) => {
    btn.onclick = () => openPlanoModal(plansCache.find((p) => p.id === btn.dataset.id));
  });
}

function planoLimitFieldsHtml(limits) {
  const l = limits || {};
  return PLAN_LIMIT_FIELDS.map((f) => {
    if (f.type === 'number') {
      const val = typeof l[f.key] === 'number' ? l[f.key] : '';
      return `
        <div class="field">
          <label>${f.label}</label>
          <input type="number" min="0" step="1" id="pf-${f.key}" placeholder="Ilimitado" value="${val}">
          ${f.help ? `<span class="help">${f.help}</span>` : ''}
        </div>`;
    }
    const checked = l[f.key] !== false; // ausente ou true = liberado
    return `
      <div class="toggle-row">
        <label class="switch"><input type="checkbox" id="pf-${f.key}" ${checked ? 'checked' : ''}><span class="track"></span></label>
        <span>${f.label}</span>
      </div>`;
  }).join('');
}

function collectPlanLimitsFromForm(overlay) {
  const limits = {};
  PLAN_LIMIT_FIELDS.forEach((f) => {
    const el = overlay.querySelector(`#pf-${f.key}`);
    if (f.type === 'number') {
      const raw = el.value.trim();
      if (raw !== '') limits[f.key] = Math.max(0, parseInt(raw, 10) || 0);
    } else {
      limits[f.key] = el.checked;
    }
  });
  return limits;
}

function openPlanoModal(plan) {
  const isEdit = !!plan;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:460px">
      <div class="modal-head"><h3>${isEdit ? 'Editar plano' : 'Novo plano'}</h3><button class="icon-btn" id="pm-close">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="pm-feedback"></div>
        <div class="field"><label>Nome do plano</label><input type="text" id="pf-name" value="${escapeHtml((plan && plan.name) || '')}" placeholder="Ex: Basic"></div>
        <div class="field"><label>Descrição</label><input type="text" id="pf-description" value="${escapeHtml((plan && plan.description) || '')}" placeholder="Opcional"></div>
        <div class="field"><label>Preço mensal (R$)</label><input type="text" id="pf-price" value="">
          <span class="help">Deixe em branco se ainda não define preço. Digite 0 pra um plano Grátis. Só informativo, sem cobrança automática.</span>
        </div>
        <div class="field"><label>Dias de teste grátis (trial)</label><input type="number" min="1" step="1" id="pf-trial-days" placeholder="Sem teste" value="${plan && plan.trial_days ? plan.trial_days : ''}">
          <span class="help">Quando uma empresa é atribuída a este plano, ela ganha esse número de dias antes de precisar virar pagante de verdade. Deixe em branco pra não ter teste (cobrança/atribuição normal desde o dia 1).</span>
        </div>
        <div class="toggle-row">
          <label class="switch"><input type="checkbox" id="pf-active" ${!plan || plan.active ? 'checked' : ''}><span class="track"></span></label>
          <span>Plano ativo (disponível pra atribuir a uma empresa)</span>
        </div>
        <h4 class="mt-14">Limites e recursos</h4>
        <p class="text-sm text-soft">Deixe os campos numéricos em branco pra "ilimitado". Empresas sem nenhum plano atribuído também ficam sem limite nenhum.</p>
        ${planoLimitFieldsHtml(plan && plan.limits)}
      </div>
      <div class="modal-foot" style="justify-content:space-between">
        ${isEdit ? `<button class="btn btn-ghost" id="pm-delete" style="color:var(--bad)">Excluir plano</button>` : '<span></span>'}
        <div class="flex gap-8">
          <button class="btn btn-ghost" id="pm-cancel">Cancelar</button>
          <button class="btn btn-primary" id="pm-save">${isEdit ? 'Salvar alterações' : 'Criar plano'}</button>
        </div>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#pm-close').onclick = close;
  overlay.querySelector('#pm-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const priceInput = overlay.querySelector('#pf-price');
  setMoneyValue(priceInput, plan && plan.price_monthly);
  attachMoneyMask(priceInput);

  const deleteBtn = overlay.querySelector('#pm-delete');
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      const feedback = overlay.querySelector('#pm-feedback');
      feedback.innerHTML = '<p class="text-sm text-soft">Clique de novo para confirmar a exclusão.</p>';
      if (!deleteBtn.dataset.confirm) { deleteBtn.dataset.confirm = '1'; return; }
      deleteBtn.disabled = true;
      const { error } = await supa.rpc('delete_plan', { p_id: plan.id });
      if (error) { feedback.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; deleteBtn.disabled = false; return; }
      logAudit('plano_excluido', `Plano ${plan.name} excluído`, { plan_id: plan.id });
      close();
      showToast('Plano excluído. Empresas que o usavam ficaram sem plano (sem limite).');
      renderPlataformaPlanos();
    };
  }

  overlay.querySelector('#pm-save').onclick = async () => {
    const feedback = overlay.querySelector('#pm-feedback');
    feedback.innerHTML = '';
    const name = overlay.querySelector('#pf-name').value.trim();
    if (!name) { feedback.innerHTML = '<div class="auth-error">Informe o nome do plano.</div>'; return; }

    const trialRaw = overlay.querySelector('#pf-trial-days').value.trim();
    if (trialRaw !== '' && (!/^\d+$/.test(trialRaw) || Number(trialRaw) <= 0)) {
      feedback.innerHTML = '<div class="auth-error">Dias de teste grátis deve ser um número maior que zero, ou em branco.</div>';
      return;
    }

    const btn = overlay.querySelector('#pm-save');
    btn.disabled = true;
    try {
      const { error } = await supa.rpc('upsert_plan', {
        p_id: plan ? plan.id : null,
        p_name: name,
        p_description: overlay.querySelector('#pf-description').value.trim() || null,
        // getMoneyValue() não distingue "campo vazio" de "digitou 0" (as duas
        // coisas retornam 0) — checar o texto bruto do input preserva um
        // plano Grátis (preço 0 de verdade) sem virar "sem preço definido".
        p_price_monthly: priceInput.value.trim() === '' ? null : getMoneyValue(priceInput),
        p_active: overlay.querySelector('#pf-active').checked,
        p_sort_order: plan ? plan.sort_order : plansCache.length,
        p_limits: collectPlanLimitsFromForm(overlay),
        p_trial_days: trialRaw === '' ? null : Number(trialRaw),
      });
      if (error) throw error;
      logAudit(isEdit ? 'plano_editado' : 'plano_criado', `Plano ${name} ${isEdit ? 'editado' : 'criado'}`, {});
      close();
      showToast(isEdit ? 'Plano atualizado.' : 'Plano criado.');
      renderPlataformaPlanos();
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message || String(e))}</div>`;
      btn.disabled = false;
    }
  };
}

registerRoute('plataforma/planos', { role: 'plataforma', screenId: 'plataforma-planos', title: 'Planos', render: renderPlataformaPlanos });

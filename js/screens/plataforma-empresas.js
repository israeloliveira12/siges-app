/* ============================================================================
   Plataforma SaaS — Empresas (Fase 3). Gestão manual de tenants: criar uma
   empresa nova (+ sua primeira conta de administrador), renomear, suspender/
   reativar. Sem cobrança nenhuma envolvida ainda (isso é Fase 5) — exclusiva
   do Administrador Master (platform_owner), reforçado em RLS/RPC, não só na
   UI (ver migration_036.sql).
   ============================================================================ */

let tenantsCache = [];
let plansForAssignCache = [];

async function renderPlataformaEmpresas() {
  const root = document.getElementById('screen-plataforma-empresas');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const [{ data, error }, { data: plansData }] = await Promise.all([
    supa.rpc('list_tenants_with_stats'),
    supa.rpc('list_plans'),
  ]);
  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
  tenantsCache = data || [];
  plansForAssignCache = plansData || [];

  paintPlataformaEmpresas(root);
}

function paintPlataformaEmpresas(root) {
  const myTenantId = App.profile && App.profile.tenant_id;

  root.innerHTML = `
    <div class="flex justify-between items-center">
      <p class="text-sm text-soft">${tenantsCache.length} empresa${tenantsCache.length === 1 ? '' : 's'} na plataforma.</p>
      <button class="btn btn-primary" id="nova-empresa-btn">${Icons.plus} Nova empresa</button>
    </div>
    <div class="mt-14">
      ${tenantsCache.map((t) => `
        <div class="extrato-row">
          ${avatarHtml(t.name, 34)}
          <div style="min-width:0;flex:1 1 auto">
            <div class="name">${escapeHtml(t.name || '—')}${t.id === myTenantId ? ' <span class="text-soft text-sm">(sua empresa)</span>' : ''}</div>
            <div class="meta">${escapeHtml(t.admin_name || t.admin_email || 'sem administrador')} · ${t.gerente_count} gerente${Number(t.gerente_count) === 1 ? '' : 's'} · ${t.cliente_count} cliente${Number(t.cliente_count) === 1 ? '' : 's'} · ${t.contract_count} contrato${Number(t.contract_count) === 1 ? '' : 's'} · Plano: ${escapeHtml(t.plan_name || 'sem plano (ilimitado)')} · Criada em ${formatDate(t.created_at)}</div>
          </div>
          <div class="amt-wrap">
            <div class="flex gap-8 items-center" style="justify-content:flex-end;flex-wrap:wrap">
              ${t.active ? statusBadge('quitado', 'Ativa') : statusBadge('reprovada', 'Suspensa')}
              <button class="icon-btn edit-tenant-btn" data-id="${t.id}">${Icons.edit}</button>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  document.getElementById('nova-empresa-btn').onclick = openNovaEmpresaModal;
  root.querySelectorAll('.edit-tenant-btn').forEach((btn) => {
    btn.onclick = () => openEditEmpresaModal(tenantsCache.find((t) => t.id === btn.dataset.id));
  });
}

function openNovaEmpresaModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:440px">
      <div class="modal-head"><h3>Nova empresa</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="ne-feedback"></div>
        <div class="field"><label>Nome da empresa</label><input type="text" id="ne-company-name"></div>
        <p class="text-sm text-soft mt-8">A conta abaixo será o administrador dessa empresa — terá acesso total ao universo dela (clientes, contratos, relatórios), sem ver nada de nenhuma outra empresa da plataforma.</p>
        <div class="field"><label>Nome do administrador</label><input type="text" id="ne-admin-name"></div>
        <div class="field"><label>E-mail do administrador</label><input type="email" id="ne-admin-email"></div>
        <div class="field"><label>Senha inicial</label>${passwordFieldHtml('ne-admin-password', 'minlength="6"')}</div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-primary" id="save-modal">Criar empresa</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  wirePasswordToggles(overlay);

  document.getElementById('save-modal').onclick = async () => {
    const feedback = document.getElementById('ne-feedback');
    feedback.innerHTML = '';
    const companyName = document.getElementById('ne-company-name').value.trim();
    const adminName = document.getElementById('ne-admin-name').value.trim();
    const adminEmail = document.getElementById('ne-admin-email').value.trim();
    const adminPassword = document.getElementById('ne-admin-password').value;
    if (!companyName || !adminEmail || adminPassword.length < 6) {
      feedback.innerHTML = '<div class="auth-error">Preencha o nome da empresa, e-mail e senha (mín. 6 caracteres) do administrador.</div>';
      return;
    }

    const btn = document.getElementById('save-modal');
    btn.disabled = true;
    try {
      const resp = await fetch('/api/create-tenant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + App.session.access_token },
        body: JSON.stringify({ company_name: companyName, admin_full_name: adminName, admin_email: adminEmail, admin_password: adminPassword }),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Falha ao criar a empresa.');
      logAudit('empresa_criada', `Empresa ${companyName} criada`, { tenant_id: result.tenant_id, admin_user_id: result.admin_user_id });
      close();
      showToast('Empresa criada com sucesso.');
      renderPlataformaEmpresas();
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
    }
  };
}

function openEditEmpresaModal(tenant) {
  const isOwnTenant = tenant.id === (App.profile && App.profile.tenant_id);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>Editar empresa</h3><button class="icon-btn" id="ee-close">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="ee-feedback"></div>
        <div class="field"><label>Nome da empresa</label><input type="text" id="ee-name" value="${escapeHtml(tenant.name || '')}"></div>
        <div class="toggle-row">
          <label class="switch"><input type="checkbox" id="ee-active" ${tenant.active ? 'checked' : ''} ${isOwnTenant ? 'disabled' : ''}><span class="track"></span></label>
          <span>Empresa ativa${isOwnTenant ? ' (sua própria empresa não pode ser suspensa por aqui)' : ''}</span>
        </div>
        ${!tenant.active ? '<p class="text-sm text-soft mt-8">Empresa suspensa: nenhum administrador ou cliente dela consegue entrar no sistema até reativar.</p>' : ''}
        <div class="field">
          <label>Plano</label>
          <select id="ee-plan">
            <option value="">Sem plano (ilimitado)</option>
            ${plansForAssignCache.map((p) => `<option value="${p.id}" ${tenant.plan_id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px;background:var(--bg)">
          <label>Link de convite</label>
          <div class="flex gap-8 mt-8" style="align-items:center">
            <input type="text" id="ee-invite-link" readonly value="${escapeHtml(location.origin + '/?convite=' + (tenant.invite_token || ''))}">
            <button type="button" class="btn btn-outline btn-sm" id="ee-invite-copy" style="flex:none">Copiar</button>
          </div>
          <button type="button" class="btn btn-ghost btn-sm mt-8" id="ee-invite-regenerate">Gerar novo link</button>
          <div id="ee-invite-feedback" class="mt-8"></div>
        </div>
        ${!isOwnTenant && !tenant.active ? `
        <div class="field mt-14" style="border:1px solid var(--bad);border-radius:var(--radius-sm);padding:10px 12px">
          <label style="color:var(--bad)">Zona de risco</label>
          <p class="text-sm text-soft mt-8">Apaga a empresa por completo — clientes, contratos, contas de administrador, tudo. Não tem como desfazer.</p>
          <button type="button" class="btn btn-danger btn-sm mt-8" id="ee-delete-tenant">Excluir empresa</button>
        </div>` : ''}
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="ee-cancel">Cancelar</button>
        <button class="btn btn-primary" id="ee-save">Salvar alterações</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#ee-close').onclick = close;
  overlay.querySelector('#ee-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  overlay.querySelector('#ee-invite-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(overlay.querySelector('#ee-invite-link').value);
      showToast('Link copiado.');
    } catch (e) {
      overlay.querySelector('#ee-invite-feedback').innerHTML = '<div class="auth-error">Não foi possível copiar automaticamente — selecione e copie manualmente.</div>';
    }
  };
  overlay.querySelector('#ee-invite-regenerate').onclick = async () => {
    const feedback = overlay.querySelector('#ee-invite-feedback');
    const btn = overlay.querySelector('#ee-invite-regenerate');
    feedback.innerHTML = '';
    btn.disabled = true;
    try {
      const { data: newToken, error: regenError } = await supa.rpc('regenerate_tenant_invite_token', { p_tenant_id: tenant.id });
      if (regenError) throw regenError;
      overlay.querySelector('#ee-invite-link').value = `${location.origin}/?convite=${newToken}`;
      tenant.invite_token = newToken;
      showToast('Novo link de convite gerado.');
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message || String(e))}</div>`;
    } finally {
      btn.disabled = false;
    }
  };

  const deleteBtn = overlay.querySelector('#ee-delete-tenant');
  if (deleteBtn) {
    deleteBtn.onclick = () => openDeleteEmpresaModal(tenant, close);
  }

  overlay.querySelector('#ee-save').onclick = async () => {
    const feedback = overlay.querySelector('#ee-feedback');
    feedback.innerHTML = '';
    const btn = overlay.querySelector('#ee-save');
    btn.disabled = true;
    try {
      const { error } = await supa.rpc('update_tenant', {
        p_tenant_id: tenant.id,
        p_name: overlay.querySelector('#ee-name').value.trim(),
        p_active: isOwnTenant ? true : overlay.querySelector('#ee-active').checked,
      });
      if (error) throw error;

      const newPlanId = overlay.querySelector('#ee-plan').value || null;
      if (newPlanId !== tenant.plan_id) {
        const { error: planError } = await supa.rpc('assign_tenant_plan', { p_tenant_id: tenant.id, p_plan_id: newPlanId });
        if (planError) throw planError;
      }

      logAudit('empresa_editada', `Empresa ${tenant.name} editada`, { tenant_id: tenant.id });
      close();
      showToast('Empresa atualizada.');
      renderPlataformaEmpresas();
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message || String(e))}</div>`;
      btn.disabled = false;
    }
  };
}

// Confirmação forte de exclusão — exige digitar o nome exato da empresa
// (mesmo princípio da Zona de risco de Configurações, que exige digitar
// "APAGAR TUDO"). closeParentModal fecha o modal "Editar empresa" por trás
// também, já que a empresa deixou de existir.
function openDeleteEmpresaModal(tenant, closeParentModal) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3 style="color:var(--bad)">Excluir empresa</h3><button class="icon-btn" id="de-close">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="de-feedback"></div>
        <p class="text-sm">Isso apaga <strong>permanentemente</strong> a empresa "${escapeHtml(tenant.name)}" — todos os clientes, contratos, parcelas, pagamentos e as contas de administrador dela. Não há como desfazer.</p>
        <div class="field mt-14">
          <label>Digite <strong>${escapeHtml(tenant.name)}</strong> para confirmar</label>
          <input type="text" id="de-confirm-name">
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="de-cancel">Cancelar</button>
        <button class="btn btn-danger" id="de-confirm" disabled>Excluir empresa</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#de-close').onclick = close;
  overlay.querySelector('#de-cancel').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const confirmInput = overlay.querySelector('#de-confirm-name');
  const confirmBtn = overlay.querySelector('#de-confirm');
  confirmInput.oninput = () => { confirmBtn.disabled = confirmInput.value.trim() !== tenant.name; };

  confirmBtn.onclick = async () => {
    const feedback = overlay.querySelector('#de-feedback');
    feedback.innerHTML = '';
    confirmBtn.disabled = true;
    try {
      const resp = await fetch('/api/delete-tenant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + App.session.access_token },
        body: JSON.stringify({ tenant_id: tenant.id }),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Falha ao excluir a empresa.');
      logAudit('empresa_excluida', `Empresa ${tenant.name} excluída`, { tenant_id: tenant.id });
      close();
      if (closeParentModal) closeParentModal();
      showToast('Empresa excluída.');
      renderPlataformaEmpresas();
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message || String(e))}</div>`;
      confirmBtn.disabled = false;
    }
  };
}

registerRoute('plataforma/empresas', { role: 'plataforma', screenId: 'plataforma-empresas', title: 'Empresas', render: renderPlataformaEmpresas });

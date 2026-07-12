/* ============================================================================
   Administradores — gestão de contas. Só o admin primário ("Administrador")
   pode criar/editar contas de gerente — os demais só visualizam a lista
   (2026-07-11, decisão explícita do usuário).
   ============================================================================ */

let gerentesCache = [];

async function renderGerenteGerentes() {
  const root = document.getElementById('screen-gerente-gerentes');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;
  const isPrimary = !!(App.profile && App.profile.is_primary_admin);

  const { data, error } = await supa.from('profiles').select('*').eq('role', 'gerente').order('created_at');
  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
  gerentesCache = data || [];

  root.innerHTML = `
    <div class="flex justify-between items-center">
      <p class="text-sm text-soft">${isPrimary ? 'Contas de gerente têm acesso operacional ao sistema (sem Planejamento/Configurações). Só crie para pessoas de confiança da equipe.' : 'Só o Administrador pode criar, editar ou excluir contas desta lista.'}</p>
      ${isPrimary ? `<button class="btn btn-primary" id="novo-gerente-btn">${Icons.userPlus} Novo Gerente</button>` : ''}
    </div>
    <div class="card mt-14" style="padding:0">
      <table class="data-table table-scroll">
        <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Status</th><th>Criado em</th>${isPrimary ? '<th></th>' : ''}</tr></thead>
        <tbody>
          ${gerentesCache.map((g) => `
            <tr>
              <td data-label="Nome"><div class="flex items-center gap-8">${avatarHtml(g.full_name, 28)}<span>${escapeHtml(g.full_name || '—')}</span></div></td>
              <td data-label="E-mail">${escapeHtml(g.email)}</td>
              <td data-label="Papel">${g.is_primary_admin ? '<span class="badge badge-brand">Administrador</span>' : '<span class="badge badge-neutral">Gerente</span>'}</td>
              <td data-label="Status">${g.active ? statusBadge('quitado', 'Ativo') : statusBadge('reprovada', 'Inativo')}</td>
              <td data-label="Criado em">${formatDate(g.created_at)}</td>
              ${isPrimary ? `<td data-label=""><button class="icon-btn edit-gerente-btn" data-id="${g.id}">${Icons.edit}</button></td>` : ''}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  if (isPrimary) {
    document.getElementById('novo-gerente-btn').onclick = openNovoGerenteModal;
    root.querySelectorAll('.edit-gerente-btn').forEach((btn) => {
      btn.onclick = () => openEditGerenteModal(gerentesCache.find((g) => g.id === btn.dataset.id));
    });
  }
}

function openEditGerenteModal(gerente) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>Editar gerente</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="eg-feedback"></div>
        <div class="field"><label>Nome completo</label><input type="text" id="eg-name" value="${escapeHtml(gerente.full_name || '')}"></div>
        <div class="field"><label>E-mail (login)</label><input type="email" id="eg-email" value="${escapeHtml(gerente.email || '')}"></div>
        <div class="field"><label>Telefone</label><input type="tel" id="eg-phone" placeholder="(00) 00000-0000" value="${escapeHtml(formatPhoneBR(gerente.phone || ''))}"></div>
        <div class="toggle-row">
          <label class="switch"><input type="checkbox" id="eg-active" ${gerente.active ? 'checked' : ''} ${gerente.is_primary_admin ? 'disabled' : ''}><span class="track"></span></label>
          <span>Conta ativa${gerente.is_primary_admin ? ' (o Administrador não pode ser desativado por aqui)' : ''}</span>
        </div>
        <div class="field" style="border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px;background:var(--bg)">
          <label>Redefinir senha</label>
          <div class="flex gap-8 mt-8" style="align-items:flex-start">
            <div style="flex:1">${passwordFieldHtml('eg-reset-password', 'minlength="6" placeholder="Nova senha (mín. 6 caracteres)"')}</div>
            <button type="button" class="btn btn-outline btn-sm" id="eg-reset-password-btn" style="flex:none">Redefinir</button>
          </div>
          <div id="eg-reset-password-feedback" class="mt-8"></div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-primary" id="save-modal">Salvar alterações</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  attachPhoneMask(document.getElementById('eg-phone'));
  wirePasswordToggles(overlay);

  document.getElementById('eg-reset-password-btn').onclick = async () => {
    const feedback = document.getElementById('eg-reset-password-feedback');
    const input = document.getElementById('eg-reset-password');
    const newPassword = input.value;
    feedback.innerHTML = '';
    if (newPassword.length < 6) { feedback.innerHTML = `<div class="auth-error">A senha precisa ter pelo menos 6 caracteres.</div>`; return; }
    const btn = document.getElementById('eg-reset-password-btn');
    btn.disabled = true;
    try {
      const resp = await fetch('/api/reset-client-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + App.session.access_token },
        body: JSON.stringify({ user_id: gerente.id, new_password: newPassword }),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Falha ao redefinir a senha.');
      logAudit('senha_redefinida', `Senha redefinida para o gerente ${gerente.full_name || gerente.email}`, { gerente_id: gerente.id });
      input.value = '';
      feedback.innerHTML = `<div class="auth-success">Senha redefinida com sucesso.</div>`;
      showToast('Senha do gerente redefinida.');
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message || String(e))}</div>`;
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('save-modal').onclick = async () => {
    const feedback = document.getElementById('eg-feedback');
    feedback.innerHTML = '';
    const btn = document.getElementById('save-modal');
    btn.disabled = true;
    try {
      const newEmail = document.getElementById('eg-email').value.trim().toLowerCase();
      if (newEmail && newEmail !== (gerente.email || '').toLowerCase()) {
        const resp = await fetch('/api/update-user-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + App.session.access_token },
          body: JSON.stringify({ user_id: gerente.id, new_email: newEmail }),
        });
        const result = await resp.json();
        if (!resp.ok) throw new Error(result.error || 'Falha ao atualizar o e-mail.');
      }
      const { error } = await supa.rpc('update_gerente_profile', {
        p_gerente_id: gerente.id,
        p_full_name: document.getElementById('eg-name').value.trim(),
        p_phone: document.getElementById('eg-phone').value.replace(/\D/g, '') || null,
        p_active: gerente.is_primary_admin ? true : document.getElementById('eg-active').checked,
      });
      if (error) throw error;
      logAudit('gerente_editado', `Gerente ${gerente.full_name || gerente.email} editado`, { gerente_id: gerente.id });
      close();
      showToast('Gerente atualizado.');
      renderGerenteGerentes();
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message || String(e))}</div>`;
      btn.disabled = false;
    }
  };
}

function openNovoGerenteModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>Novo gerente</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="ng-feedback"></div>
        <div class="field"><label>Nome completo</label><input type="text" id="ng-name"></div>
        <div class="field"><label>E-mail</label><input type="email" id="ng-email"></div>
        <div class="field"><label>Senha inicial</label>${passwordFieldHtml('ng-password', 'minlength="6"')}</div>
        <p class="text-sm text-soft">Este gerente terá acesso operacional ao sistema (Contratos, Clientes, Cobrar, Score etc.), mas não a Planejamento nem Configurações — exclusivas do Administrador.</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-primary" id="save-modal">Criar gerente</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
  wirePasswordToggles(overlay);
  document.getElementById('save-modal').onclick = async () => {
    const feedback = document.getElementById('ng-feedback');
    feedback.innerHTML = '';
    const email = document.getElementById('ng-email').value.trim();
    const password = document.getElementById('ng-password').value;
    const fullName = document.getElementById('ng-name').value.trim();
    if (!email || password.length < 6) { feedback.innerHTML = '<div class="auth-error">Preencha e-mail e senha (mín. 6 caracteres).</div>'; return; }

    const btn = document.getElementById('save-modal');
    btn.disabled = true;
    try {
      const resp = await fetch('/api/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + App.session.access_token },
        body: JSON.stringify({ email, password, full_name: fullName, role: 'gerente' }),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Falha ao criar gerente.');
      logAudit('gerente_criado', `Gerente ${fullName || email} criado`, { gerente_id: result.user_id });
      close();
      showToast('Gerente criado com sucesso.');
      renderGerenteGerentes();
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
    }
  };
}

registerRoute('gerente/gerentes', { role: 'gerente', screenId: 'gerente-gerentes', title: 'Administradores', render: renderGerenteGerentes });

/* ============================================================================
   Administradores — gestão de contas (sem cadastro público; só um
   administrador já existente pode criar outro, de dentro do painel)
   ============================================================================ */

let gerentesCache = [];

async function renderGerenteGerentes() {
  const root = document.getElementById('screen-gerente-gerentes');
  root.innerHTML = `<div class="text-soft">Carregando...</div>`;

  const { data, error } = await supa.from('profiles').select('*').eq('role', 'gerente').order('created_at');
  if (error) { root.innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`; return; }
  gerentesCache = data || [];

  root.innerHTML = `
    <div class="flex justify-between items-center">
      <p class="text-sm text-soft">Contas de administrador têm acesso total ao sistema. Só crie para pessoas de confiança da equipe.</p>
      <button class="btn btn-primary" id="novo-gerente-btn">${Icons.userPlus} Novo Administrador</button>
    </div>
    <div class="card mt-14" style="padding:0">
      <table class="data-table table-scroll">
        <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Status</th><th>Criado em</th><th></th></tr></thead>
        <tbody>
          ${gerentesCache.map((g) => `
            <tr>
              <td data-label="Nome">${escapeHtml(g.full_name || '—')}</td>
              <td data-label="E-mail">${escapeHtml(g.email)}</td>
              <td data-label="Papel">${g.is_primary_admin ? '<span class="badge badge-brand">Admin primário</span>' : '<span class="badge badge-neutral">Administrador</span>'}</td>
              <td data-label="Status">${g.active ? statusBadge('quitado', 'Ativo') : statusBadge('reprovada', 'Inativo')}</td>
              <td data-label="Criado em">${formatDate(g.created_at)}</td>
              <td data-label=""><button class="icon-btn edit-gerente-btn" data-id="${g.id}">${Icons.edit}</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('novo-gerente-btn').onclick = openNovoGerenteModal;
  root.querySelectorAll('.edit-gerente-btn').forEach((btn) => {
    btn.onclick = () => openEditGerenteModal(gerentesCache.find((g) => g.id === btn.dataset.id));
  });
}

function openEditGerenteModal(gerente) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>Editar administrador</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="eg-feedback"></div>
        <div class="field"><label>Nome completo</label><input type="text" id="eg-name" value="${escapeHtml(gerente.full_name || '')}"></div>
        <div class="field"><label>Telefone</label><input type="tel" id="eg-phone" value="${escapeHtml(gerente.phone || '')}"></div>
        <div class="toggle-row">
          <label class="switch"><input type="checkbox" id="eg-active" ${gerente.active ? 'checked' : ''} ${gerente.is_primary_admin ? 'disabled' : ''}><span class="track"></span></label>
          <span>Conta ativa${gerente.is_primary_admin ? ' (admin primário não pode ser desativado por aqui)' : ''}</span>
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
  document.getElementById('save-modal').onclick = async () => {
    const btn = document.getElementById('save-modal');
    btn.disabled = true;
    const { error } = await supa.rpc('update_gerente_profile', {
      p_gerente_id: gerente.id,
      p_full_name: document.getElementById('eg-name').value.trim(),
      p_phone: document.getElementById('eg-phone').value.trim() || null,
      p_active: gerente.is_primary_admin ? true : document.getElementById('eg-active').checked,
    });
    if (error) {
      document.getElementById('eg-feedback').innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`;
      btn.disabled = false;
      return;
    }
    close();
    showToast('Administrador atualizado.');
    renderGerenteGerentes();
  };
}

function openNovoGerenteModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:420px">
      <div class="modal-head"><h3>Novo administrador</h3><button class="icon-btn" id="close-modal">${Icons.x}</button></div>
      <div class="modal-body">
        <div id="ng-feedback"></div>
        <div class="field"><label>Nome completo</label><input type="text" id="ng-name"></div>
        <div class="field"><label>E-mail</label><input type="email" id="ng-email"></div>
        <div class="field"><label>Senha inicial</label><input type="password" id="ng-password" minlength="6"></div>
        <p class="text-sm text-soft">Este novo administrador terá acesso total ao sistema, exceto a opção de apagar todos os dados (exclusiva do admin primário).</p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="cancel-modal">Cancelar</button>
        <button class="btn btn-primary" id="save-modal">Criar administrador</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  document.getElementById('close-modal').onclick = close;
  document.getElementById('cancel-modal').onclick = close;
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
      if (!resp.ok) throw new Error(result.error || 'Falha ao criar administrador.');
      close();
      showToast('Administrador criado com sucesso.');
      renderGerenteGerentes();
    } catch (e) {
      feedback.innerHTML = `<div class="auth-error">${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
    }
  };
}

registerRoute('gerente/gerentes', { role: 'gerente', screenId: 'gerente-gerentes', title: 'Administradores', render: renderGerenteGerentes });

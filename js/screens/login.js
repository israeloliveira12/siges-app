/* ============================================================================
   Tela de login / cadastro (cliente) — cadastro de gerente não existe aqui
   ============================================================================ */

let authMode = 'login'; // 'login' | 'signup'

function setAuthError(msg) {
  const el = document.getElementById('auth-feedback');
  if (el) el.innerHTML = `<div class="auth-error">${escapeHtml(msg)}</div>`;
}

function setAuthMessage(msg) {
  const el = document.getElementById('auth-feedback');
  if (el) el.innerHTML = `<div class="auth-msg">${escapeHtml(msg)}</div>`;
}

function clearAuthFeedback() {
  const el = document.getElementById('auth-feedback');
  if (el) el.innerHTML = '';
}

function renderLoginScreen() {
  const root = document.getElementById('auth-screen');
  root.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card">
        <div class="auth-logo">
          ${Icons.logo}
          <div class="name">SIGES</div>
          <div class="sub">Serviços Financeiros</div>
        </div>

        <div class="auth-tabs">
          <button class="auth-tab ${authMode === 'login' ? 'active' : ''}" id="tab-login">Entrar</button>
          <button class="auth-tab ${authMode === 'signup' ? 'active' : ''}" id="tab-signup">Criar conta</button>
        </div>

        <div id="auth-feedback"></div>

        <form id="auth-form">
          ${authMode === 'signup' ? `
            <div class="field">
              <label>Nome completo</label>
              <input type="text" id="f-name" autocomplete="name" required>
            </div>
            <div class="field-row">
              <div class="field"><label>CPF</label><input type="text" id="f-cpf" inputmode="numeric" placeholder="000.000.000-00" maxlength="14" required></div>
              <div class="field"><label>Telefone / WhatsApp</label><input type="tel" id="f-phone" placeholder="(00) 00000-0000"></div>
            </div>
            <div class="field-row">
              <div class="field"><label>Empresa</label><input type="text" id="f-company"></div>
              <div class="field"><label>Cargo</label><input type="text" id="f-job-title"></div>
            </div>
            <div class="field"><label>Salário (R$)</label><input type="text" id="f-salary" placeholder="0,00"></div>
            <div class="field">
              <label>Chave Pix</label>
              <input type="text" id="f-pix-key">
              <span class="help">Atenção: o CPF cadastrado acima deve ser o mesmo CPF do dono da chave Pix.</span>
            </div>
          ` : ''}
          <div class="field">
            <label>E-mail</label>
            <input type="email" id="f-email" autocomplete="email" required>
          </div>
          <div class="field">
            <label>Senha</label>
            ${passwordFieldHtml('f-password', `autocomplete="${authMode === 'login' ? 'current-password' : 'new-password'}" required`)}
          </div>
          ${authMode === 'login' ? `<div class="text-sm mt-8"><a href="#" id="forgot-link" style="color:var(--accent)">Esqueci minha senha</a></div>` : ''}
          <button type="submit" class="btn btn-primary btn-block mt-14" id="submit-btn">
            ${authMode === 'login' ? 'Entrar' : 'Criar conta de cliente'}
          </button>
        </form>

        <div class="auth-divider">ou</div>

        <button class="google-btn" id="google-btn">${Icons.google} Continuar com Google</button>

        <p class="text-sm text-soft text-center mt-14">
          Este cadastro é exclusivo para clientes. Contas de administrador são criadas internamente pela equipe Siges.
        </p>
      </div>
    </div>
  `;

  document.getElementById('tab-login').onclick = () => { authMode = 'login'; renderLoginScreen(); };
  document.getElementById('tab-signup').onclick = () => { authMode = 'signup'; renderLoginScreen(); };
  document.getElementById('google-btn').onclick = () => withAuthButtonsDisabled(['google-btn'], doGoogleSignIn);

  const cpfInput = document.getElementById('f-cpf');
  if (cpfInput) cpfInput.oninput = () => { cpfInput.value = formatCpf(cpfInput.value); };
  attachPhoneMask(document.getElementById('f-phone'));
  attachMoneyMask(document.getElementById('f-salary'));
  wirePasswordToggles();

  const forgotLink = document.getElementById('forgot-link');
  if (forgotLink) {
    forgotLink.onclick = (e) => {
      e.preventDefault();
      const email = document.getElementById('f-email').value.trim();
      withAuthButtonsDisabled(['submit-btn'], () => doPasswordReset(email));
    };
  }

  document.getElementById('auth-form').onsubmit = (e) => {
    e.preventDefault();
    clearAuthFeedback();
    const email = document.getElementById('f-email').value.trim();
    const password = document.getElementById('f-password').value;
    withAuthButtonsDisabled(['submit-btn'], async () => {
      if (authMode === 'login') {
        await doSignIn(email, password);
      } else {
        const cpf = document.getElementById('f-cpf').value.trim();
        if (cpf.replace(/\D/g, '').length !== 11) { setAuthError('Informe um CPF válido (11 dígitos).'); return; }
        const profileData = {
          full_name: document.getElementById('f-name').value.trim(),
          cpf,
          phone: document.getElementById('f-phone').value.trim(),
          company: document.getElementById('f-company').value.trim(),
          job_title: document.getElementById('f-job-title').value.trim(),
          salary: getMoneyValue(document.getElementById('f-salary')) || null,
          pix_key: document.getElementById('f-pix-key').value.trim(),
        };
        await doSignUp(email, password, profileData);
      }
    });
  };
}

function renderPendingApprovalScreen(client) {
  const root = document.getElementById('auth-screen');
  const rejected = client.approval_status === 'rejeitado';
  root.innerHTML = `
    <div class="auth-shell">
      <div class="auth-card text-center">
        <div class="auth-logo">
          ${Icons.logo}
          <div class="name">SIGES</div>
          <div class="sub">Serviços Financeiros</div>
        </div>
        ${rejected ? `
          <div class="auth-error">Seu cadastro não foi aprovado.</div>
          ${client.decision_reason ? `<p class="text-sm text-soft mt-8">Motivo: ${escapeHtml(client.decision_reason)}</p>` : ''}
        ` : `
          <div class="auth-msg">Seu cadastro está em análise.</div>
          <p class="text-sm text-soft mt-14">Um administrador precisa aprovar sua conta antes que você possa acessar o sistema. Isso costuma ser rápido — tente novamente mais tarde ou entre em contato com a Siges.</p>
        `}
        <button class="btn btn-outline btn-block mt-20" id="pending-signout">Sair</button>
      </div>
    </div>
  `;
  document.getElementById('pending-signout').onclick = handleSignOut;
}

function renderResetPasswordModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:400px">
      <div class="modal-head"><h3>Definir nova senha</h3></div>
      <div class="modal-body">
        <div id="reset-feedback"></div>
        <div class="field">
          <label>Nova senha</label>
          ${passwordFieldHtml('new-password', 'minlength="6" required')}
        </div>
        <button class="btn btn-primary btn-block" id="reset-submit">Salvar nova senha</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  wirePasswordToggles(overlay);
  document.getElementById('reset-submit').onclick = async () => {
    const pwd = document.getElementById('new-password').value;
    if (pwd.length < 6) {
      document.getElementById('reset-feedback').innerHTML = '<div class="auth-error">Mínimo de 6 caracteres.</div>';
      return;
    }
    const { error } = await supa.auth.updateUser({ password: pwd });
    if (error) {
      document.getElementById('reset-feedback').innerHTML = `<div class="auth-error">${escapeHtml(error.message)}</div>`;
      return;
    }
    overlay.remove();
    showToast('Senha atualizada com sucesso.');
  };
}

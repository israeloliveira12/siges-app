/* ============================================================================
   Autenticação — cliente Supabase, login/cadastro/Google, single entry point
   ============================================================================ */

// Esses dois valores NÃO são secretos — são projetados para aparecer no navegador
// (a proteção de verdade é a Row Level Security configurada em supabase/schema.sql).
const SUPABASE_URL = 'https://nowljymwqgadoezbffbg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vd2xqeW13cWdhZG9lemJmZmJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzODQ2ODksImV4cCI6MjA5ODk2MDY4OX0.RBi7AmI5Kjr3T98tXgbt2Dt0MqD5Q60XGBvpVrowwLA';

const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let authHandled = false;

async function withAuthButtonsDisabled(ids, fn) {
  const btns = ids.map((id) => document.getElementById(id)).filter(Boolean);
  if (btns.some((b) => b.disabled)) return;
  btns.forEach((b) => (b.disabled = true));
  try { await fn(); } finally { btns.forEach((b) => { if (document.body.contains(b)) b.disabled = false; }); }
}

async function loadProfileAndClient(userId) {
  const { data: profile, error: profileErr } = await supa.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (profileErr) throw profileErr;
  App.profile = profile;

  if (profile && profile.role === 'cliente') {
    const { data: client } = await supa.from('clients').select('*').eq('profile_id', userId).maybeSingle();
    App.client = client;
  } else {
    App.client = null;
  }
}

async function loadGlobalReferenceData() {
  const { data: settings } = await supa.from('system_settings').select('*').maybeSingle();
  App.settings = settings;
}

async function onAuthenticated(session) {
  App.session = session;
  await loadProfileAndClient(session.user.id);

  if (!App.profile) {
    // Trigger de criação de profile ainda não propagou (raríssimo) — tenta de novo em breve.
    setTimeout(() => onAuthenticated(session), 800);
    return;
  }

  await loadGlobalReferenceData();

  if (isCliente() && App.client && App.client.approval_status !== 'aprovado') {
    document.getElementById('app').classList.remove('ready');
    document.getElementById('auth-screen').classList.add('active');
    renderPendingApprovalScreen(App.client);
    return;
  }

  document.getElementById('app').classList.add('ready');
  document.getElementById('auth-screen').classList.remove('active');

  renderShellForRole();
  subscribeNotifications();
  registerPushIfSupported();
  maybeRunAutoBackup();

  if (location.hash === '' || location.hash === '#/login' || location.hash === '#/') {
    router.navigate(isGerente() ? '#/gerente/dashboard' : '#/cliente/dashboard');
  } else {
    router.handleHashChange();
  }
}

function showAuthGate() {
  document.getElementById('app').classList.remove('ready');
  document.getElementById('auth-screen').classList.add('active');
  renderLoginScreen();
}

async function handleAuthEvent(session) {
  if (!session) {
    if (!authHandled) { authHandled = true; showAuthGate(); }
    return;
  }
  const alreadyBooted = authHandled && App.session && App.session.user.id === session.user.id;
  // Sempre atualiza a sessão (inclusive o access_token), mesmo quando não
  // reprocessa o boot inteiro — sem isso, o token some depois do refresh
  // automático do Supabase e as chamadas a /api/* passam a falhar.
  App.session = session;
  if (alreadyBooted) return;
  authHandled = true;
  await onAuthenticated(session);
}

// NOTA: o registro do listener e a checagem inicial de sessão só são
// disparados por initAuth(), chamada a partir de main.js (o último <script>
// carregado). Isso evita a corrida onde o evento de auth resolve antes dos
// arquivos de tela (que definem renderLoginScreen, etc.) terem carregado.
function initAuth() {
  supa.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') { location.reload(); return; }
    if (event === 'PASSWORD_RECOVERY') { renderResetPasswordModal(); return; }
    handleAuthEvent(session);
  });

  (async function bootAuth() {
    const { data: { session } } = await supa.auth.getSession();
    await handleAuthEvent(session);
  })();
}

// ---------------------------------------------------------------------------
// Ações de autenticação
// ---------------------------------------------------------------------------

async function doSignIn(emailOrCpf, password) {
  if (!emailOrCpf || !password) { setAuthError('Preencha e-mail/CPF e senha.'); return; }

  // Limpa qualquer hash de rota deixado por uma sessão anterior (ex: usuário
  // saiu estando em #/cliente/emprestimos) — sem isso, onAuthenticated() acha
  // que é pra manter a rota antiga em vez de abrir a tela inicial.
  location.hash = '';

  let email = emailOrCpf.trim();
  const digitsOnly = email.replace(/\D/g, '');
  const looksLikeCpf = !email.includes('@') && digitsOnly.length === 11;

  if (looksLikeCpf) {
    const { data, error: cpfError } = await supa.rpc('email_for_cpf', { p_cpf: formatCpf(digitsOnly) });
    if (cpfError || !data) {
      setAuthError('Nenhuma conta encontrada para esse CPF.');
      logAudit('login_falho', `Tentativa de login com CPF não encontrado`, { identifier: emailOrCpf.trim() });
      return;
    }
    email = data;
  }

  const { error } = await supa.auth.signInWithPassword({ email, password });
  if (error) {
    setAuthError(traduzErroAuth(error));
    logAudit('login_falho', `Tentativa de login falhou para ${email}`, { identifier: email, reason: error.message });
  }
}

async function doSignUp(email, password, profileData) {
  if (!email || !password) { setAuthError('Preencha e-mail e senha.'); return; }
  if (password.length < 6) { setAuthError('A senha precisa ter pelo menos 6 caracteres.'); return; }
  location.hash = '';
  const { data, error } = await supa.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: { data: profileData || {} },
  });
  if (error) { setAuthError(traduzErroAuth(error)); return; }
  if (!data.session) {
    setAuthMessage('Conta criada! Confirme seu e-mail e aguarde a aprovação de um administrador para poder entrar.');
  }
}

async function doGoogleSignIn() {
  await supa.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname },
  });
}

async function doPasswordReset(email) {
  if (!email) { setAuthError('Informe seu e-mail para recuperar a senha.'); return; }
  await supa.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  setAuthMessage('Se esse e-mail existir, você vai receber um link de recuperação.');
}

async function handleSignOut() {
  await supa.auth.signOut();
  location.hash = '';
  location.reload();
}

function traduzErroAuth(error) {
  const msg = error && error.message || '';
  if (msg.includes('Invalid login credentials')) return 'E-mail ou senha incorretos.';
  if (msg.includes('User already registered')) return 'Já existe uma conta com esse e-mail.';
  if (msg.includes('Email not confirmed')) return 'Confirme seu e-mail antes de entrar.';
  if (msg.includes('profiles_cpf_key')) return 'Já existe uma conta cadastrada com esse CPF.';
  if (msg.includes('email_address_invalid')) return 'Informe um e-mail válido.';
  if (msg.includes('duplicate key value')) return 'Alguns dos dados informados já estão em uso por outra conta.';
  if (msg.startsWith('{') || msg.length > 200) return 'Ocorreu um erro. Tente novamente em instantes.';
  return msg || 'Ocorreu um erro. Tente novamente.';
}

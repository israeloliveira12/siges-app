/* ============================================================================
   Autenticação — cliente Supabase, login/cadastro/Google, single entry point
   ============================================================================ */

// Esses dois valores NÃO são secretos — são projetados para aparecer no navegador
// (a proteção de verdade é a Row Level Security configurada em supabase/schema.sql).
const SUPABASE_URL = 'https://nowljymwqgadoezbffbg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vd2xqeW13cWdhZG9lemJmZmJnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzODQ2ODksImV4cCI6MjA5ODk2MDY4OX0.RBi7AmI5Kjr3T98tXgbt2Dt0MqD5Q60XGBvpVrowwLA';

const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let authHandled = false;
// Supabase Auth costuma emitir 'SIGNED_IN' mais de uma vez pro mesmo login
// (ex: uma vez ao resolver signInWithPassword, outra pela sincronização
// interna entre abas/localStorage) — sem essa trava, cada disparo extra
// gravava um novo log_audit_event idêntico, poluindo a Auditoria com vários
// "Login realizado" seguidos pro mesmo acesso. Só reseta com reload de
// página (login novo sempre passa por handleSignOut -> location.reload()).
let signInLogged = false;

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
  // SELECT direto em system_settings é exclusivo de gerente (RLS) — cliente
  // usa a RPC public_company_info(), que só devolve os 2 campos que ele
  // realmente consome (company_name/company_whatsapp), sem vazar taxas/caixa.
  if (isGerente()) {
    const { data: settings } = await supa.from('system_settings').select('*').maybeSingle();
    App.settings = settings;
    App.hasReferrals = false;
  } else {
    const { data } = await supa.rpc('public_company_info');
    App.settings = (data && data[0]) || null;
    const { data: hasReferrals } = await supa.rpc('has_referrals');
    App.hasReferrals = !!hasReferrals;
  }
  // Limites do plano (Fase 5) — carregado pros dois papéis (gerente E
  // cliente usam o flag allow_extrato_pdf pra esconder o botão de extrato).
  // Best-effort: se falhar, App.planLimits fica {} (== "tudo liberado",
  // mesmo comportamento de uma empresa sem plano atribuído).
  try {
    const { data: limits } = await supa.rpc('get_my_plan_limits');
    App.planLimits = limits || {};
  } catch (e) { App.planLimits = {}; }
}

// OPS-04 (auditoria 2026-08-23): a espera pelo profile se reagendava a cada
// 800ms PARA SEMPRE quando a linha não existia — sem contador, sem desistência
// e sem mensagem. A tela ficava em branco e o navegador martelava o banco
// indefinidamente. Agora são 6 tentativas (~5s) e depois uma tela que explica
// o que houve e oferece uma saída.
const PROFILE_MAX_ATTEMPTS = 6;
let profileAttempts = 0;

async function onAuthenticated(session) {
  App.session = session;
  await loadProfileAndClient(session.user.id);

  if (!App.profile) {
    // Trigger de criação de profile ainda não propagou (raríssimo) — tenta de novo em breve.
    profileAttempts += 1;
    if (profileAttempts >= PROFILE_MAX_ATTEMPTS) {
      profileAttempts = 0;
      document.getElementById('app').classList.remove('ready');
      document.getElementById('auth-screen').classList.add('active');
      renderProfileMissingScreen();
      return;
    }
    setTimeout(() => onAuthenticated(session), 800);
    return;
  }
  profileAttempts = 0;

  await loadGlobalReferenceData();

  // Empresa (tenant) suspensa pelo Administrador Master — bloqueia QUALQUER
  // usuário dela, gerente ou cliente, antes de qualquer outra checagem
  // (Fase 3 da transformação em SaaS). is_my_tenant_active() nunca falha
  // pra ninguém antes desta fase (toda empresa nasce ativa), então isso é
  // best-effort: erro de rede aqui não deve travar o login de todo mundo.
  try {
    const { data: tenantActive } = await supa.rpc('is_my_tenant_active');
    if (tenantActive === false) {
      document.getElementById('app').classList.remove('ready');
      document.getElementById('auth-screen').classList.add('active');
      renderTenantSuspendedScreen();
      return;
    }
  } catch (e) { /* best-effort — não bloqueia o login por falha de rede */ }

  // Desativar um gerente não revoga o token de sessão já emitido — sem essa
  // checagem, ele entrava no shell inteiro (sidebar/dashboard/tabbar) e só
  // descobria que foi desativado quando cada query/RPC (bloqueadas por
  // is_gerente() no banco) começasse a falhar silenciosamente ou voltar vazia.
  if (isGerente() && App.profile.active === false) {
    document.getElementById('app').classList.remove('ready');
    document.getElementById('auth-screen').classList.add('active');
    renderDeactivatedGerenteScreen();
    return;
  }

  // Cliente que entrou pela primeira vez via Google (o OAuth só traz nome/
  // e-mail, nunca CPF/telefone/empresa/etc.) precisa completar o mesmo
  // formulário que o cadastro manual sempre exigiu, antes de ver a tela de
  // "aguardando aprovação" — CPF ausente é o sinal (só acontece com Google,
  // já que o cadastro manual sempre envia CPF obrigatório).
  if (isCliente() && App.client && App.client.approval_status === 'pendente' && !App.profile.cpf) {
    document.getElementById('app').classList.remove('ready');
    document.getElementById('auth-screen').classList.add('active');
    renderCompleteRegistrationScreen();
    return;
  }

  if (isCliente() && App.client && App.client.approval_status !== 'aprovado') {
    document.getElementById('app').classList.remove('ready');
    document.getElementById('auth-screen').classList.add('active');
    renderPendingApprovalScreen(App.client);
    return;
  }

  document.getElementById('app').classList.add('ready');
  document.getElementById('auth-screen').classList.remove('active');

  renderShellForRole();

  // A tela pedida (dashboard no login, ou a mesma tela de antes num F5) é
  // renderizada ANTES de qualquer efeito colateral "bônus" (notificações em
  // tempo real, push, backup automático, recálculo de score) — bug real
  // corrigido (2026-07-29): se um desses efeitos lançasse uma exceção
  // síncrona (ex: subscribeNotifications() montando o canal realtime), o
  // resto de onAuthenticated() nunca chegava a este ponto e a tela ficava em
  // branco até o usuário clicar manualmente num menu (o que chama
  // router.navigate() por um caminho totalmente independente deste). Cada
  // efeito colateral abaixo agora roda isolado em seu próprio try/catch, pra
  // nenhum deles nunca mais poder impedir a tela de aparecer.
  if (location.hash === '' || location.hash === '#/login' || location.hash === '#/') {
    router.navigate(isGerente() ? '#/gerente/dashboard' : '#/cliente/dashboard');
  } else {
    router.handleHashChange();
  }

  try { subscribeNotifications(); } catch (e) { console.warn('subscribeNotifications falhou:', e); }
  try { registerPushIfSupported(); } catch (e) { /* registerPushIfSupported já trata os próprios erros */ }
  try { maybeRunAutoBackup(); } catch (e) { /* maybeRunAutoBackup já trata os próprios erros */ }
  // Recalcula os scores de todos os clientes toda vez que o gerente abre o
  // sistema (login ou reload com sessão válida) — em background, sem travar
  // a UI. O botão "Recalcular todos" em gerente-score.js continua existindo
  // pra forçar um recálculo manual a qualquer momento.
  if (isGerente()) {
    // supa.rpc(...) devolve um builder "thenable" do supabase-js (só
    // implementa .then, não é uma Promise de verdade) — encadear .catch()
    // direto nele lança "TypeError: ... .catch is not a function" na hora,
    // e como ninguém aguarda onAuthenticated(), isso virava uma rejeição de
    // Promise não tratada em todo login de gerente (bug real reportado pelo
    // usuário via Auditoria, 2026-08-02). .then(onFulfilled, onRejected) é a
    // forma do contrato "thenable" que realmente existe nesse objeto.
    supa.rpc('recalculate_all_scores').then(() => {}, () => { /* falha silenciosa — o botão manual continua disponível */ });
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
    // 'SIGNED_IN' só dispara em login de verdade (senha ou Google) — não em
    // restauração de sessão ao recarregar a página (isso é 'INITIAL_SESSION').
    if (event === 'SIGNED_IN' && session && !signInLogged) {
      signInLogged = true;
      logAudit('login_sucesso', `Login realizado por ${session.user.email || session.user.id}`, { user_id: session.user.id });
    }
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
    // SEC-13: confere o dígito verificador antes de consultar. Além de dar uma
    // mensagem melhor pra quem só errou um número, evita gastar uma consulta
    // de CPF→e-mail com entrada que nunca poderia existir.
    if (!isValidCpf(digitsOnly)) {
      setAuthError('Esse CPF não é válido. Confira os números.');
      return;
    }
    const { data, error: cpfError } = await supa.rpc('email_for_cpf', { p_cpf: formatCpf(digitsOnly) });
    if (cpfError || !data) {
      setAuthError('E-mail/CPF ou senha incorretos.');
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
  // SEC-14: regra única de senha, compartilhada com a redefinição e com a
  // criação de conta pelo administrador.
  const pwdProblem = passwordProblem(password);
  if (pwdProblem) { setAuthError(pwdProblem); return; }
  location.hash = '';
  const { data, error } = await supa.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
    options: { data: profileData || {} },
  });
  if (error) { setAuthError(traduzErroAuth(error)); return; }
  // Sem exigir confirmação de e-mail (desativada no painel do Supabase,
  // 2026-07-29): o sistema confia no e-mail que o cliente digitou e manda
  // o cadastro direto pra fila de aprovação do gerente — a validação real
  // de identidade é a aprovação manual, não um link de confirmação. Se
  // `data.session` ainda vier nulo (ex: confirmação ainda não desativada no
  // projeto Supabase), a mensagem também não menciona e-mail — só aprovação.
  if (!data.session) {
    setAuthMessage('Conta criada! Aguarde a aprovação de um administrador para poder entrar.');
  }
}

async function doGoogleSignIn() {
  await supa.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname },
  });
}

// UX-22 (auditoria 2026-08-23): o campo diz "E-mail ou CPF" e o login aceita
// os dois — mas a recuperação só funcionava com e-mail, e ainda assim
// respondia "se esse e-mail existir, você vai receber um link". Quem digitava
// CPF ficava esperando um e-mail que nunca vinha. Agora o CPF é resolvido pelo
// mesmo caminho do login antes de disparar a recuperação.
async function doPasswordReset(emailOrCpf) {
  const raw = String(emailOrCpf || '').trim();
  if (!raw) { setAuthError('Informe seu e-mail ou CPF para recuperar a senha.'); return; }

  let email = raw;
  const digitsOnly = raw.replace(/\D/g, '');
  if (!raw.includes('@') && digitsOnly.length === 11) {
    if (!isValidCpf(digitsOnly)) { setAuthError('Esse CPF não é válido. Confira os números.'); return; }
    const { data, error } = await supa.rpc('email_for_cpf', { p_cpf: formatCpf(digitsOnly) });
    // Resposta deliberadamente idêntica ao caso de sucesso: confirmar que um
    // CPF "não existe" aqui transformaria a tela num verificador de cadastro.
    if (error || !data) {
      setAuthMessage('Se essa conta existir, você vai receber um link de recuperação.');
      return;
    }
    email = data;
  } else if (!raw.includes('@')) {
    setAuthError('Informe um e-mail válido ou um CPF com 11 dígitos.');
    return;
  }

  await supa.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  setAuthMessage('Se essa conta existir, você vai receber um link de recuperação.');
}

async function handleSignOut() {
  // Registra ANTES de signOut() — depois disso auth.uid() vira null no
  // servidor e o evento apareceria como "Anônimo" na Auditoria.
  if (App.session) {
    await logAudit('logout', `Logoff realizado por ${App.session.user.email || App.session.user.id}`, { user_id: App.session.user.id });
  }

  // SEC-12: cancela a inscrição de push ANTES de encerrar a sessão. Sem isso,
  // num aparelho compartilhado o usuário ANTERIOR continuava recebendo avisos
  // (parcela vencendo, pagamento recebido) até que alguém entrasse de novo e
  // a inscrição fosse reatribuída. Precisa acontecer com a sessão ainda
  // válida, senão o DELETE na tabela é barrado pela RLS.
  await unregisterPushOnSignOut();

  await supa.auth.signOut();
  // Descarta qualquer resposta de API cacheada pelo service worker — evita
  // que, num dispositivo compartilhado, o próximo usuário a logar reaproveite
  // por engano um cache de dado financeiro da conta anterior.
  if ('caches' in window) {
    try { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } catch (e) { /* melhor esforço */ }
  }
  location.hash = '';
  location.reload();
}

function traduzErroAuth(error) {
  const msg = error && error.message || '';
  if (msg.includes('Invalid login credentials')) return 'E-mail ou senha incorretos.';
  if (msg.includes('User already registered')) return 'Já existe uma conta com esse e-mail.';
  if (msg.includes('Email not confirmed')) return 'Confirme seu e-mail antes de entrar.';
  if (msg.includes('profiles_cpf_key')) return 'Já existe uma conta cadastrada com esse CPF.';
  if (msg.includes('CLIENT_LIMIT_EXCEEDED')) return 'Esta empresa atingiu o limite de clientes do plano atual. Fale com o administrador dela.';
  if (msg.includes('email_address_invalid')) return 'Informe um e-mail válido.';
  if (msg.includes('duplicate key value')) return 'Alguns dos dados informados já estão em uso por outra conta.';
  if (msg.includes('RECEIVED_AT_IN_FUTURE')) return 'A data do pagamento não pode ser no futuro.';
  if (msg.includes('RECEIVED_AT_TOO_OLD')) return 'A data do pagamento não pode ser anterior a um ano.';
  if (msg.includes('NEW_DUE_DATE_NOT_FUTURE')) return 'O novo vencimento precisa ser depois da data do pagamento.';
  if (msg.includes('INVALID_INTEREST_RATE')) return 'A taxa de juros informada está fora da faixa aceita.';
  if (msg.includes('INVALID_DATE_ORDER')) return 'A primeira parcela não pode vencer antes da data do contrato.';
  if (msg.includes('INSTALLMENTS_COUNT_MISMATCH')) return 'A quantidade de parcelas não bate com as parcelas informadas.';
  if (msg.includes('FORBIDDEN')) return 'Você não tem permissão para esta ação.';
  // Nunca repassar a mensagem crua do banco/Auth pro usuário: além de não
  // ajudar em nada, expõe nome de coluna, de função e de restrição interna.
  if (msg.startsWith('{') || msg.length > 120 || /[a-z_]+\.[a-z_]+|pg_|relation |column /i.test(msg)) {
    return 'Ocorreu um erro. Tente novamente em instantes.';
  }
  return msg || 'Ocorreu um erro. Tente novamente.';
}

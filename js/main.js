/* ============================================================================
   main.js — SEMPRE o último <script>. Monta o shell (sidebar/topbar/tabbar)
   e inicializa o router. Toda a lógica de auth já rodou em auth.js.
   ============================================================================ */

const NAV_ITEMS = {
  cliente: [
    { route: 'cliente/dashboard', label: 'Início', icon: 'dashboard' },
    { route: 'cliente/solicitar', label: 'Solicitar', icon: 'plus' },
    { route: 'cliente/emprestimos', label: 'Empréstimos', icon: 'contract' },
    { route: 'cliente/indicacoes', label: 'Indicações', icon: 'userPlus', referralOnly: true },
    { route: 'cliente/score', label: 'Score', icon: 'score' },
  ],
  gerente: [
    { route: 'gerente/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { route: 'gerente/cobrar', label: 'Cobrar', icon: 'alarm' },
    { route: 'gerente/lancamentos', label: 'Lançamentos', icon: 'calendar' },
    { route: 'gerente/contratos', label: 'Contratos', icon: 'contract' },
    { route: 'gerente/solicitacoes', label: 'Solicitações', icon: 'inbox' },
    { route: 'gerente/clientes', label: 'Clientes', icon: 'users' },
    { route: 'gerente/gerentes', label: 'Administradores', icon: 'userPlus' },
    { route: 'gerente/relatorios', label: 'Relatórios', icon: 'chart' },
    { route: 'gerente/score', label: 'Score de Clientes', icon: 'score' },
    // Planejamento também é exclusivo do Administrador Master (mesmo
    // requisito original do pivô SaaS que já fechou Auditoria) — "isso é
    // apenas meu", nunca uma tela do produto SaaS, nem pro admin primário
    // de uma empresa cliente.
    { route: 'gerente/planejamento', label: 'Planejamento', icon: 'wallet', primaryOnly: true, platformOwnerOnly: true },
    // Auditoria nunca é uma tela do produto SaaS (decisão explícita do
    // fundador, 2026-08-09) — nem pro admin primário de uma empresa
    // cliente, só pro Administrador Master. Reforçado em RLS também (ver
    // migration_036.sql), isto aqui só evita mostrar um item de menu morto.
    { route: 'gerente/auditoria', label: 'Auditoria', icon: 'audit', platformOwnerOnly: true },
    { route: 'gerente/configuracoes', label: 'Configurações', icon: 'settings', primaryOnly: true },
  ],
  // Modo "Plataforma SaaS" — só existe pra quem é platform_owner. Métricas
  // chegam numa próxima fase.
  plataforma: [
    { route: 'plataforma/inicio', label: 'Início', icon: 'dashboard' },
    { route: 'plataforma/empresas', label: 'Empresas', icon: 'users' },
    { route: 'plataforma/planos', label: 'Planos', icon: 'wallet' },
    { route: 'plataforma/cobrancas', label: 'Assinaturas', icon: 'contract' },
    { route: 'plataforma/comunicados', label: 'Comunicados', icon: 'bell' },
    { route: 'plataforma/metricas', label: 'Métricas históricas', icon: 'chart' },
    { route: 'plataforma/configuracoes', label: 'Configurações da Plataforma', icon: 'settings' },
    { route: 'plataforma/backup', label: 'Backup Geral', icon: 'printer' },
  ],
};

// Só as rotas mais usadas viram aba direta na tabbar mobile (a tabbar só
// cabe uns 5 itens legíveis) — o resto (se sobrar item) vai pra aba "Mais",
// que abre uma folha com o restante do menu. Cliente tem no máximo 5 itens
// (dashboard/solicitar/emprestimos/indicacoes/score — 'indicacoes' só existe
// pra quem já indicou alguém) e cabe inteiro sem "Mais" nos dois casos.
// Gerente tem mais itens que isso.
const MOBILE_TAB_ROUTES = {
  cliente: ['cliente/dashboard', 'cliente/solicitar', 'cliente/emprestimos', 'cliente/indicacoes', 'cliente/score'],
  gerente: ['gerente/dashboard', 'gerente/cobrar', 'gerente/lancamentos', 'gerente/contratos'],
  plataforma: ['plataforma/inicio', 'plataforma/empresas', 'plataforma/planos', 'plataforma/backup'],
};

function navLinkHtml(item, mobile) {
  return `<a href="#/${item.route}" class="nav-link" data-route="${item.route}">${Icons[item.icon] || ''}<span>${item.label}</span></a>`;
}

function toggleMobileMoreMenu(forceOpen) {
  const menu = document.getElementById('mobile-more-menu');
  const backdrop = document.getElementById('mobile-more-backdrop');
  if (!menu || !backdrop) return;
  const open = forceOpen != null ? forceOpen : menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  backdrop.classList.toggle('hidden', !open);
}

// Bolinha "Empréstimos / Plataforma SaaS" no topbar — só existe pra quem é
// platform_owner (Fase 2). Chamada de dentro de renderShellForRole() pra
// ficar sempre em sincronia com o modo atual, sem precisar lembrar de
// chamar as duas funções separadamente em todo lugar que monta o shell.
function renderModeSwitch() {
  const wrap = document.getElementById('mode-switch-wrap');
  if (!wrap) return;
  if (!isPlatformOwner()) { wrap.innerHTML = ''; return; }
  const mode = currentMode();
  // Rótulo completo não cabe ao lado dos ícones do topbar no celular (68px
  // de altura fixa, sem quebra de linha) — abrevia só nesse breakpoint,
  // mesmo critério de window.innerWidth<=640 já usado em chartSize().
  const mobile = window.innerWidth <= 640;
  const labelEmprestimos = mobile ? 'Negócio' : 'Empréstimos';
  const labelPlataforma = mobile ? 'SaaS' : 'Plataforma SaaS';
  wrap.innerHTML = `
    <div class="mode-switch">
      <button class="mode-switch-opt ${mode === 'emprestimos' ? 'active' : ''}" data-mode="emprestimos">${labelEmprestimos}</button>
      <button class="mode-switch-opt ${mode === 'plataforma' ? 'active' : ''}" data-mode="plataforma">${labelPlataforma}</button>
    </div>
  `;
  wrap.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.onclick = () => switchMode(btn.dataset.mode);
  });
}

function renderShellForRole() {
  const inPlatformMode = isPlatformOwner() && currentMode() === 'plataforma';
  const role = inPlatformMode ? 'plataforma' : (isGerente() ? 'gerente' : 'cliente');
  const isPrimary = !!(App.profile && App.profile.is_primary_admin);
  const items = NAV_ITEMS[role].filter((i) =>
    (!i.primaryOnly || isPrimary) &&
    (!i.referralOnly || App.hasReferrals) &&
    (!i.platformOwnerOnly || isPlatformOwner()));

  renderModeSwitch();

  document.getElementById('sidebar-nav').innerHTML = items.map((i) => navLinkHtml(i)).join('');
  document.getElementById('sidebar-nav').querySelectorAll('a').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); router.navigate(a.getAttribute('href').replace('#', '#')); };
  });

  const mobileRoutes = MOBILE_TAB_ROUTES[role];
  const primaryItems = items.filter((i) => mobileRoutes.includes(i.route));
  const moreItems = items.filter((i) => !mobileRoutes.includes(i.route));

  document.getElementById('tabbar-mobile').innerHTML =
    primaryItems.map((i) => navLinkHtml(i)).join('') +
    (moreItems.length ? `<button class="nav-link" id="mobile-more-btn">${Icons.more}<span>Mais</span></button>` : '');
  document.getElementById('tabbar-mobile').querySelectorAll('a').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); router.navigate(a.getAttribute('href')); };
  });
  const moreBtn = document.getElementById('mobile-more-btn');
  if (moreBtn) moreBtn.onclick = () => toggleMobileMoreMenu();

  document.getElementById('mobile-more-menu').innerHTML = moreItems.map((i) => navLinkHtml(i)).join('');
  document.getElementById('mobile-more-menu').querySelectorAll('a').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); router.navigate(a.getAttribute('href')); };
  });
  document.getElementById('mobile-more-backdrop').onclick = () => toggleMobileMoreMenu(false);

  document.getElementById('sidebar-user-avatar').innerHTML = avatarHtml(userDisplayName(), 34);
  document.getElementById('sidebar-user-name').textContent = userDisplayName();
  document.getElementById('sidebar-user-role').textContent =
    role === 'plataforma' ? 'Dono da Plataforma' : (role === 'gerente' ? (isPrimary ? 'Administrador' : 'Gerente') : 'Cliente');
  document.getElementById('topbar-signout').onclick = handleSignOut;

  renderBell();
}

// O shell decide rótulo curto vs. completo do seletor de modo ("Negócio/SaaS"
// vs "Empréstimos/Plataforma SaaS") no MOMENTO em que é montado, via
// window.innerWidth<=640 — sem isto, uma janela que começa em desktop e
// depois encolhe pra largura de celular (tablet girando de paisagem pra
// retrato, ou navegador redimensionado) fica com o rótulo completo num
// topbar estreito demais, estourando a largura da tela na horizontal (bug
// real medido: 423px de conteúdo num viewport de 375px). Só re-renderiza
// quando o lado do breakpoint realmente MUDA — um resize contínuo não
// dispara repaint a cada pixel.
let wasMobileViewport = window.innerWidth <= 640;
window.addEventListener('resize', () => {
  const isMobile = window.innerWidth <= 640;
  if (isMobile === wasMobileViewport) return;
  wasMobileViewport = isMobile;
  if (App.profile) renderShellForRole();
});

// Captura erros JS não tratados e promises rejeitadas sem catch — alimenta a
// tela de Auditoria com "falhas do sistema" sem precisar instrumentar cada
// try/catch manualmente. Best-effort: nunca deve gerar loop (logAudit já
// engole a própria falha).
window.addEventListener('error', (e) => {
  logAudit('erro_sistema', `Erro não tratado: ${e.message}`, { source: e.filename, line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = (e.reason && e.reason.message) || String(e.reason);
  logAudit('erro_sistema', `Promise rejeitada sem tratamento: ${msg}`, {});
});

router.init();
initAuth();

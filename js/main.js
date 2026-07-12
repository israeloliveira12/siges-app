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
    { route: 'cliente/notificacoes', label: 'Avisos', icon: 'bell' },
  ],
  gerente: [
    { route: 'gerente/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { route: 'gerente/cobrar', label: 'Cobrar', icon: 'alarm' },
    { route: 'gerente/contratos', label: 'Contratos', icon: 'contract' },
    { route: 'gerente/solicitacoes', label: 'Solicitações', icon: 'inbox' },
    { route: 'gerente/clientes', label: 'Clientes', icon: 'users' },
    { route: 'gerente/gerentes', label: 'Administradores', icon: 'userPlus' },
    { route: 'gerente/relatorios', label: 'Relatórios', icon: 'chart' },
    { route: 'gerente/score', label: 'Score de Clientes', icon: 'score' },
    { route: 'gerente/planejamento', label: 'Planejamento', icon: 'wallet', primaryOnly: true },
    { route: 'gerente/auditoria', label: 'Auditoria', icon: 'audit' },
    { route: 'gerente/configuracoes', label: 'Configurações', icon: 'settings', primaryOnly: true },
  ],
};

// Só as rotas mais usadas viram aba direta na tabbar mobile (a tabbar só
// cabe uns 5 itens legíveis) — o resto (se sobrar item) vai pra aba "Mais",
// que abre uma folha com o restante do menu. Cliente tem 5 itens fixos e cabe
// inteiro sem "Mais"; 'cliente/indicacoes' fica de fora de propósito (só
// existe pra quem já indicou alguém) — quando existir, cai automaticamente no
// "Mais" via moreItems abaixo. Gerente tem mais itens que isso.
const MOBILE_TAB_ROUTES = {
  cliente: ['cliente/dashboard', 'cliente/solicitar', 'cliente/emprestimos', 'cliente/score', 'cliente/notificacoes'],
  gerente: ['gerente/dashboard', 'gerente/cobrar', 'gerente/contratos', 'gerente/relatorios'],
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

function renderShellForRole() {
  const role = isGerente() ? 'gerente' : 'cliente';
  const isPrimary = !!(App.profile && App.profile.is_primary_admin);
  const items = NAV_ITEMS[role].filter((i) => (!i.primaryOnly || isPrimary) && (!i.referralOnly || App.hasReferrals));

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
  document.getElementById('sidebar-user-role').textContent = role === 'gerente' ? (isPrimary ? 'Administrador' : 'Gerente') : 'Cliente';
  document.getElementById('topbar-signout').onclick = handleSignOut;

  renderBell();
}

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

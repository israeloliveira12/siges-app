/* ============================================================================
   main.js — SEMPRE o último <script>. Monta o shell (sidebar/topbar/tabbar)
   e inicializa o router. Toda a lógica de auth já rodou em auth.js.
   ============================================================================ */

const NAV_ITEMS = {
  cliente: [
    { route: 'cliente/dashboard', label: 'Início', icon: 'dashboard' },
    { route: 'cliente/solicitar', label: 'Solicitar', icon: 'plus' },
    { route: 'cliente/emprestimos', label: 'Empréstimos', icon: 'contract' },
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
    { route: 'gerente/configuracoes', label: 'Configurações', icon: 'settings' },
  ],
};

const MOBILE_TAB_ROUTES = {
  cliente: ['cliente/dashboard', 'cliente/solicitar', 'cliente/emprestimos', 'cliente/score', 'cliente/notificacoes'],
  gerente: ['gerente/dashboard', 'gerente/cobrar', 'gerente/contratos', 'gerente/relatorios', 'gerente/configuracoes'],
};

function navLinkHtml(item, mobile) {
  return `<a href="#/${item.route}" class="nav-link" data-route="${item.route}">${Icons[item.icon] || ''}<span>${item.label}</span></a>`;
}

function renderShellForRole() {
  const role = isGerente() ? 'gerente' : 'cliente';
  const items = NAV_ITEMS[role];

  document.getElementById('sidebar-nav').innerHTML = items.map((i) => navLinkHtml(i)).join('');
  document.getElementById('sidebar-nav').querySelectorAll('a').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); router.navigate(a.getAttribute('href').replace('#', '#')); };
  });

  const mobileRoutes = MOBILE_TAB_ROUTES[role];
  document.getElementById('tabbar-mobile').innerHTML = items
    .filter((i) => mobileRoutes.includes(i.route))
    .map((i) => navLinkHtml(i))
    .join('');
  document.getElementById('tabbar-mobile').querySelectorAll('a').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); router.navigate(a.getAttribute('href')); };
  });

  document.getElementById('sidebar-user-name').textContent = userDisplayName();
  document.getElementById('sidebar-user-role').textContent = role === 'gerente' ? 'Administrador' : 'Cliente';
  document.getElementById('topbar-signout').onclick = handleSignOut;

  renderBell();
}

router.init();
initAuth();

/* ============================================================================
   Router — SPA sem framework, navegação via hash + guarda de rota por papel
   ============================================================================ */

const ROUTES = {}; // path (ex: 'cliente/dashboard') -> { role, render, title }

function registerRoute(path, config) {
  ROUTES[path] = config;
}

// Eyebrow contextual por seção (2026-07-29) — antes era só "Painel do
// gerente"/"Painel do cliente" repetido em toda tela; agora cada grupo de
// rotas ganha uma categoria específica, mesma linguagem dos cabeçalhos
// "COBRANÇA / Vencimentos" da referência (Limiar). Chave é sempre os 2
// primeiros segmentos do path (ex: 'gerente/contratos/:id' -> 'gerente/contratos'),
// então uma rota com :id reusa o mesmo eyebrow da lista. Fallback genérico
// por papel pra qualquer rota nova que não tenha entrada aqui ainda.
const EYEBROW_BY_SECTION = {
  'gerente/dashboard': 'Painel',
  'gerente/cobrar': 'Cobrança',
  'gerente/solicitacoes': 'Cobrança',
  'gerente/contratos': 'Contratos',
  'gerente/clientes': 'Pessoas',
  'gerente/gerentes': 'Pessoas',
  'gerente/score': 'Pessoas',
  'gerente/relatorios': 'Financeiro',
  'gerente/planejamento': 'Financeiro',
  'gerente/auditoria': 'Sistema',
  'gerente/configuracoes': 'Sistema',
  'cliente/dashboard': 'Início',
  'cliente/solicitar': 'Empréstimo',
  'cliente/emprestimos': 'Empréstimo',
  'cliente/indicacoes': 'Empréstimo',
  'cliente/score': 'Pessoal',
  'cliente/notificacoes': 'Pessoal',
};

const router = {
  currentPath: null,
  currentParams: {},

  navigate(hash) {
    if (location.hash === hash) { this.handleHashChange(); return; }
    location.hash = hash;
  },

  parseHash() {
    let raw = location.hash.replace(/^#\//, '').replace(/^#/, '');
    if (!raw) raw = isGerente() ? 'gerente/dashboard' : 'cliente/dashboard';
    const segments = raw.split('/');
    return segments;
  },

  matchRoute(segments) {
    // tenta rota exata primeiro; senão tenta trocar o último segmento por :id
    const exact = segments.join('/');
    if (ROUTES[exact]) return { config: ROUTES[exact], params: {} };
    if (segments.length >= 1) {
      const withId = segments.slice(0, -1).concat(':id').join('/');
      if (ROUTES[withId]) return { config: ROUTES[withId], params: { id: segments[segments.length - 1] } };
    }
    return null;
  },

  handleHashChange() {
    if (!App.profile) return; // ainda não autenticado, auth.js cuida da tela de login
    const segments = this.parseHash();
    const match = this.matchRoute(segments);

    if (!match) {
      this.navigate(isGerente() ? '#/gerente/dashboard' : '#/cliente/dashboard');
      return;
    }

    const { config, params } = match;
    const wantsRole = config.role;
    if (wantsRole !== 'any' && ((wantsRole === 'gerente' && !isGerente()) || (wantsRole === 'cliente' && !isCliente()))) {
      this.navigate(isGerente() ? '#/gerente/dashboard' : '#/cliente/dashboard');
      return;
    }
    // Algumas telas de gerente (Planejamento, Configurações) são exclusivas
    // do admin primário — os demais gerentes nem chegam a ver a tela.
    if (config.primaryOnly && !(App.profile && App.profile.is_primary_admin)) {
      this.navigate('#/gerente/dashboard');
      return;
    }
    // 'Indicações' só existe pra cliente que já indicou alguém — acessar via
    // hash direto sem isso redireciona, mesma lógica de primaryOnly acima.
    if (config.referralOnly && !App.hasReferrals) {
      this.navigate('#/cliente/dashboard');
      return;
    }

    this.currentPath = segments.join('/');
    this.currentParams = params;

    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
    const screenEl = document.getElementById('screen-' + config.screenId);
    if (screenEl) screenEl.classList.add('active');

    document.getElementById('topbar-title').textContent = config.title || '';
    // Eyebrow pequeno acima do título — contextual por seção (ver
    // EYEBROW_BY_SECTION acima), com fallback genérico por papel pra
    // qualquer rota nova sem entrada no mapa ainda.
    const eyebrowEl = document.getElementById('topbar-eyebrow');
    if (eyebrowEl) {
      const sectionKey = segments.slice(0, 2).join('/');
      eyebrowEl.textContent = EYEBROW_BY_SECTION[sectionKey]
        || (config.role === 'gerente' ? 'Painel do gerente' : 'Painel do cliente');
    }
    updateActiveNavLinks(this.currentPath);

    if (typeof config.render === 'function') config.render(params);

    window.scrollTo(0, 0);
    closeMobileMoreMenu();
  },

  init() {
    window.addEventListener('hashchange', () => this.handleHashChange());
    this.handleHashChange();
  },
};

function updateActiveNavLinks(currentPath) {
  document.querySelectorAll('[data-route]').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-route') === currentPath);
  });
}

function closeMobileMoreMenu() {
  const menu = document.getElementById('mobile-more-menu');
  const backdrop = document.getElementById('mobile-more-backdrop');
  if (menu) menu.classList.add('hidden');
  if (backdrop) backdrop.classList.add('hidden');
}

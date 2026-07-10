/* ============================================================================
   Router — SPA sem framework, navegação via hash + guarda de rota por papel
   ============================================================================ */

const ROUTES = {}; // path (ex: 'cliente/dashboard') -> { role, render, title }

function registerRoute(path, config) {
  ROUTES[path] = config;
}

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

    this.currentPath = segments.join('/');
    this.currentParams = params;

    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
    const screenEl = document.getElementById('screen-' + config.screenId);
    if (screenEl) screenEl.classList.add('active');

    document.getElementById('topbar-title').textContent = config.title || '';
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

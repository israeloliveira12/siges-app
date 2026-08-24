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

  // Rota de fallback de cada papel. Se o perfil não for nem gerente nem
  // cliente (coluna nula, papel novo ainda não tratado), qualquer redirecionamento
  // "de volta pro dashboard" apontaria pra uma rota que a própria guarda de
  // papel rejeita — e como navigate() chama handleHashChange() direto quando o
  // hash já é o mesmo, isso vira recursão infinita e estouro de pilha (tela
  // branca, sem erro visível). Achado da auditoria de 2026-08-23.
  fallbackRoute() {
    if (isGerente()) return '#/gerente/dashboard';
    if (isCliente()) return '#/cliente/dashboard';
    return null;
  },

  // Redireciona só quando existe destino válido E ele é diferente de onde já
  // estamos. Nos demais casos mostra a tela de rota inválida em vez de entrar
  // em laço.
  redirectTo(hash) {
    const target = hash || this.fallbackRoute();
    if (!target || location.hash === target) {
      renderRouteUnavailable();
      return;
    }
    this.navigate(target);
  },

  handleHashChange() {
    if (!App.profile) return; // ainda não autenticado, auth.js cuida da tela de login
    const segments = this.parseHash();
    const match = this.matchRoute(segments);

    if (!match) {
      this.redirectTo(null);
      return;
    }

    const { config, params } = match;
    const wantsRole = config.role;
    if (wantsRole !== 'any' && (
      (wantsRole === 'gerente' && !isGerente()) ||
      (wantsRole === 'cliente' && !isCliente()) ||
      (wantsRole === 'plataforma' && !isPlatformOwner())
    )) {
      this.redirectTo(null);
      return;
    }
    // Rota de plataforma acessada via hash direto (ex: recarregar a página
    // estando em #/plataforma/empresas) sem o modo estar de fato ligado —
    // sincroniza SÓ o modo (setMode, não switchMode: sem isso a navegação
    // forçava de volta pra #/plataforma/inicio, perdendo a rota pedida —
    // bug real pego no preview ao testar a 2ª rota de plataforma). O resto
    // desta função continua normalmente e renderiza a rota já casada acima.
    if (wantsRole === 'plataforma' && currentMode() !== 'plataforma') {
      setMode('plataforma');
    }
    // Inverso: saiu do modo plataforma (trocou no topbar) mas o hash ainda
    // aponta pra uma rota de plataforma — evita ficar com o menu errado por
    // baixo de uma tela gerente/cliente.
    if (wantsRole !== 'plataforma' && wantsRole !== 'any' && isPlatformOwner() && currentMode() === 'plataforma') {
      setMode('emprestimos');
    }
    // Algumas telas de gerente (Planejamento, Configurações) são exclusivas
    // do admin primário — os demais gerentes nem chegam a ver a tela.
    if (config.primaryOnly && !(App.profile && App.profile.is_primary_admin)) {
      this.redirectTo(null);
      return;
    }
    // 'Indicações' só existe pra cliente que já indicou alguém — acessar via
    // hash direto sem isso redireciona, mesma lógica de primaryOnly acima.
    if (config.referralOnly && !App.hasReferrals) {
      this.redirectTo(null);
      return;
    }
    // Auditoria é exclusiva do Administrador Master — mesma lógica de
    // primaryOnly acima, mas checando platform_owner em vez de is_primary_admin.
    if (config.platformOwnerOnly && !isPlatformOwner()) {
      this.redirectTo(null);
      return;
    }

    this.currentPath = segments.join('/');
    this.currentParams = params;

    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
    const screenEl = document.getElementById('screen-' + config.screenId);
    if (screenEl) screenEl.classList.add('active');

    document.getElementById('topbar-title').textContent = config.title || '';
    document.title = (config.title ? config.title + ' — ' : '') + 'SIGES';
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
    const active = el.getAttribute('data-route') === currentPath;
    el.classList.toggle('active', active);
    // A classe .active é só visual. aria-current="page" é o que faz um leitor
    // de tela anunciar "item atual" ao percorrer o menu (UX-01).
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}

// Estado final quando nem a rota pedida nem o fallback do papel são
// navegáveis — evita a recursão descrita em router.redirectTo() e, sobretudo,
// evita a tela branca sem explicação que o estouro de pilha produzia.
function renderRouteUnavailable() {
  const active = document.querySelector('.screen.active');
  const target = active || document.getElementById('screen-cliente-dashboard');
  if (!target) return;
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  target.classList.add('active');
  target.innerHTML = `
    <div class="card empty-state" style="max-width:460px;margin:40px auto">
      ${Icons.inbox}
      <h3 style="margin:10px 0 6px">Esta tela não está disponível para a sua conta</h3>
      <p class="text-sm text-soft">Se você acredita que deveria ter acesso, fale com o administrador da sua empresa.</p>
      <button class="btn btn-outline mt-14" id="route-unavailable-signout">Sair da conta</button>
    </div>`;
  const btn = document.getElementById('route-unavailable-signout');
  if (btn) btn.onclick = handleSignOut;
}

function closeMobileMoreMenu() {
  const menu = document.getElementById('mobile-more-menu');
  const backdrop = document.getElementById('mobile-more-backdrop');
  if (menu) menu.classList.add('hidden');
  if (backdrop) backdrop.classList.add('hidden');
}

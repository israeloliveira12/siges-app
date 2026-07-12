/* ============================================================================
   Estado global do app (cache local de leitura — NUNCA fonte de verdade de
   saldo/parcela/limite; isso sempre vem do Postgres via RPC/select).
   ============================================================================ */

const App = {
  session: null,       // sessão do Supabase Auth
  profile: null,       // linha de profiles do usuário logado
  client: null,        // linha de clients (só populada se profile.role === 'cliente')
  settings: null,       // system_settings (singleton), lido uma vez após login
  unreadCount: 0,
  hasReferrals: false,  // cliente: já indicou alguém? controla o menu "Indicações"
};

function isGerente() {
  return !!App.profile && App.profile.role === 'gerente';
}

function isCliente() {
  return !!App.profile && App.profile.role === 'cliente';
}

function userDisplayName() {
  if (App.profile && App.profile.full_name) return App.profile.full_name;
  const meta = (App.session && App.session.user.user_metadata) || {};
  return meta.full_name || meta.name || (App.session && App.session.user.email) || 'Usuário';
}

// Modo escuro — escopado em #app via CSS (ver style.css), nunca afeta a tela
// de login. O <html data-theme> é setado bem cedo por um script inline no
// <head> (evita flash claro→escuro no primeiro paint); estas funções só
// trocam o atributo depois de montado e persistem a escolha.
const THEME_STORAGE_KEY = 'siges-theme';

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0F161F' : '#0B416B');
  const btn = document.getElementById('topbar-theme-toggle');
  if (btn) btn.innerHTML = theme === 'dark' ? Icons.sun : Icons.moon;
}

function toggleTheme() {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

// Registra um evento na trilha de auditoria (tela "Auditoria" do admin).
// Nunca deve travar a ação principal — falha de log é silenciosa.
async function logAudit(action, description, metadata) {
  try {
    await supa.rpc('log_audit_event', { p_action: action, p_description: description, p_metadata: metadata || {} });
  } catch (e) { /* auditoria é best-effort */ }
}

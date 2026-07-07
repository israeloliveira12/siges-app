/* ============================================================================
   Estado global do app (cache local de leitura — NUNCA fonte de verdade de
   saldo/parcela/limite; isso sempre vem do Postgres via RPC/select).
   ============================================================================ */

const App = {
  session: null,       // sessão do Supabase Auth
  profile: null,       // linha de profiles do usuário logado
  client: null,        // linha de clients (só populada se profile.role === 'cliente')
  settings: null,       // system_settings (singleton), lido uma vez após login
  rateReference: [],    // loan_rate_reference (tabela VIP), lido uma vez após login
  unreadCount: 0,
};

function localKey(suffix) {
  const uidPart = App.session ? App.session.user.id : 'anon';
  return 'siges_v1_' + uidPart + '_' + suffix;
}

function cacheSet(key, value) {
  try { localStorage.setItem(localKey(key), JSON.stringify(value)); } catch (e) { /* storage indisponível, segue sem cache */ }
}

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(localKey(key));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

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

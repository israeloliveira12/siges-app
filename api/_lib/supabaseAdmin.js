/* ============================================================================
   Cliente Supabase com service_role — SÓ pode ser importado dentro de /api.
   NUNCA importe este arquivo em código que roda no navegador.
   ============================================================================ */

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Todo id vindo de req.body que for interpolado numa URL (path ou query) da
// Admin API/PostgREST PRECISA passar por aqui antes. Sem essa checagem, um
// valor tipo "../../../../rest/v1/<tabela>?id=eq.<uuid>" é normalizado pelo
// parser de URL (padrão WHATWG, usado pelo fetch/undici do Node) e escapa do
// endpoint pretendido — a requisição sai com o header de service_role, que
// ignora RLS por completo. Validar formato de UUID fecha esse vetor.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// Timeout explícito: sem isso, uma requisição pendurada no Supabase segura a
// função serverless até o teto da plataforma matá-la, sem log nenhum sobre o
// que travou (achado da auditoria de 2026-08-23).
const DEFAULT_TIMEOUT_MS = 12000;

export async function supabaseAdminFetch(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 500, data: { message: 'Supabase não configurado no servidor.' } };
  }
  const { timeoutMs, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(SUPABASE_URL + path, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        ...(fetchOptions.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 504, data: { message: e.name === 'AbortError' ? 'Tempo esgotado ao falar com o banco.' : String(e.message || e) } };
  } finally {
    clearTimeout(timer);
  }
}

// Conta linhas SEM trazê-las. `Prefer: count=exact` + `HEAD` devolve o total
// real no cabeçalho Content-Range ("0-24/1337"), que é a única forma de contar
// acima do teto de 1.000 linhas do PostgREST — ler `data.length` de um SELECT
// normal trava nesse teto e reporta menos do que existe (achado OPS-06).
// Devolve null se a contagem não puder ser determinada, para o chamador poder
// distinguir "zero" de "não sei".
export async function countRows(path) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const res = await fetch(SUPABASE_URL + path, {
      method: 'HEAD',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        Prefer: 'count=exact',
        Range: '0-0',
      },
    });
    if (!res.ok && res.status !== 206) return null;
    const range = res.headers.get('content-range') || '';
    const total = range.split('/')[1];
    if (!total || total === '*') return null;
    const n = Number(total);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    return null;
  }
}

// Escapa texto antes de interpolar em HTML de e-mail. `title`/`body` chegam do
// corpo da requisição em /api/notify-event — sem isso, um cliente autenticado
// monta o conteúdo de um e-mail que sai do domínio verificado da financeira
// para a caixa dos administradores dela (achado SEC-04).
export function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Verifica o token de acesso de quem está chamando a function e retorna o
// profile correspondente (usado para checar se é gerente antes de agir).
export async function getCallerProfile(accessToken) {
  if (!accessToken) return null;
  const { ok, data } = await supabaseAdminFetch('/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!ok || !data || !data.id) return null;

  const profileRes = await supabaseAdminFetch(`/rest/v1/profiles?id=eq.${data.id}&select=id,role,active,is_primary_admin,platform_owner,tenant_id`, { method: 'GET' });
  if (!profileRes.ok || !Array.isArray(profileRes.data) || !profileRes.data.length) return null;
  return profileRes.data[0];
}

// Busca o profile de um usuário-ALVO (não quem chama) — usado por
// endpoints que editam OUTRA conta (reset de senha, troca de e-mail), pra
// checar se o alvo é um gerente antes de decidir se o caller precisa ser
// is_primary_admin (só o admin primário mexe em conta de gerente).
export async function getTargetProfile(userId) {
  // Valida aqui dentro também, não só nos chamadores: os três atuais chamam
  // isValidUUID() antes, mas a função interpola o parâmetro numa URL com
  // service_role — o próximo chamador que esquecer reabriria o vetor descrito
  // no topo deste arquivo (achado SEC-11).
  if (!isValidUUID(userId)) return null;
  const res = await supabaseAdminFetch(`/rest/v1/profiles?id=eq.${userId}&select=id,role,is_primary_admin,tenant_id`, { method: 'GET' });
  if (!res.ok || !Array.isArray(res.data) || !res.data.length) return null;
  return res.data[0];
}

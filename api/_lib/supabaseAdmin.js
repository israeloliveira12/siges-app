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

export async function supabaseAdminFetch(path, options = {}) {
  const res = await fetch(SUPABASE_URL + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Verifica o token de acesso de quem está chamando a function e retorna o
// profile correspondente (usado para checar se é gerente antes de agir).
export async function getCallerProfile(accessToken) {
  if (!accessToken) return null;
  const { ok, data } = await supabaseAdminFetch('/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!ok || !data || !data.id) return null;

  const profileRes = await supabaseAdminFetch(`/rest/v1/profiles?id=eq.${data.id}&select=id,role,active,is_primary_admin`, { method: 'GET' });
  if (!profileRes.ok || !Array.isArray(profileRes.data) || !profileRes.data.length) return null;
  return profileRes.data[0];
}

// Busca o profile de um usuário-ALVO (não quem chama) — usado por
// endpoints que editam OUTRA conta (reset de senha, troca de e-mail), pra
// checar se o alvo é um gerente antes de decidir se o caller precisa ser
// is_primary_admin (só o admin primário mexe em conta de gerente).
export async function getTargetProfile(userId) {
  const res = await supabaseAdminFetch(`/rest/v1/profiles?id=eq.${userId}&select=id,role,is_primary_admin`, { method: 'GET' });
  if (!res.ok || !Array.isArray(res.data) || !res.data.length) return null;
  return res.data[0];
}

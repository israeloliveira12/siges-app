/* ============================================================================
   POST /api/create-tenant
   Cria uma nova empresa cliente da plataforma (tenant) + sua primeira conta
   de administrador — só pode ser chamado pelo Administrador Master
   (platform_owner). Nunca exponha a service_role key no navegador.
   Body: { company_name, admin_full_name, admin_email, admin_password }
   ============================================================================ */

import { supabaseAdminFetch, getCallerProfile } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return; }

  const authHeader = req.headers.authorization || '';
  const accessToken = authHeader.replace('Bearer ', '').trim();
  if (!accessToken) { res.status(401).json({ error: 'Token ausente' }); return; }

  const caller = await getCallerProfile(accessToken);
  if (!caller || !caller.platform_owner || !caller.active) {
    res.status(403).json({ error: 'Apenas o Administrador Master pode criar novas empresas.' });
    return;
  }

  const { company_name, admin_full_name, admin_email, admin_password } = req.body || {};
  if (!company_name || !String(company_name).trim() || !admin_email || !admin_password) {
    res.status(400).json({ error: 'Parâmetros inválidos.' });
    return;
  }
  if (admin_password.length < 6) { res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' }); return; }

  // Cria o tenant primeiro (sem owner_profile_id ainda) pra ter o id pronto
  // pra ir no user_metadata do admin — handle_new_user() (trigger em
  // auth.users) lê esse campo pra resolver o tenant certo (mesmo mecanismo
  // já usado por create-user.js). Se a criação do usuário falhar depois,
  // o tenant órfão é removido (rollback manual, já que não há transação
  // entre a Auth Admin API e o Postgres direto).
  const tenantRes = await supabaseAdminFetch('/rest/v1/tenants', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name: String(company_name).trim() }),
  });
  if (!tenantRes.ok || !Array.isArray(tenantRes.data) || !tenantRes.data.length) {
    res.status(500).json({ error: 'Falha ao criar a empresa.' });
    return;
  }
  const newTenantId = tenantRes.data[0].id;

  const createUserRes = await supabaseAdminFetch('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email: admin_email, password: admin_password, email_confirm: true,
      user_metadata: { full_name: admin_full_name || '', tenant_id: newTenantId },
    }),
  });

  if (!createUserRes.ok) {
    await supabaseAdminFetch(`/rest/v1/tenants?id=eq.${newTenantId}`, { method: 'DELETE' });
    res.status(400).json({ error: createUserRes.data.msg || createUserRes.data.error_description || 'Falha ao criar a conta de administrador da empresa.' });
    return;
  }

  const newAdminId = createUserRes.data.id;

  // O trigger handle_new_user() já cria o profile com role='cliente' por
  // padrão — promove pra gerente + admin primário DESTE tenant.
  const promoteRes = await supabaseAdminFetch(`/rest/v1/profiles?id=eq.${newAdminId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ role: 'gerente', is_primary_admin: true, full_name: admin_full_name || '', created_by: caller.id }),
  });
  if (!promoteRes.ok) {
    res.status(500).json({ error: 'Empresa e usuário criados, mas falhou ao promover a conta a administrador.' });
    return;
  }

  await supabaseAdminFetch(`/rest/v1/tenants?id=eq.${newTenantId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ owner_profile_id: newAdminId }),
  });

  res.status(200).json({ ok: true, tenant_id: newTenantId, admin_user_id: newAdminId });
}

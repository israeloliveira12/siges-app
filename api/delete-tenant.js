/* ============================================================================
   POST /api/delete-tenant
   Apaga uma empresa (tenant) por completo — dados de negócio, todas as
   contas (gerentes + clientes) e por fim o próprio registro em `tenants`.
   Irreversível. Só o Administrador Master (platform_owner) pode chamar, e
   só funciona com a empresa já suspensa (a RPC prepare_tenant_deletion
   valida isso e nunca deixa apagar a própria empresa de quem chama).
   Body: { tenant_id }
   ============================================================================ */

import { supabaseAdminFetch, getCallerProfile, isValidUUID } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return; }

  const accessToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const caller = await getCallerProfile(accessToken);
  if (!caller || !caller.platform_owner || !caller.active) {
    res.status(403).json({ error: 'Apenas o Administrador Master pode excluir uma empresa.' });
    return;
  }

  const { tenant_id } = req.body || {};
  if (!isValidUUID(tenant_id)) { res.status(400).json({ error: 'Parâmetros inválidos.' }); return; }

  // 1. RPC valida tudo (não é a própria empresa, já está suspensa) e apaga
  // todo o dado de negócio do tenant — devolve os profile_id restantes
  // (gerentes + clientes) pra este endpoint apagar via Admin API.
  const rpcRes = await supabaseAdminFetch('/rest/v1/rpc/prepare_tenant_deletion', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken },
    body: JSON.stringify({ p_tenant_id: tenant_id }),
  });
  if (!rpcRes.ok) {
    res.status(400).json({ error: rpcRes.data.message || 'Falha ao preparar a exclusão da empresa.' });
    return;
  }
  const profileIds = Array.isArray(rpcRes.data) ? rpcRes.data : [];

  // 2. Apaga cada conta (Admin API) — cascateia profiles/clients automaticamente.
  let deletedUsers = 0;
  for (const id of profileIds) {
    const delRes = await supabaseAdminFetch(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
    if (delRes.ok) deletedUsers++;
  }

  // 3. Só agora, sem nenhum profile mais referenciando o tenant, apaga a
  // linha de tenants em si.
  const finalizeRes = await supabaseAdminFetch(`/rest/v1/tenants?id=eq.${tenant_id}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
  if (!finalizeRes.ok) {
    res.status(500).json({ error: 'Contas removidas, mas falhou ao apagar o registro da empresa. Tente excluir novamente.' });
    return;
  }

  res.status(200).json({ ok: true, deleted_users: deletedUsers });
}

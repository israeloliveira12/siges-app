/* ============================================================================
   POST /api/wipe-all-data — apaga TODOS os dados de negócio do sistema
   (clientes, contratos, parcelas, pagamentos, notificações). Só pode ser
   chamado pelo admin primário (profiles.is_primary_admin = true).

   1. Chama a RPC wipe_all_business_data() (apaga tabelas de negócio + linhas
      de profiles/clients dos clientes, mas não alcança auth.users).
   2. Remove as contas de auth.users dos clientes via Admin API (isso cascateia
      de volta para profiles/clients, que já estão vazios a essa altura).
   ============================================================================ */

import { supabaseAdminFetch, getCallerProfile } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return; }

  const accessToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const caller = await getCallerProfile(accessToken);
  if (!caller || !caller.is_primary_admin || !caller.active) {
    res.status(403).json({ error: 'Apenas o administrador primário pode apagar todos os dados.' });
    return;
  }

  // 1. Busca os clientes do PRÓPRIO TENANT do chamador, ANTES de apagar (pra
  // depois remover o auth.users de cada um). Fase 1c (SaaS multi-empresa):
  // sem o filtro de tenant_id abaixo, esta busca trazia TODOS os clientes da
  // PLATAFORMA inteira — mesmo com wipe_all_business_data() já corrigida
  // para só apagar dado do próprio tenant, este passo continuaria excluindo
  // a CONTA DE LOGIN (auth.users) de clientes de QUALQUER outra empresa,
  // destruindo o acesso deles mesmo com os dados de negócio preservados.
  const clientsRes = await supabaseAdminFetch(
    `/rest/v1/profiles?role=eq.cliente&tenant_id=eq.${caller.tenant_id}&select=id`,
    { method: 'GET' }
  );
  const clientIds = clientsRes.ok ? clientsRes.data.map((c) => c.id) : [];

  // 2. Apaga todas as tabelas de negócio + as linhas de profiles/clients dos clientes
  const rpcRes = await supabaseAdminFetch('/rest/v1/rpc/wipe_all_business_data', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken },
    body: JSON.stringify({}),
  });
  if (!rpcRes.ok) {
    res.status(500).json({ error: rpcRes.data.message || 'Falha ao apagar dados de negócio.' });
    return;
  }

  // 3. Remove as contas de autenticação dos clientes (não afeta gerentes/admins)
  let deletedClients = 0;
  for (const id of clientIds) {
    const delRes = await supabaseAdminFetch(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
    if (delRes.ok) deletedClients++;
  }

  res.status(200).json({ ok: true, deleted_clients: deletedClients });
}

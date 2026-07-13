/* ============================================================================
   POST /api/delete-client — exclui permanentemente a conta de um cliente
   (auth.users, que cascateia para profiles/clients). Bloqueado pelo próprio
   banco (FK sem cascade) se o cliente já tiver contratos — nesse caso, a
   Admin API retorna erro e nada é apagado.
   ============================================================================ */

import { supabaseAdminFetch, getCallerProfile, getTargetProfile, isValidUUID } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return; }

  const accessToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const caller = await getCallerProfile(accessToken);
  if (!caller || caller.role !== 'gerente' || !caller.active) {
    res.status(403).json({ error: 'Apenas administradores podem excluir clientes.' });
    return;
  }

  const { client_id } = req.body || {};
  if (!client_id) { res.status(400).json({ error: 'client_id ausente' }); return; }
  if (!isValidUUID(client_id)) { res.status(400).json({ error: 'client_id inválido' }); return; }

  // Este endpoint só existe pra excluir CLIENTE — sem essa checagem, qualquer
  // gerente secundário ativo conseguia passar o profile_id de OUTRO gerente
  // (inclusive o Administrador primário) como client_id: a checagem de
  // contratos abaixo sempre dá vazio pra uma conta de gerente (nunca é
  // client_id de contrato nenhum), e a exclusão seguia em frente.
  const target = await getTargetProfile(client_id);
  if (!target || target.role !== 'cliente') {
    res.status(400).json({ error: 'Este endpoint só pode excluir contas de cliente.' });
    return;
  }

  const contractsRes = await supabaseAdminFetch(`/rest/v1/loan_contracts?client_id=eq.${client_id}&select=id&limit=1`, { method: 'GET' });
  if (contractsRes.ok && Array.isArray(contractsRes.data) && contractsRes.data.length) {
    res.status(409).json({ error: 'Este cliente já tem contratos registrados e não pode ser excluído (para preservar o histórico financeiro).' });
    return;
  }

  const delRes = await supabaseAdminFetch(`/auth/v1/admin/users/${client_id}`, { method: 'DELETE' });
  if (!delRes.ok) {
    res.status(400).json({ error: delRes.data.msg || 'Falha ao excluir cliente.' });
    return;
  }

  res.status(200).json({ ok: true });
}

/* ============================================================================
   POST /api/reset-client-password — admin define uma nova senha de login pra
   um usuário (cliente ou gerente) via service_role. Existe porque o Supabase
   Auth guarda a senha como hash irreversível — não há como "ver" a senha
   atual/trocada pelo próprio usuário, só definir uma nova.
   Body: { user_id, new_password }
   ============================================================================ */

import { supabaseAdminFetch, getCallerProfile, getTargetProfile, isValidUUID } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return; }

  const accessToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const caller = await getCallerProfile(accessToken);
  if (!caller || caller.role !== 'gerente' || !caller.active) {
    res.status(403).json({ error: 'Apenas administradores podem redefinir a senha de um usuário.' });
    return;
  }

  const { user_id, new_password } = req.body || {};
  if (!user_id || !new_password) { res.status(400).json({ error: 'Parâmetros inválidos.' }); return; }
  if (!isValidUUID(user_id)) { res.status(400).json({ error: 'user_id inválido' }); return; }
  if (String(new_password).length < 6) { res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' }); return; }

  // Redefinir a senha de OUTRO gerente (inclusive o admin primário) é
  // exclusivo do admin primário — senão um gerente secundário conseguiria
  // resetar a senha de qualquer outra conta administrativa e assumi-la.
  // O alvo precisa EXISTIR pra essa checagem valer alguma coisa — um target
  // nulo (id que não resolve a nenhum profile) não pode silenciosamente
  // pular a validação, senão a checagem de papel vira decorativa.
  const target = await getTargetProfile(user_id);
  if (!target) { res.status(404).json({ error: 'Usuário não encontrado.' }); return; }
  if (target.role === 'gerente' && !caller.is_primary_admin) {
    res.status(403).json({ error: 'Apenas o Administrador pode redefinir a senha de uma conta de gerente.' });
    return;
  }

  const updateRes = await supabaseAdminFetch(`/auth/v1/admin/users/${user_id}`, {
    method: 'PUT',
    body: JSON.stringify({ password: new_password }),
  });
  if (!updateRes.ok) {
    res.status(400).json({ error: updateRes.data.msg || updateRes.data.error_description || 'Falha ao redefinir a senha.' });
    return;
  }

  res.status(200).json({ ok: true });
}

/* ============================================================================
   POST /api/update-user-email — troca o e-mail de login de um cliente/gerente.
   Precisa de service_role porque auth.users não é editável pelo anon key nem
   pela RPC normal (update_client_profile só mexe em profiles/clients).
   Atualiza tanto auth.users.email (login real) quanto profiles.email (usado
   por email_for_cpf() no login por CPF) — os dois têm que ficar em sincronia.
   Body: { user_id, new_email }
   ============================================================================ */

import { supabaseAdminFetch, getCallerProfile } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return; }

  const accessToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const caller = await getCallerProfile(accessToken);
  if (!caller || caller.role !== 'gerente' || !caller.active) {
    res.status(403).json({ error: 'Apenas administradores podem alterar o e-mail de um usuário.' });
    return;
  }

  const { user_id, new_email } = req.body || {};
  if (!user_id || !new_email) { res.status(400).json({ error: 'Parâmetros inválidos.' }); return; }

  const email = String(new_email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Informe um e-mail válido.' });
    return;
  }

  const updateAuthRes = await supabaseAdminFetch(`/auth/v1/admin/users/${user_id}`, {
    method: 'PUT',
    body: JSON.stringify({ email, email_confirm: true }),
  });
  if (!updateAuthRes.ok) {
    const msg = updateAuthRes.data.msg || updateAuthRes.data.error_description || '';
    if (msg.toLowerCase().includes('already been registered') || msg.toLowerCase().includes('already exists')) {
      res.status(409).json({ error: 'Já existe uma conta com esse e-mail.' });
      return;
    }
    res.status(400).json({ error: msg || 'Falha ao atualizar o e-mail.' });
    return;
  }

  const updateProfileRes = await supabaseAdminFetch(`/rest/v1/profiles?id=eq.${user_id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ email }),
  });
  if (!updateProfileRes.ok) {
    res.status(500).json({ error: 'E-mail de login atualizado, mas falhou ao sincronizar com o cadastro. Avise o suporte.' });
    return;
  }

  res.status(200).json({ ok: true });
}

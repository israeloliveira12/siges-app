/* ============================================================================
   POST /api/create-user
   Cria um usuário (cliente ou gerente) via service_role — só pode ser chamado
   por um gerente autenticado. Nunca exponha a service_role key no navegador.
   Body: { email, password, full_name, role: 'cliente' | 'gerente' }
   ============================================================================ */

import { supabaseAdminFetch, getCallerProfile } from './_lib/supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return; }

  const authHeader = req.headers.authorization || '';
  const accessToken = authHeader.replace('Bearer ', '').trim();
  if (!accessToken) { res.status(401).json({ error: 'Token ausente' }); return; }

  const caller = await getCallerProfile(accessToken);
  if (!caller || caller.role !== 'gerente' || !caller.active) {
    res.status(403).json({ error: 'Apenas gerentes podem criar novos usuários.' });
    return;
  }

  const { email, password, full_name, role } = req.body || {};
  if (!email || !password || !role || !['cliente', 'gerente'].includes(role)) {
    res.status(400).json({ error: 'Parâmetros inválidos.' });
    return;
  }
  if (password.length < 6) { res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' }); return; }

  // Só o admin primário pode criar novas contas de gerente — qualquer
  // gerente comum ainda pode criar clientes normalmente.
  if (role === 'gerente' && !caller.is_primary_admin) {
    res.status(403).json({ error: 'Apenas o administrador primário pode criar novas contas de gerente.' });
    return;
  }

  const createRes = await supabaseAdminFetch('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email, password, email_confirm: true,
      user_metadata: { full_name: full_name || '' },
    }),
  });

  if (!createRes.ok) {
    res.status(400).json({ error: createRes.data.msg || createRes.data.error_description || 'Falha ao criar usuário.' });
    return;
  }

  const newUserId = createRes.data.id;

  // O trigger handle_new_user() já cria profiles com role='cliente' por padrão.
  // Se for gerente, promove explicitamente aqui.
  if (role === 'gerente') {
    const updateRes = await supabaseAdminFetch(`/rest/v1/profiles?id=eq.${newUserId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ role: 'gerente', full_name: full_name || '', created_by: caller.id }),
    });
    if (!updateRes.ok) {
      res.status(500).json({ error: 'Usuário criado, mas falhou ao definir papel de gerente.' });
      return;
    }
  } else {
    await supabaseAdminFetch(`/rest/v1/profiles?id=eq.${newUserId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ full_name: full_name || '', created_by: caller.id }),
    });
  }

  res.status(200).json({ ok: true, user_id: newUserId });
}

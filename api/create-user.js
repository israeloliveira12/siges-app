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

  // Fase 5 (planos): limite de gerentes/clientes por plano. Sem plano
  // atribuído (a grande maioria hoje) = sem limite, zero mudança de
  // comportamento. Verifica ANTES de criar a conta — nunca depois.
  const tenantRes = await supabaseAdminFetch(`/rest/v1/tenants?id=eq.${caller.tenant_id}&select=plan_id`, { method: 'GET' });
  const planId = tenantRes.ok && tenantRes.data[0] && tenantRes.data[0].plan_id;
  let limits = {};
  if (planId) {
    const planRes = await supabaseAdminFetch(`/rest/v1/plans?id=eq.${planId}&select=limits`, { method: 'GET' });
    limits = (planRes.ok && planRes.data[0] && planRes.data[0].limits) || {};
  }
  const limitKey = role === 'gerente' ? 'max_gerentes' : 'max_clientes';
  const maxAllowed = limits[limitKey];
  if (typeof maxAllowed === 'number') {
    const countRes = await supabaseAdminFetch(
      `/rest/v1/profiles?role=eq.${role}&tenant_id=eq.${caller.tenant_id}&select=id`,
      { method: 'GET' }
    );
    const currentCount = countRes.ok ? countRes.data.length : 0;
    if (currentCount >= maxAllowed) {
      res.status(403).json({ error: `Limite de ${role === 'gerente' ? 'gerentes' : 'clientes'} do plano atual atingido (${maxAllowed}).` });
      return;
    }
  }

  // tenant_id vai em user_metadata pra handle_new_user() (trigger em
  // auth.users, banco) resolver o tenant certo — Fase 1c (SaaS multi-
  // empresa): sem isso, TODO usuário criado por QUALQUER gerente caía no
  // Tenant #1 (fallback de default_tenant_id()), não importa de qual
  // empresa o gerente que criou realmente era.
  const createRes = await supabaseAdminFetch('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email, password, email_confirm: true,
      user_metadata: { full_name: full_name || '', tenant_id: caller.tenant_id },
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

/* ============================================================================
   POST /api/notify-event — dispara e-mail + push para um evento pontual
   (solicitação criada/aprovada/reprovada, contrato criado, pagamento,
   renovação). O registro "in_app" já é feito pelas RPCs do banco para os
   eventos iniciados pelo gerente; aqui cuidamos de e-mail/push, e do in_app
   também para "solicitacao_criada" (que não passa por nenhuma RPC).
   ============================================================================ */

import { supabaseAdminFetch, getCallerProfile } from './_lib/supabaseAdmin.js';
import { sendEmailViaResend } from './_lib/email.js';
import { sendEmptyPush } from './_lib/webpush.js';

const EMAIL_SUBJECTS = {
  solicitacao_criada: 'Nova solicitação de empréstimo — SIGES',
  solicitacao_aprovada: 'Sua solicitação foi aprovada — SIGES',
  solicitacao_reprovada: 'Atualização sobre sua solicitação — SIGES',
  contrato_criado: 'Novo contrato criado — SIGES',
  pagamento_recebido: 'Recebemos seu pagamento — SIGES',
  renovacao_registrada: 'Sua dívida foi renovada — SIGES',
};

async function dispatchToRecipient({ recipientId, email, event, title, body }) {
  await Promise.allSettled([
    (async () => {
      const result = await sendEmailViaResend({
        to: email,
        subject: EMAIL_SUBJECTS[event] || 'SIGES',
        html: `<div style="font-family:Arial,sans-serif"><h2 style="color:#0B416B">${title}</h2><p>${body}</p><p style="color:#5B6B74;font-size:12px">Siges Serviços Financeiros</p></div>`,
      });
      // Grava o resultado do envio (mesmo em caso de falha) — permite
      // diagnosticar problemas de entrega (ex: domínio do Resend não
      // verificado) direto na tabela, sem precisar checar logs do servidor.
      await supabaseAdminFetch('/rest/v1/notifications_log', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          recipient_id: recipientId, event, channel: 'email', title, body,
          delivery_status: result.ok ? 'sent' : 'failed',
          provider_response: result.ok ? result.data : { error: result.error, ...result.data },
        }),
      });
    })(),
    (async () => {
      const subsRes = await supabaseAdminFetch(`/rest/v1/push_subscriptions?profile_id=eq.${recipientId}&select=*`, { method: 'GET' });
      const subs = subsRes.ok ? subsRes.data : [];
      for (const sub of subs) {
        try {
          const r = await sendEmptyPush(sub);
          if (r.status === 404 || r.status === 410) {
            await supabaseAdminFetch(`/rest/v1/push_subscriptions?id=eq.${sub.id}`, { method: 'DELETE' });
          }
        } catch (e) { /* falha isolada de uma inscrição não deve travar o restante */ }
      }
    })(),
  ]);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return; }

  const accessToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const caller = await getCallerProfile(accessToken);
  if (!caller) { res.status(401).json({ error: 'Não autorizado' }); return; }

  const { event, client_id, title, body } = req.body || {};
  if (!event || !title || !body) { res.status(400).json({ error: 'Parâmetros ausentes' }); return; }

  if (!caller.active) { res.status(403).json({ error: 'Conta desativada' }); return; }

  if (event === 'solicitacao_criada') {
    if (caller.role !== 'cliente') { res.status(403).json({ error: 'Apenas clientes disparam este evento' }); return; }

    const gerentesRes = await supabaseAdminFetch('/rest/v1/profiles?role=eq.gerente&active=eq.true&select=id,email', { method: 'GET' });
    const gerentes = gerentesRes.ok ? gerentesRes.data : [];

    for (const g of gerentes) {
      await supabaseAdminFetch('/rest/v1/notifications_log', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ recipient_id: g.id, event, channel: 'in_app', title, body }),
      });
      await dispatchToRecipient({ recipientId: g.id, email: g.email, event, title, body });
    }
    res.status(200).json({ ok: true, notified: gerentes.length });
    return;
  }

  // Demais eventos: só o gerente dispara, sempre sobre um cliente específico.
  if (caller.role !== 'gerente') { res.status(403).json({ error: 'Apenas gerentes disparam este evento' }); return; }
  if (!client_id) { res.status(400).json({ error: 'client_id ausente' }); return; }

  const clientRes = await supabaseAdminFetch(`/rest/v1/profiles?id=eq.${client_id}&select=id,email`, { method: 'GET' });
  const client = clientRes.ok && clientRes.data[0];
  if (!client) { res.status(404).json({ error: 'Cliente não encontrado' }); return; }

  await dispatchToRecipient({ recipientId: client.id, email: client.email, event, title, body });
  res.status(200).json({ ok: true, notified: 1 });
}

/* ============================================================================
   POST /api/notify-event — dispara e-mail + push para um evento pontual
   (solicitação criada/aprovada/reprovada, contrato criado, pagamento,
   renovação). O registro "in_app" já é feito pelas RPCs do banco para os
   eventos iniciados pelo gerente; aqui cuidamos de e-mail/push, e do in_app
   também para "solicitacao_criada" (que não passa por nenhuma RPC).

   SEC-04 (auditoria 2026-08-23): o corpo da requisição NÃO manda mais o texto
   do e-mail. Antes, `title` e `body` vinham crus do navegador e eram
   interpolados sem escape dentro do HTML — para o evento `solicitacao_criada`
   quem dispara é o CLIENTE e quem recebe são todos os administradores da
   empresa dele, ou seja, um cliente cadastrado montava o conteúdo de um
   e-mail saindo do domínio verificado da financeira. Agora o texto é gerado
   AQUI, a partir do tipo de evento e de um contexto numérico validado; o
   único campo livre que sobrou é `reason` (motivo da reprovação, escrito pelo
   gerente), com teto de tamanho e escapado no template.

   Body: { event, client_id, context?: { amount, remaining, due_date,
           contract_number, reason } }
   ============================================================================ */

import { supabaseAdminFetch, getCallerProfile, isValidUUID, escapeHtml } from './_lib/supabaseAdmin.js';
import { sendEmailViaResend, renderEmailHtml } from './_lib/email.js';
import { sendPush } from './_lib/webpush.js';

const EMAIL_SUBJECTS = {
  solicitacao_criada: 'Nova solicitação de empréstimo — SIGES',
  solicitacao_aprovada: 'Sua solicitação foi aprovada — SIGES',
  solicitacao_reprovada: 'Atualização sobre sua solicitação — SIGES',
  contrato_criado: 'Novo contrato criado — SIGES',
  pagamento_recebido: 'Recebemos seu pagamento — SIGES',
  renovacao_registrada: 'Sua dívida foi renovada — SIGES',
};

const ALLOWED_EVENTS = Object.keys(EMAIL_SUBJECTS);

function brl(v) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function dateBR(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return null;
  return String(iso).split('-').reverse().join('/');
}

// Monta título e corpo no SERVIDOR. `ctx` já vem saneado por sanitizeContext().
function buildMessage(event, ctx, actorName) {
  const contrato = ctx.contract_number ? ` do contrato #${ctx.contract_number}` : '';
  switch (event) {
    case 'solicitacao_criada':
      return {
        title: 'Nova solicitação de empréstimo',
        body: `${actorName} solicitou ${ctx.amount || 'um empréstimo'}.`,
      };
    case 'solicitacao_aprovada':
      return {
        title: 'Cadastro aprovado',
        body: 'Sua conta foi aprovada. Você já pode usar o SIGES normalmente.',
      };
    case 'solicitacao_reprovada':
      return {
        title: 'Atualização sobre seu cadastro',
        body: ctx.reason
          ? `Seu pedido não foi aprovado. Motivo: ${ctx.reason}`
          : 'Seu pedido não foi aprovado. Fale com a empresa para mais detalhes.',
      };
    case 'contrato_criado':
      return {
        title: 'Novo contrato criado',
        body: `Seu contrato${contrato}${ctx.amount ? ` no valor de ${ctx.amount}` : ''} foi aprovado e criado.`,
      };
    case 'pagamento_recebido':
      return ctx.remaining
        ? {
            title: 'Pagamento parcial recebido',
            body: `Recebemos ${ctx.amount}${contrato}. Restam ${ctx.remaining} desta parcela.`,
          }
        : {
            title: 'Pagamento recebido',
            body: `Recebemos seu pagamento${ctx.amount ? ` de ${ctx.amount}` : ''}${contrato}.`,
          };
    case 'renovacao_registrada':
      return {
        title: 'Renovação registrada',
        body: `Recebemos os juros${ctx.amount ? ` de ${ctx.amount}` : ''}. Sua dívida${contrato} foi renovada${ctx.due_date ? `, novo vencimento ${ctx.due_date}` : ''}.`,
      };
    default:
      return { title: 'SIGES', body: 'Você tem uma nova atualização no sistema.' };
  }
}

// Só tipos primitivos, já formatados, com teto de tamanho. Nada aqui chega
// ao HTML sem passar por renderEmailHtml(), que escapa tudo de novo.
function sanitizeContext(raw) {
  const ctx = raw && typeof raw === 'object' ? raw : {};
  const num = Number(ctx.contract_number);
  return {
    amount: brl(ctx.amount),
    remaining: brl(ctx.remaining),
    due_date: dateBR(ctx.due_date),
    contract_number: Number.isInteger(num) && num > 0 ? num : null,
    reason: typeof ctx.reason === 'string' ? ctx.reason.trim().slice(0, 300) : null,
  };
}

async function dispatchToRecipient({ recipientId, email, event, title, body, companyName }) {
  await Promise.allSettled([
    (async () => {
      if (!email) return;
      const result = await sendEmailViaResend({
        to: email,
        subject: EMAIL_SUBJECTS[event] || 'SIGES',
        html: renderEmailHtml({ title, body, companyName }),
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
          // UX-19: o push carrega o texto real. Antes ia vazio e o service
          // worker sempre caía no genérico "Você tem uma nova notificação".
          const r = await sendPush(sub, { title, body, url: './#/cliente/dashboard' });
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
  if (!caller.active) { res.status(403).json({ error: 'Conta desativada' }); return; }

  const { event, client_id, context } = req.body || {};
  if (!event || !ALLOWED_EVENTS.includes(event)) {
    res.status(400).json({ error: 'Evento inválido' });
    return;
  }
  const ctx = sanitizeContext(context);

  // Nome da empresa do remetente, pro rodapé do e-mail.
  const settingsRes = await supabaseAdminFetch(
    `/rest/v1/system_settings?tenant_id=eq.${caller.tenant_id}&select=company_name`,
    { method: 'GET' }
  );
  const companyName = (settingsRes.ok && settingsRes.data[0] && settingsRes.data[0].company_name) || null;

  if (event === 'solicitacao_criada') {
    if (caller.role !== 'cliente') { res.status(403).json({ error: 'Apenas clientes disparam este evento' }); return; }

    // Nome do solicitante vem do PERFIL do chamador, nunca do corpo da
    // requisição — é a diferença entre "o cliente informa quem é" e "o
    // servidor sabe quem é".
    const meRes = await supabaseAdminFetch(`/rest/v1/profiles?id=eq.${caller.id}&select=full_name`, { method: 'GET' });
    const actorName = (meRes.ok && meRes.data[0] && meRes.data[0].full_name) || 'Um cliente';
    const { title, body } = buildMessage(event, ctx, actorName);

    // Fase 1c (SaaS multi-empresa): sem o filtro de tenant_id, uma
    // solicitação de empréstimo notificava TODO gerente ativo da
    // PLATAFORMA inteira, não só os do tenant do cliente que solicitou.
    const gerentesRes = await supabaseAdminFetch(
      `/rest/v1/profiles?role=eq.gerente&active=eq.true&tenant_id=eq.${caller.tenant_id}&select=id,email`,
      { method: 'GET' }
    );
    const gerentes = gerentesRes.ok ? gerentesRes.data : [];

    for (const g of gerentes) {
      await supabaseAdminFetch('/rest/v1/notifications_log', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ recipient_id: g.id, event, channel: 'in_app', title, body, tenant_id: caller.tenant_id }),
      });
      await dispatchToRecipient({ recipientId: g.id, email: g.email, event, title, body, companyName });
    }
    res.status(200).json({ ok: true, notified: gerentes.length });
    return;
  }

  // Demais eventos: só o gerente dispara, sempre sobre um cliente específico.
  if (caller.role !== 'gerente') { res.status(403).json({ error: 'Apenas gerentes disparam este evento' }); return; }
  // SEC-09: este era o único endpoint que interpolava um id vindo do corpo da
  // requisição direto na URL do PostgREST sem validar formato — exatamente
  // contra a regra escrita no cabeçalho de _lib/supabaseAdmin.js.
  if (!isValidUUID(client_id)) { res.status(400).json({ error: 'client_id inválido' }); return; }

  // Fase 1c: filtro de tenant_id evita que um gerente dispare notificação
  // pra um cliente de OUTRA empresa da plataforma.
  const clientRes = await supabaseAdminFetch(
    `/rest/v1/profiles?id=eq.${client_id}&tenant_id=eq.${caller.tenant_id}&select=id,email`,
    { method: 'GET' }
  );
  const client = clientRes.ok && clientRes.data[0];
  if (!client) { res.status(404).json({ error: 'Cliente não encontrado' }); return; }

  const { title, body } = buildMessage(event, ctx, null);
  await dispatchToRecipient({ recipientId: client.id, email: client.email, event, title, body, companyName });
  res.status(200).json({ ok: true, notified: 1 });
}

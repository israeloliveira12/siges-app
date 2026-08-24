/* ============================================================================
   Envio de e-mail transacional via Resend (REST simples via fetch nativo)
   ============================================================================ */

import { escapeHtml } from './supabaseAdmin.js';

export async function sendEmailViaResend({ to, subject, html }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'SIGES <onboarding@resend.dev>';
  if (!RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY não configurada' };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND_API_KEY },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

// Único lugar que monta o HTML de um e-mail do sistema. Todo texto variável
// passa por escapeHtml() aqui dentro — nenhum chamador deve montar HTML por
// conta própria (foi exatamente isso que abriu o achado SEC-04: title/body
// vinham crus do corpo da requisição direto pro innerHTML do e-mail).
export function renderEmailHtml({ title, body, companyName }) {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  const safeCompany = escapeHtml(companyName || 'Siges Serviços Financeiros');
  return `<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:0;background:#F4F6F7">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F7;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E2E8EA;border-radius:14px;overflow:hidden">
        <tr><td style="background:#0B416B;padding:16px 22px">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#FFFFFF;letter-spacing:.5px">SIGES</span>
        </td></tr>
        <tr><td style="padding:24px 22px">
          <h1 style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:19px;line-height:1.3;color:#14212B">${safeTitle}</h1>
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#14212B">${safeBody}</p>
        </td></tr>
        <tr><td style="padding:14px 22px 20px;border-top:1px solid #E2E8EA">
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#5B6B74">
            ${safeCompany}<br>
            Você recebeu este aviso porque tem um cadastro ativo no sistema.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

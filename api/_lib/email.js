/* ============================================================================
   Envio de e-mail transacional via Resend (REST simples via fetch nativo)
   ============================================================================ */

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

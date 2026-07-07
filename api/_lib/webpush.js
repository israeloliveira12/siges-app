/* ============================================================================
   Web Push "vazio" via VAPID, usando só o módulo nativo `crypto` do Node
   (sem npm 'web-push'), conforme a arquitetura sem build da skill.
   ============================================================================ */

import crypto from 'crypto';

function b64urlToBuffer(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  return Buffer.from(b64, 'base64');
}

function bufferToB64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildVapidJwt(audience) {
  const publicKeyRaw = b64urlToBuffer(process.env.VAPID_PUBLIC_KEY);
  const privateD = b64urlToBuffer(process.env.VAPID_PRIVATE_KEY);
  const x = publicKeyRaw.subarray(1, 33);
  const y = publicKeyRaw.subarray(33, 65);

  const jwk = { kty: 'EC', crv: 'P-256', x: bufferToB64url(x), y: bufferToB64url(y), d: bufferToB64url(privateD), ext: true };
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });

  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: process.env.VAPID_SUBJECT || 'mailto:contato@siges.com.br' };
  const signingInput = bufferToB64url(Buffer.from(JSON.stringify(header))) + '.' + bufferToB64url(Buffer.from(JSON.stringify(payload)));
  const signature = crypto.sign(null, Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return signingInput + '.' + bufferToB64url(signature);
}

export async function sendEmptyPush(subscription) {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = buildVapidJwt(audience);
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: { TTL: '86400', Authorization: `vapid t=${jwt}, k=${process.env.VAPID_PUBLIC_KEY}`, 'Content-Length': '0' },
  });
}

/* ============================================================================
   Web Push via VAPID, usando só o módulo nativo `crypto` do Node
   (sem npm 'web-push'), conforme a arquitetura sem build da skill.

   UX-19 (auditoria 2026-08-23): antes daqui só saía push VAZIO. O service
   worker (sw.js) já tinha o código para exibir título e corpo, mas nunca
   recebia payload nenhum — então TODA notificação chegava como "Você tem uma
   nova notificação. Abra o app para ver os detalhes.". Agora o corpo é
   cifrado conforme a RFC 8291 (Message Encryption for Web Push, content
   encoding `aes128gcm`) e o texto real chega no aparelho.

   Referências: RFC 8291 (cifragem) e RFC 8292 (VAPID).
   ============================================================================ */

import crypto from 'crypto';

function b64urlToBuffer(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/\//g, '/').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  return Buffer.from(b64, 'base64');
}

function bufferToB64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// HKDF (RFC 5869) reduzido ao que a RFC 8291 usa: uma única iteração de
// expand, porque todo comprimento pedido aqui cabe em 32 bytes.
function hkdf(salt, ikm, info, length) {
  const prk = hmac(salt, ikm);
  const okm = hmac(prk, Buffer.concat([info, Buffer.from([0x01])]));
  return okm.subarray(0, length);
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

/**
 * Cifra o payload para uma inscrição, conforme RFC 8291.
 * `subscription.p256dh` é a chave pública do navegador; `subscription.auth`
 * é o segredo compartilhado de 16 bytes que ele gerou junto.
 */
function encryptPayload(subscription, plaintextBuf) {
  const uaPublic = b64urlToBuffer(subscription.p256dh);
  const authSecret = b64urlToBuffer(subscription.auth);

  // Par efêmero do servidor de aplicação, novo a cada envio.
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();           // 65 bytes, formato não comprimido
  const sharedSecret = ecdh.computeSecret(uaPublic);

  // IKM combina o segredo ECDH com o `auth` da inscrição e as duas chaves
  // públicas — é o que amarra a cifragem àquele navegador específico.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPublic,
    asPublic,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // 0x02 é o delimitador de fim de registro (não há padding extra aqui).
  const padded = Buffer.concat([plaintextBuf, Buffer.from([0x02])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // Cabeçalho aes128gcm: salt(16) | recordSize(4, big-endian) | idLen(1) | keyId
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic]);

  return Buffer.concat([header, ciphertext]);
}

/**
 * Envia uma notificação push com conteúdo.
 * `payload` vira o JSON que sw.js lê em event.data.json().
 */
export async function sendPush(subscription, payload) {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = buildVapidJwt(audience);

  const headers = {
    TTL: '86400',
    Authorization: `vapid t=${jwt}, k=${process.env.VAPID_PUBLIC_KEY}`,
    Urgency: 'normal',
  };

  // Sem p256dh/auth (inscrição antiga ou incompleta) não dá pra cifrar —
  // cai no push vazio, que o service worker ainda exibe com texto genérico.
  if (!payload || !subscription.p256dh || !subscription.auth) {
    return fetch(subscription.endpoint, { method: 'POST', headers: { ...headers, 'Content-Length': '0' } });
  }

  const body = encryptPayload(subscription, Buffer.from(JSON.stringify(payload), 'utf8'));
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
    },
    body,
  });
}

// Mantido para qualquer chamador que só queira "acordar" o aparelho.
export async function sendEmptyPush(subscription) {
  return sendPush(subscription, null);
}

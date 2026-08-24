/* ============================================================================
   Regra de senha do servidor (SEC-14, auditoria de 2026-08-23).

   Espelha passwordProblem() em js/utils.js. Os dois existem de propósito:
   o do navegador dá o retorno imediato enquanto a pessoa digita; ESTE é a
   trava de verdade — nenhum endpoint deve confiar na validação do cliente,
   que qualquer um contorna chamando a API direto.

   Se a regra mudar, mude nos DOIS lugares. Manter as mensagens idênticas
   evita que a pessoa veja um texto no formulário e outro na resposta.
   ============================================================================ */

export const PASSWORD_MIN_LENGTH = 8;

const COMMON_PASSWORDS = [
  '12345678', '123456789', '1234567890', 'senha123', 'password', 'password1',
  'qwerty123', 'abc12345', '11111111', '00000000', 'iloveyou', 'admin123',
  'siges123', 'brasil123', '123mudar', 'mudar123',
];

/** Devolve a mensagem do problema, ou null se a senha for aceitável. */
export function passwordProblem(pwd) {
  const p = String(pwd == null ? '' : pwd);
  if (p.length < PASSWORD_MIN_LENGTH) return `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  if (!/[a-zA-Z]/.test(p) || !/\d/.test(p)) return 'A senha precisa misturar letras e números.';
  if (COMMON_PASSWORDS.includes(p.toLowerCase())) return 'Essa senha é fácil demais de adivinhar. Escolha outra.';
  if (/^(.)\1+$/.test(p)) return 'Essa senha é fácil demais de adivinhar. Escolha outra.';
  return null;
}

/* ============================================================================
   Adaptador fino Vercel -> Netlify Functions.

   Os arquivos de negócio em api/*.js usam a assinatura clássica da Vercel,
   export default async function handler(req, res) { ... res.status(x).json(y) }.
   Este adaptador NUNCA reimplementa lógica — só traduz a "casca": recebe o
   evento no formato do Netlify Functions (event, context) e devolve o
   handler chamado como se estivesse rodando na Vercel, capturando o
   res.status()/res.json() num objeto de resposta que o Netlify entende
   ({ statusCode, headers, body }).

   Se um dia api/*.js usar algo de req/res além de .method, .headers, .body,
   .status(), .json() (ex: res.setHeader, streaming), este adaptador precisa
   crescer junto — hoje cobre 100% do que os 7 endpoints atuais usam.
   ============================================================================ */

export function adaptVercelHandler(vercelHandler, options = {}) {
  return async function handler(event) {
    let statusCode = 200;
    let responseBody = '';
    const responseHeaders = { 'Content-Type': 'application/json' };

    // JSON malformado no corpo derrubava o adaptador ANTES do handler rodar,
    // devolvendo um 500 com rastro de pilha em vez de um 400 limpo (achado
    // OPS-10 da auditoria de 2026-08-23).
    let parsedBody = {};
    if (event.body) {
      try {
        parsedBody = JSON.parse(event.body);
      } catch (e) {
        return {
          statusCode: 400,
          headers: responseHeaders,
          body: JSON.stringify({ error: 'Corpo da requisição não é um JSON válido.' }),
        };
      }
    }

    const headers = { ...(event.headers || {}) };
    // Funções agendadas do Netlify são invocadas internamente e NÃO carregam
    // o header Authorization que a Vercel Cron injeta a partir de CRON_SECRET.
    // `x-nf-event: schedule` só existe nessa invocação interna — uma chamada
    // HTTP vinda de fora não consegue produzi-la, então continua caindo na
    // checagem normal de segredo dentro do handler.
    if (options.injectCronSecret && headers['x-nf-event'] === 'schedule' && process.env.CRON_SECRET) {
      headers.authorization = `Bearer ${process.env.CRON_SECRET}`;
    }

    const req = { method: event.httpMethod, headers, body: parsedBody };
    const res = {
      status(code) { statusCode = code; return res; },
      json(payload) { responseBody = JSON.stringify(payload); return res; },
      setHeader(name, value) { responseHeaders[name] = value; return res; },
    };

    try {
      await vercelHandler(req, res);
    } catch (e) {
      return {
        statusCode: 500,
        headers: responseHeaders,
        body: JSON.stringify({ error: 'Erro interno ao processar a requisição.' }),
      };
    }
    return { statusCode, headers: responseHeaders, body: responseBody };
  };
}

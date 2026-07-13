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

export function adaptVercelHandler(vercelHandler) {
  return async function handler(event) {
    let statusCode = 200;
    let responseBody = '';
    const responseHeaders = { 'Content-Type': 'application/json' };

    const req = {
      method: event.httpMethod,
      headers: event.headers || {},
      body: event.body ? JSON.parse(event.body) : {},
    };
    const res = {
      status(code) { statusCode = code; return res; },
      json(payload) { responseBody = JSON.stringify(payload); return res; },
      setHeader(name, value) { responseHeaders[name] = value; return res; },
    };

    await vercelHandler(req, res);
    return { statusCode, headers: responseHeaders, body: responseBody };
  };
}

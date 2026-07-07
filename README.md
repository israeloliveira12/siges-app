# SIGES — Sistema de Gestão de Empréstimos

Sistema interno da **Siges Serviços Financeiros** para gerenciar clientes, contratos de empréstimo, cobranças, score de crédito e relatórios gerenciais. Construído como um site/app pessoal **sem build/framework** (HTML/CSS/JS puro), hospedado de graça em **GitHub + Vercel + Supabase**.

## Arquitetura

```
GitHub (código)  →  Vercel (hospedagem + serverless functions em /api)  →  navegador
                                                                              ↓
                                                          fala direto com o Supabase
                                                          (Postgres + Auth + Realtime)
```

- **Frontend**: HTML/CSS/JS vanilla, SPA com roteamento por hash (`js/router.js`), sem npm/bundler.
- **Banco**: Postgres relacional normalizado no Supabase (não o padrão "1 linha JSONB" — aqui o gerente precisa agregar dados de todos os clientes, então o schema é relacional de verdade). Toda regra de negócio sensível (parcelas, limite de crédito, score) roda como função SQL (`supabase/schema.sql`), nunca só em JS.
- **Auth**: Supabase Auth (e-mail/senha + Google). Cadastro de cliente é aberto; cadastro de gerente **não tem tela pública** — só um gerente existente cria outro, de dentro do painel (`/api/create-user`, que usa a `service_role` key).
- **Notificações**: e-mail (Resend) + Web Push (VAPID, sem serviço pago) + sino in-app (Supabase Realtime). Cron diário (`/api/cron-daily-check`, Vercel Cron 1x/dia) avisa parcelas que vencem amanhã, hoje, ou estão atrasadas (neste caso, todo dia).
- **PDF**: nota promissória e extrato do contrato, gerados no navegador via jsPDF (CDN).

## Passo a passo de publicação (você precisa fazer estas partes — eu te acompanho em cada uma)

### 1. GitHub
Crie um repositório vazio (pode ser privado) e suba este código:
```bash
git init
git add -A
git commit -m "primeiro commit"
git remote add origin https://github.com/SEU-USUARIO/siges-app.git
git push -u origin master
```

### 2. Supabase (banco de dados + autenticação)
1. Crie uma conta em [supabase.com](https://supabase.com) → **New Project**.
2. Vá em **SQL Editor → New query**, cole todo o conteúdo de `supabase/schema.sql` e rode.
3. Vá em **Settings → API** e copie: **Project URL** e **anon public key**.
4. Abra `js/auth.js` e substitua `SUPABASE_URL` e `SUPABASE_ANON_KEY` pelos valores copiados (esses dois valores não são secretos, podem ficar no código do navegador).

### 3. Criar o primeiro gerente (manual, só uma vez)
Como não existe cadastro público de gerente, crie a primeira conta manualmente:
1. No Supabase: **Authentication → Users → Add user** (e-mail + senha, marque "Auto Confirm User").
2. No **SQL Editor**, rode (troque o e-mail):
   ```sql
   update profiles set role = 'gerente' where email = 'seu-email@exemplo.com';
   ```
3. A partir daí, esse gerente pode criar outros gerentes pela tela "Gerentes" dentro do próprio sistema.

### 4. Vercel (publicação)
1. Crie uma conta em [vercel.com](https://vercel.com) → **Add New → Project → Import** o repositório do GitHub.
2. Framework preset: **Other** (projeto estático, sem build).
3. Em **Project Settings → Environment Variables**, adicione:
   | Nome | Valor |
   |---|---|
   | `SUPABASE_URL` | mesma Project URL do passo 2 |
   | `SUPABASE_SERVICE_ROLE_KEY` | em Settings → API → `service_role` (secreta! nunca vai no frontend) |
   | `RESEND_API_KEY` | ver passo 5 |
   | `RESEND_FROM_EMAIL` | ex: `SIGES <notificacoes@seudominio.com>` (ou deixe o padrão de teste do Resend) |
   | `CRON_SECRET` | invente uma string aleatória longa (ex: gere com `openssl rand -hex 32`) |
   | `VAPID_PUBLIC_KEY` | `BEF9PcjT8CrFRd_tv2sbRkIdYMPhELbXj-gekH98iavjdpZjcqmkq6cl8FwfEOd1XnYELumw2JJEOo8ot2FaKhQ` |
   | `VAPID_PRIVATE_KEY` | `iwSmIMeYcrH-dVEIUCOqxpzn7WrXoYzjJsUeIzHsP8E` |
   | `VAPID_SUBJECT` | `mailto:seu-email@exemplo.com` |

   As duas chaves VAPID acima já foram geradas para este projeto (podem ser usadas como estão). Se preferir gerar seu próprio par, rode `scripts` com a biblioteca `cryptography` do Python (peça pra eu gerar de novo se quiser trocar).
4. Deploy. A partir daqui, todo `git push` publica uma nova versão automaticamente.

### 5. Resend (e-mail transacional, grátis)
1. Crie conta em [resend.com](https://resend.com).
2. Modo mais simples: use o remetente de teste `onboarding@resend.dev` (funciona sem verificar domínio, mas só envia para o e-mail da sua própria conta Resend — bom pra testar).
3. Para enviar para qualquer cliente de verdade, verifique um domínio seu em **Domains** e use um remetente desse domínio em `RESEND_FROM_EMAIL`.
4. Copie a **API Key** e cole em `RESEND_API_KEY` no Vercel.

### 6. Google OAuth (login com Google)
1. No [Google Cloud Console](https://console.cloud.google.com/): crie um projeto → **APIs & Services → Credentials → Create OAuth Client ID** (tipo "Web application").
2. Em **Authorized redirect URIs**, adicione: `https://SEU-PROJETO.supabase.co/auth/v1/callback`.
3. Copie o **Client ID** e **Client Secret**.
4. No Supabase: **Authentication → Providers → Google**, cole os dois valores e ative.
5. Em **Authentication → URL Configuration**, defina a **Site URL** para a URL de produção do Vercel (não `localhost`) — isso vale tanto para o login Google quanto para recuperação de senha.

### 7. Vercel Cron (avisos diários de vencimento)
Já configurado em `vercel.json` para rodar todo dia às 10h UTC (7h no horário de Brasília). Se quiser mudar o horário, edite o campo `schedule` (formato cron).

## Estrutura de pastas

Veja `supabase/schema.sql` (banco), `js/` (frontend, um arquivo por tela) e `api/` (serverless functions que usam chaves secretas). `js/main.js` é sempre o último `<script>` carregado — ele monta o layout e dispara a checagem de autenticação.

## Testando localmente

Sem build, então qualquer servidor estático serve. Exemplo:
```bash
python -m http.server 5500
```
Abra `http://localhost:5500`. O login com Google e a recuperação de senha só funcionam apontando pro domínio de produção (passo 6.5) — localmente, teste com e-mail/senha.

## Limitações conhecidas (v1)

- **WhatsApp não está incluído nesta versão** — o schema já tem um canal `whatsapp` pronto em `notifications_log`; para ativar, crie `api/send-whatsapp.js` chamando a Meta WhatsApp Cloud API (exige verificação de empresa no Meta Business Manager) e adicione uma chamada a ela em `api/notify-event.js` e `api/cron-daily-check.js`.
- Sem testes automatizados (não há CI) — valide manualmente cada mudança no navegador, incluindo em viewport de celular.
- Free tier do Supabase (500MB banco), Vercel Hobby e Resend (grátis) folgam muito para ~100 usuários e ~3 registros/dia — não é motivo de preocupação no volume atual, mas vale saber que existe um teto caso o negócio cresça bastante.

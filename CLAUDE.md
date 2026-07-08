# SIGES — Documento de continuidade para o Claude

> Leia isto primeiro se a conversa começar com algo como "continue o projeto siges". Este arquivo é para o Claude, não para o usuário — para instruções de deploy/setup, veja [README.md](README.md). Mantenha este arquivo atualizado ao final de cada rodada de mudanças relevante.

## O que é o projeto

SIGES (Siges Serviços Financeiros) é um SaaS de gestão de empréstimos, construído inteiramente por conversa com o Claude Code. Dois papéis: **cliente** (autocadastro, acesso restrito ao próprio contrato) e **gerente/administrador** (acesso total, só é criado internamente por outro gerente — nunca há tela pública de cadastro de gerente). Na UI o papel `gerente` é chamado de "Administrador" — a nomenclatura interna do código (roles, `is_gerente()`, nomes de tabela) continua "gerente" de propósito; não vale a pena renomear (risco alto, zero ganho pro usuário).

Stack: HTML/CSS/JS vanilla sem build/bundler, Supabase (Postgres + Auth + Realtime), Vercel (hospedagem estática + serverless `/api`), GitHub (código-fonte). Detalhes de arquitetura e passo a passo de deploy: [README.md](README.md).

## Como o usuário trabalha comigo

- O usuário manda listas numeradas de melhorias ("Melhorias a fazer no sistema") em rodadas grandes. Implemento tudo que for possível diretamente; itens que pedem uma decisão de negócio (ex: mudar uma fórmula de cálculo) devem ser **analisados e propostos primeiro**, nunca implementados sem aprovação explícita — ele é claro quando quer isso ("estude bem, analise bem... me traga sugestões").
- **Nunca faço `git push` sem confirmação explícita** ("pode enviar", "sim, pode mandar" etc.) — mesmo depois de implementar e testar tudo.
- Quando uma mudança exige rodar uma migration no Supabase, **o usuário roda manualmente** no SQL Editor (não tenho acesso direto ao banco de produção). Só confio que uma função/coluna nova existe em produção depois que ele confirma que rodou a migration.
- Regra especial já usada: se o usuário pedir para eu não interromper o fluxo para pedir aprovações intermediárias, devo implementar tudo primeiro e deixar **uma lista consolidada única** de ações pendentes dele (migrations a rodar, confirmação de push) para o final.
- Sempre testo mudanças de UI no preview antes de reportar como concluído (ver seção de gotchas abaixo sobre cache).

## Estado das migrations (verifique isto sempre)

`supabase/schema.sql` é a fonte da verdade "fresh install" (sempre mantida em sincronia com a última migration). As migrations em `supabase/migration_00N.sql` são incrementais e devem ser rodadas em ordem crescente, uma vez cada, no SQL Editor do Supabase em produção.

Rode `git status` em `supabase/` para ver quais migrations ainda não foram commitadas (== ainda não confirmadas como rodadas pelo usuário). Migrations não commitadas normalmente significam "ainda não rodei isso em produção" — **nunca assuma que uma coluna/função de uma migration recente já existe em produção sem confirmar com o usuário.**

## Decisões de arquitetura não óbvias (o "porquê")

- **FKs de `notifications_log`, `renewal_cycles`↔`installments`, `payments`, `loan_requests.resulting_contract_id` são todas `ON DELETE SET NULL` ou `CASCADE`** — corrigido depois de um bug recorrente de violação de FK ao excluir contrato/parcela. Havia uma referência circular entre `installments.renewed_into_cycle_id` e `renewal_cycles.origin_installment_id` que tornava impossível qualquer ordem de DELETE funcionar sem esse fix no schema. Se um bug de FK "voltar", o problema quase certamente é uma FK nova que falta esse tratamento — não é reordenar DELETEs em `delete_contract()`.
- **`late_fee_percent`/`late_interest_percent`** (contrato) são aplicados **no momento do recebimento** (quitação OU renovação de parcela/ciclo atrasado), não acumulados automaticamente por um cron. Cálculo: juros de atraso = `saldo_da_parcela × (late_interest_percent/100/30) × dias_atraso` (linear, proporcional ao dia, tratando o percentual salvo como taxa **mensal**); multa = `saldo × late_fee_percent/100` (fixa, não escala com dias). Ambos os valores aparecem como sugestão editável no modal de recebimento (`gerente-contrato-receber.js`) — o gerente pode ajustar/zerar, tanto na aba "Quitar" quanto na "Renovar". O valor cobrado além do saldo contratual da parcela vira `payments.late_charge_amount`, somado a `interest_component` (assim relatórios/lucro líquido já enxergam automaticamente, sem precisar tocar em cada consumidor).
- **`refresh_overdue_status()`** (cron diário) recalcula o score de todo cliente com contrato `atrasado`/`perda` a cada execução — sem isso, o score de um cliente inadimplente que não interage mais com o sistema ficaria parado no valor antigo.
- **`payments.net_profit`** é uma coluna gerada (`interest_component - operational_fee_amount`) — é a base de "lucro líquido" em todo o sistema (relatórios, resumo do contrato). Encargo de atraso já está embutido em `interest_component`, então flui automaticamente.
- **Taxa de saída** (`loan_contracts.operational_fee_amount`) é cobrada **uma vez**, na criação do contrato, e soma ao "Total desembolsado" (`total_disbursed_amount`, coluna gerada = `principal_amount + operational_fee_amount`). **Taxa de entrada** (`payments.operational_fee_amount`) é cobrada a cada recebimento. Lucro líquido do contrato = juros recebidos (parcelas + renovações) − taxa de saída (uma vez) − soma das taxas de entrada — já implementado no card "Resumo do contrato" em `gerente-contratos-lista.js` (tela de detalhe).
- **Renovação (`renew_installment`) só é permitida em contratos de parcela única** (`installments_count === 1`) — renovar uma única parcela de um contrato multi-parcela deixaria a relação entre as outras parcelas e o ciclo renovado ambígua.
- **CPF no login**: `doSignIn` detecta se o texto digitado parece CPF (11 dígitos, sem `@`) e resolve para e-mail via RPC `email_for_cpf` antes de chamar `signInWithPassword`.
- **`clients.salary` é `text`, não `numeric`** (mudou na migration_008) — guarda uma das 4 faixas fixas de `INCOME_BRACKETS` (`js/utils.js`), rotulado "Renda Mensal" na UI. Não é usado em nenhum cálculo automático, é só informativo. Clientes cadastrados antes da migration_008 têm o valor numérico antigo salvo como texto (ex: `"3245.00"`) — não bate com nenhuma das 4 opções, então o `<select>` mostra em branco até o admin escolher uma faixa manualmente. Para adicionar/mudar faixas, edite só `INCOME_BRACKETS` em `js/utils.js` — os dois formulários (`login.js` cadastro e `gerente-clientes.js` edição) consomem a mesma constante via `incomeBracketOptionsHtml()`.
- **Inputs `type="number"`/`type="date"`**: `style.css` já remove o spinner nativo e estiliza o ícone do calendário para não destoar do resto do design flat/minimalista — não reintroduza esses controles nativos sem essa camada de CSS.

## Gotchas de teste/verificação

- **Service Worker cacheia agressivamente.** Se algo que você editou parece "não ter efeito" no preview, ou o browser mostra uma versão antiga do JS mesmo após reload, rode isto no console/`preview_eval` antes de qualquer outra investigação:
  ```js
  (async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
    location.reload();
  })();
  ```
  Isso já causou pelo menos um "bug" reportado pelo usuário que na verdade era cache — sempre descarte essa hipótese antes de mexer em código que já parece correto na leitura.
- **Sempre suba `CACHE_NAME` em `sw.js`** ao final de uma rodada com mudanças relevantes de JS/CSS (está em `v5` agora) — isso força o Service Worker do usuário em produção a invalidar o cache antigo no próximo load.
- Para testar telas de gerente no preview sem depender de dados reais do Supabase (RLS bloqueia sessão fake), mocke `supa.from` com um proxy "chainable" que resolve para dados fake, teste, e restaure `supa.from` original antes de terminar.

## Limitações conhecidas (v1, ver README para detalhes)

- **E-mail para clientes está desativado de fato (decisão consciente, 2026-07-07).** O usuário não tem domínio próprio registrado (só tentou cadastrar `siges.com.br` no Resend sem possuir o domínio de verdade — verificação trava em "Not Started" porque não há onde adicionar os registros DNS). Decisão: não registrar domínio por enquanto; os canais reais de notificação do cliente são o **sino in-app** (Supabase Realtime) e o **Web Push** (ambos gratuitos, já funcionando). `RESEND_FROM_EMAIL` continua sem valor em produção, então todo envio cai no remetente sandbox `onboarding@resend.dev`, que só entrega para o e-mail da própria conta Resend — **isso é esperado, não é bug**. Email e push são canais independentes em `dispatchToRecipient` (`api/notify-event.js`), então a falha de e-mail não afeta a entrega do push. Se o usuário decidir registrar um domínio no futuro, o caminho é: Resend → Domains → verificar DNS → configurar `RESEND_FROM_EMAIL` no Vercel — nenhuma mudança de código é necessária.
- WhatsApp é só via link `wa.me` (zero custo, sem API paga) — não há envio automático de WhatsApp pelo servidor.
- Sem paginação em nenhuma listagem (`gerente-clientes.js`, `gerente-contratos-lista.js` etc.) — inofensivo no volume atual, mas é o primeiro ponto a atacar se o negócio crescer muito.
- Sem testes automatizados — valide sempre manualmente no preview, incluindo viewport mobile.

## Onde procurar o quê

- `supabase/schema.sql` — schema completo "fresh install", toda regra de negócio sensível vive aqui como função SQL (`security definer`), nunca só em JS.
- `js/screens/*.js` — uma tela por arquivo, registradas via `registerRoute(...)` no fim de cada arquivo. `js/main.js` é sempre o último `<script>` carregado.
- `js/charts.js` — gráficos SVG inline reutilizáveis (`barChartSVG`, `lineChartSVG`, `donutChartSVG` + `donutLegendHtml`).
- `api/*.js` — únicas rotas que usam a `service_role` key ou outras chaves secretas (Resend, VAPID, CRON_SECRET).

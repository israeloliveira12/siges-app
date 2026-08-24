-- ============================================================================
-- SIGES — Sistema de Gestão de Empréstimos
-- Schema completo do banco (rodar uma única vez no SQL Editor do Supabase)
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- 1. TIPOS
-- ============================================================================

create type user_role as enum ('gerente', 'cliente');
create type request_status as enum ('pendente', 'aprovada', 'reprovada');
create type contract_status as enum ('em_aberto', 'atrasado', 'quitado', 'perda');
create type installment_status as enum ('pendente', 'paga', 'atrasada', 'renovada', 'cancelada', 'perda');
create type due_type as enum ('mensal', 'quinzenal', 'semanal', 'personalizado');
create type notification_channel as enum ('email', 'push', 'whatsapp', 'in_app');
create type notification_event as enum (
  'vence_amanha', 'vence_hoje', 'atrasada',
  'solicitacao_criada', 'solicitacao_aprovada', 'solicitacao_reprovada',
  'contrato_criado', 'pagamento_recebido', 'renovacao_registrada',
  -- Aviso in-app do Administrador Master pras empresas assinantes (tela
  -- "Comunicados" da Plataforma SaaS) — não é evento de negócio de nenhum
  -- tenant específico, é comunicação da plataforma em si.
  'aviso_plataforma'
);
create type payment_kind as enum ('quitacao_parcela', 'renovacao_juros', 'quitacao_final');
create type request_source as enum ('installment', 'renewal_cycle');
create type client_approval_status as enum ('pendente', 'aprovado', 'rejeitado');

-- ============================================================================
-- 2. TABELAS
-- ============================================================================

-- 2.1 profiles — extensão de auth.users, guarda o papel (role)
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role user_role not null default 'cliente',
  full_name text not null default '',
  cpf text unique,
  phone text,
  email text not null,
  avatar_url text,
  created_by uuid references profiles(id) on delete set null,
  active boolean not null default true,
  is_primary_admin boolean not null default false, -- só o 1º gerente criado; pode apagar todos os dados
  -- Dono da plataforma inteira (SaaS multi-empresa) — global, não por
  -- tenant, diferente de is_primary_admin. Só existe 1 pessoa com isso.
  -- Backfillada com TRUE pro Tenant #1 logo abaixo, na seção 2.13.
  platform_owner boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2.2 clients — dados específicos de quem é cliente (1:1 com profiles)
create table clients (
  profile_id uuid primary key references profiles(id) on delete cascade,
  credit_limit numeric(12,2) not null default 0 check (credit_limit >= 0),
  address text,
  birth_date date,
  client_group text,
  company text,
  job_title text,
  salary text,
  pix_key text,
  approval_status client_approval_status not null default 'pendente',
  decided_by uuid references profiles(id) on delete set null,
  decided_at timestamptz,
  decision_reason text,
  score integer not null default 50 check (score between 0 and 100),
  score_tier text not null default 'Atenção',
  score_updated_at timestamptz,
  notes text,
  -- Feature "Indicações": quem indicou este cliente (preenchido pelo gerente
  -- no cadastro via busca por nome — ver search_clients_for_referral).
  -- Nullable/on delete set null: não afeta nenhum cliente existente e não
  -- bloqueia exclusão do indicador.
  referred_by_client_id uuid references clients(profile_id) on delete set null,
  created_at timestamptz not null default now(),
  constraint clients_no_self_referral check (referred_by_client_id is distinct from profile_id)
);

-- 2.3 loan_requests — solicitação do cliente (pré-contrato)
create table loan_requests (
  id uuid primary key default gen_random_uuid(),
  -- CASCADE: se o cliente for excluído, a própria solicitação (que nunca virou
  -- contrato, senão a exclusão do cliente já seria bloqueada por loan_contracts)
  -- não tem motivo pra sobreviver e não deve impedir a exclusão.
  client_id uuid not null references clients(profile_id) on delete cascade,
  requested_amount numeric(12,2) not null check (requested_amount > 0),
  requested_installments integer, -- obsoleto: cliente não escolhe mais parcelas, só prazo
  requested_due_type due_type,
  requested_custom_interval_days integer, -- só usado quando requested_due_type = 'personalizado'
  message text,
  status request_status not null default 'pendente',
  decided_by uuid references profiles(id) on delete set null,
  decision_reason text,
  decided_at timestamptz,
  resulting_contract_id uuid,
  created_at timestamptz not null default now()
);

-- 2.4 loan_contracts — contrato "pai"
create table loan_contracts (
  id uuid primary key default gen_random_uuid(),
  contract_number integer unique, -- 5 dígitos aleatórios, atribuído pelo trigger set_contract_number()
  client_id uuid not null references clients(profile_id),
  created_by uuid not null references profiles(id),
  origin_request_id uuid references loan_requests(id),

  principal_amount numeric(12,2) not null check (principal_amount > 0),
  interest_rate numeric(6,3) not null check (interest_rate >= 0),
  installments_count integer not null check (installments_count > 0),
  due_type due_type not null,
  custom_interval_days integer, -- só usado quando due_type = 'personalizado'

  has_operational_fee boolean not null default false,
  operational_fee_amount numeric(12,2) not null default 0 check (operational_fee_amount >= 0),
  -- taxa operacional de SAÍDA é desembolsada A MAIS (não descontada do cliente):
  -- empresta-se principal_amount ao cliente, e o caixa do gerente sai com o total abaixo.
  total_disbursed_amount numeric(12,2) generated always as (principal_amount + operational_fee_amount) stored,

  contract_date date not null,
  first_installment_date date not null,

  allows_renewal boolean not null default true,
  late_fee_percent numeric(6,3) not null default 0 check (late_fee_percent >= 0),
  late_interest_percent numeric(6,3) not null default 0 check (late_interest_percent >= 0),

  status contract_status not null default 'em_aberto',
  observations text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table loan_requests
  add constraint fk_resulting_contract
  foreign key (resulting_contract_id) references loan_contracts(id) on delete set null;

-- 2.5 installments — parcelas de cada contrato
create table installments (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references loan_contracts(id) on delete cascade,
  sequence_number integer not null,
  due_date date not null,
  principal_share numeric(12,2) not null,
  interest_share numeric(12,2) not null,
  amount_due numeric(12,2) generated always as (principal_share + interest_share) stored,
  principal_paid_partial numeric(12,2) not null default 0, -- pagamento parcial já recebido (capital)
  interest_paid_partial numeric(12,2) not null default 0,  -- pagamento parcial já recebido (juros)
  status installment_status not null default 'pendente',
  paid_at timestamptz,
  renewed_into_cycle_id uuid,
  -- capital ainda não recuperado no momento em que a parcela foi reconhecida
  -- como perda (automática pelo cron, ou manual pelo botão) — não é o
  -- principal_share cheio, e sim o que sobrava depois de qualquer pagamento
  -- parcial já recebido. loss_recognized_at define o MÊS em que a perda é
  -- abatida do lucro (nunca created_at/due_date, que não representam quando
  -- a perda foi de fato reconhecida).
  principal_lost numeric(12,2) not null default 0,
  loss_recognized_at timestamptz,
  created_at timestamptz not null default now(),
  unique (contract_id, sequence_number)
);

-- 2.6 renewal_cycles — ciclos de "renovação" (só juros pagos, dívida cheia renova)
create table renewal_cycles (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references loan_contracts(id) on delete cascade,
  cycle_number integer not null,
  -- referência cruzada com installments (ver fk_renewed_into_cycle abaixo) —
  -- ambas usam "on delete set null" pra evitar bloqueio mútuo ao excluir.
  origin_installment_id uuid references installments(id) on delete set null,
  previous_cycle_id uuid references renewal_cycles(id),
  interest_only_amount numeric(12,2) not null check (interest_only_amount >= 0),
  full_debt_amount numeric(12,2) not null check (full_debt_amount > 0),
  new_due_date date not null,
  status installment_status not null default 'pendente',
  paid_at timestamptz,
  -- ciclo nunca reduz capital ("juros repete") — o capital perdido, se
  -- reconhecido como perda, é sempre loan_contracts.principal_amount inteiro.
  principal_lost numeric(12,2) not null default 0,
  loss_recognized_at timestamptz,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  unique (contract_id, cycle_number)
);

alter table installments
  add constraint fk_renewed_into_cycle
  foreign key (renewed_into_cycle_id) references renewal_cycles(id) on delete set null;

-- 2.7 payments — todo recebimento de dinheiro (parcela normal ou renovação).
-- Cascata: excluir o contrato/parcela/ciclo pai remove os pagamentos ligados.
create table payments (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references loan_contracts(id) on delete cascade,
  installment_id uuid references installments(id) on delete cascade,
  renewal_cycle_id uuid references renewal_cycles(id) on delete cascade,
  payment_kind payment_kind not null,

  amount_received numeric(12,2) not null check (amount_received > 0),
  principal_component numeric(12,2) not null default 0,
  interest_component numeric(12,2) not null default 0,
  late_charge_amount numeric(12,2) not null default 0,

  has_operational_fee boolean not null default false,
  operational_fee_amount numeric(12,2) not null default 0,
  net_profit numeric(12,2) generated always as (interest_component - operational_fee_amount) stored,

  received_by uuid not null references profiles(id),
  received_at timestamptz not null default now(),
  notes text,

  constraint payments_target_check check (installment_id is not null or renewal_cycle_id is not null)
);

-- 2.8 notifications_log — histórico de disparos (canal extensível p/ whatsapp futuro)
create table notifications_log (
  id uuid primary key default gen_random_uuid(),
  -- CASCADE (diferente de related_contract_id/related_installment_id abaixo):
  -- esses registros pertencem à PESSOA (destinatário), não são um log de
  -- auditoria de negócio (isso é audit_log, que usa actor_id set null) — se o
  -- destinatário for excluído, não faz sentido manter as notificações dele, e
  -- sobretudo não deve BLOQUEAR a exclusão do cliente/gerente.
  recipient_id uuid not null references profiles(id) on delete cascade,
  event notification_event not null,
  channel notification_channel not null,
  -- SET NULL (não CASCADE): notifications_log é um histórico de auditoria —
  -- excluir o contrato/parcela referenciado não deve apagar a notificação,
  -- só desfazer o link (e, mais importante, não deve BLOQUEAR a exclusão).
  related_contract_id uuid references loan_contracts(id) on delete set null,
  related_installment_id uuid references installments(id) on delete set null,
  title text not null,
  body text not null,
  read_at timestamptz,
  sent_at timestamptz not null default now(),
  delivery_status text not null default 'sent' check (delivery_status in ('sent','failed','skipped')),
  provider_response jsonb
);

-- 2.9 push_subscriptions — Web Push (VAPID)
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- 2.10 system_settings — configurações globais (singleton)
create table system_settings (
  id boolean primary key default true check (id),
  critical_days_threshold integer not null default 15,
  loss_days_threshold integer not null default 60,
  default_exit_fee_percent numeric(6,3) not null default 0,   -- % sobre o valor emprestado (saída/desembolso)
  default_exit_fee_fixed numeric(12,2) not null default 0,    -- valor fixo somado à % de saída (ex: R$0,99)
  default_entry_fee_percent numeric(6,3) not null default 0,  -- % sobre o valor recebido (entrada/recebimento)
  default_entry_fee_fixed numeric(12,2) not null default 0,   -- valor fixo somado à % de entrada
  company_name text not null default 'Siges Serviços Financeiros',
  company_whatsapp text,
  company_pix_key text,
  company_city text, -- "praça" usada no texto das notas promissórias (ex: "Manaus")
  backup_auto_enabled boolean not null default false,
  backup_frequency text not null default 'diario', -- diario | semanal | quinzenal | mensal | personalizado
  backup_custom_days integer,
  planning_current_cash numeric(12,2) not null default 0,   -- Planejamento: caixa atual (manual)
  planning_ltv_percent numeric(6,3) not null default 0,     -- Planejamento: % de LTV aplicado sobre o lucro bruto
  updated_at timestamptz not null default now()
);
insert into system_settings (id) values (true);

-- 2.11 planning_debts — dívidas mensais nomeadas da tela Planejamento
create table planning_debts (
  id uuid primary key default gen_random_uuid(),
  month date not null,              -- sempre o dia 1 do mês (ex: 2026-08-01)
  name text not null,
  amount numeric(12,2) not null check (amount > 0),
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now()
);

-- 2.12 audit_log — trilha de auditoria (tela "Auditoria" do admin). Escrita
-- só via log_audit_event() (security definer, ver seção 5) — nunca insert
-- direto da tabela, pra permitir registrar até eventos sem sessão (ex: login
-- falho, onde ainda não existe auth.uid()). actor_name/actor_role são uma
-- FOTO do momento do evento (não um join), pra sobreviver mesmo se o
-- profile referenciado for excluído depois.
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references profiles(id) on delete set null,
  actor_name text,
  actor_role text,
  action text not null,
  description text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_created_at_idx on audit_log(created_at desc);
create index audit_log_actor_id_idx on audit_log(actor_id);

-- 2.13 tenants — cada linha é uma empresa cliente da plataforma SIGES.
-- Ver migration_030.sql para o histórico completo do porquê (Fase 0 da
-- transformação em SaaS multi-empresa). Nesta instalação fresca, o bloco
-- abaixo cria a tabela, a função-andaime default_tenant_id() (preenche
-- tenant_id automaticamente enquanto o app não seta o valor real por
-- usuário — ver aviso na migration), o Tenant #1 (a partir de
-- system_settings.company_name, que já foi inserido acima) e a coluna
-- tenant_id em toda tabela de negócio.
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_profile_id uuid references profiles(id) on delete set null,
  active boolean not null default true,
  -- Recurso "Indicações" (cliente indica outro cliente) é exclusivo do
  -- Tenant #1 (o fundador da plataforma) — nenhuma empresa cliente do SaaS
  -- tem essa opção, em nenhum plano. Default FALSE pra qualquer tenant
  -- novo; só o Tenant #1, criado logo abaixo, recebe TRUE. Diferente do
  -- futuro sistema de limites/recursos por PLANO (Fase 5, que diferencia
  -- clientes pagantes entre si) — este flag é incondicional a qualquer
  -- plano, "isso nunca existe fora do tenant do fundador".
  referrals_enabled boolean not null default false,
  -- Link de convite (Fase 4) — token opaco e rotacionável, nunca o `id` real
  -- do tenant, pra poder ser regenerado sem quebrar a identidade interna da
  -- empresa. Usado em `?convite=<token>` no cadastro público, resolvido
  -- por resolve_invite_token() e consumido por handle_new_user().
  invite_token text not null unique default replace(gen_random_uuid()::text, '-', ''),
  -- Marcado sempre que update_tenant() suspende a empresa (nunca limpo ao
  -- reativar — fica registrando "última vez suspensa", usado pro painel
  -- executivo calcular tempo médio de vida até suspensão).
  suspended_at timestamptz,
  -- Fim do período de teste grátis (trial), setado automaticamente por
  -- assign_tenant_plan() quando o plano atribuído tem trial_days, e
  -- ajustável manualmente por update_tenant() (estender/encurtar um caso
  -- pontual, ou "converter pra pago" mandando null). Enquanto no futuro,
  -- não conta como receita no MRR/ARR do painel executivo (migration_043).
  trial_ends_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function default_tenant_id()
returns uuid
language sql
stable
security definer set search_path = public
as $$
  select id from tenants order by created_at asc limit 1;
$$;

insert into tenants (name, owner_profile_id, referrals_enabled)
select
  coalesce(nullif(trim(s.company_name), ''), 'Minha Empresa'),
  (select id from profiles where role = 'gerente' and is_primary_admin and active order by created_at asc limit 1),
  true
from system_settings s
limit 1;

-- 2.13b plans (Fase 5) — planos configuráveis manualmente pelo Administrador
-- Master (Basic/Essential/Premium são só um ponto de partida, não nomes
-- fixos no código — ele edita/renomeia/cria à vontade pela tela "Planos").
-- `limits` é jsonb de propósito: adicionar um novo limite/recurso no futuro
-- é só uma nova chave reconhecida pelo frontend, sem migration de schema.
-- Chaves usadas hoje: max_gerentes/max_clientes (inteiro, null = ilimitado),
-- allow_extrato_pdf/allow_promissoria_pdf/allow_backup_export (boolean).
create table plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  price_monthly numeric(10,2),
  active boolean not null default true,
  sort_order integer not null default 0,
  limits jsonb not null default '{}'::jsonb,
  -- Trial (migration_043): quantos dias de teste grátis uma empresa ganha
  -- ao ser atribuída a este plano (null = sem trial, cobrança/atribuição
  -- normal desde o dia 1). Não é um plano à parte — qualquer plano existente
  -- pode virar "o Trial do Premium" só preenchendo este campo.
  trial_days integer check (trial_days is null or trial_days > 0),
  created_at timestamptz not null default now()
);

-- tenants.plan_id — NULL de propósito pra toda empresa hoje (inclusive a
-- sua): "sem plano" = sem limite nenhum, exatamente o comportamento atual,
-- até o Administrador Master atribuir um plano manualmente pela tela
-- "Empresas". Nenhum tenant existente muda de comportamento com esta
-- migration.
alter table tenants add column plan_id uuid references plans(id) on delete set null;

alter table profiles add column tenant_id uuid references tenants(id) default default_tenant_id();
update profiles set tenant_id = default_tenant_id() where tenant_id is null;
alter table profiles alter column tenant_id set not null;
create index profiles_tenant_id_idx on profiles(tenant_id);

alter table clients add column tenant_id uuid references tenants(id) default default_tenant_id();
update clients set tenant_id = default_tenant_id() where tenant_id is null;
alter table clients alter column tenant_id set not null;
create index clients_tenant_id_idx on clients(tenant_id);

alter table loan_requests add column tenant_id uuid references tenants(id) default default_tenant_id();
update loan_requests set tenant_id = default_tenant_id() where tenant_id is null;
alter table loan_requests alter column tenant_id set not null;
create index loan_requests_tenant_id_idx on loan_requests(tenant_id);

alter table loan_contracts add column tenant_id uuid references tenants(id) default default_tenant_id();
update loan_contracts set tenant_id = default_tenant_id() where tenant_id is null;
alter table loan_contracts alter column tenant_id set not null;
create index loan_contracts_tenant_id_idx on loan_contracts(tenant_id);

alter table installments add column tenant_id uuid references tenants(id) default default_tenant_id();
update installments set tenant_id = default_tenant_id() where tenant_id is null;
alter table installments alter column tenant_id set not null;
create index installments_tenant_id_idx on installments(tenant_id);

alter table renewal_cycles add column tenant_id uuid references tenants(id) default default_tenant_id();
update renewal_cycles set tenant_id = default_tenant_id() where tenant_id is null;
alter table renewal_cycles alter column tenant_id set not null;
create index renewal_cycles_tenant_id_idx on renewal_cycles(tenant_id);

alter table payments add column tenant_id uuid references tenants(id) default default_tenant_id();
update payments set tenant_id = default_tenant_id() where tenant_id is null;
alter table payments alter column tenant_id set not null;
create index payments_tenant_id_idx on payments(tenant_id);

alter table notifications_log add column tenant_id uuid references tenants(id) default default_tenant_id();
update notifications_log set tenant_id = default_tenant_id() where tenant_id is null;
alter table notifications_log alter column tenant_id set not null;
create index notifications_log_tenant_id_idx on notifications_log(tenant_id);

alter table push_subscriptions add column tenant_id uuid references tenants(id) default default_tenant_id();
update push_subscriptions set tenant_id = default_tenant_id() where tenant_id is null;
alter table push_subscriptions alter column tenant_id set not null;
create index push_subscriptions_tenant_id_idx on push_subscriptions(tenant_id);

alter table system_settings add column tenant_id uuid references tenants(id) default default_tenant_id();
update system_settings set tenant_id = default_tenant_id() where tenant_id is null;
alter table system_settings alter column tenant_id set not null;
create index system_settings_tenant_id_idx on system_settings(tenant_id);

-- Bug real corrigido (2026-08-10, achado testando o fluxo completo de uma
-- 2ª empresa em produção): a PK original de system_settings era só `id`
-- (boolean, sempre true) — sobrevivia do tempo de "singleton global", antes
-- do pivô SaaS. Isso nunca foi corrigido quando tenant_id foi adicionada
-- acima, então o banco só permitia UMA linha em toda a tabela (violação de
-- unicidade em `id`) — nenhuma empresa criada depois da Fase 0 conseguia
-- ter a própria linha de configurações. A tela Configurações de QUALQUER
-- empresa assinante nova ficava permanentemente quebrada ("Não foi possível
-- carregar as configurações agora"), e RPCs que leem system_settings pelo
-- tenant (public_company_info, get_my_tenant_invite_info, etc.) não
-- achavam nada pra essas empresas. `tenant_id` passa a ser a PK de verdade
-- — `id` continua existindo (sempre true), só não é mais única/PK.
alter table system_settings drop constraint system_settings_pkey;
alter table system_settings add primary key (tenant_id);

-- Cria automaticamente a linha de configurações de qualquer tenant novo,
-- não importa o caminho de criação (hoje só api/create-tenant.js, mas
-- protege qualquer fluxo futuro também) — já usa o nome escolhido pro
-- tenant como company_name inicial, editável depois em Configurações.
create or replace function trg_create_default_settings_for_tenant()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into system_settings (tenant_id, company_name)
  values (new.id, new.name)
  on conflict (tenant_id) do nothing;
  return new;
end;
$$;

create trigger after_tenant_created
  after insert on tenants
  for each row execute function trg_create_default_settings_for_tenant();

alter table planning_debts add column tenant_id uuid references tenants(id) default default_tenant_id();
update planning_debts set tenant_id = default_tenant_id() where tenant_id is null;
alter table planning_debts alter column tenant_id set not null;
create index planning_debts_tenant_id_idx on planning_debts(tenant_id);

-- audit_log fica NULLABLE de propósito — ver comentário em migration_030.sql.
alter table audit_log add column tenant_id uuid references tenants(id);
update audit_log set tenant_id = default_tenant_id() where tenant_id is null;
create index audit_log_tenant_id_idx on audit_log(tenant_id);

-- Fase 2 (seletor de modo) — marca o dono da própria empresa (Tenant #1)
-- como dono da plataforma inteira. Ver migration_035.sql.
update profiles set platform_owner = true
  where id = (select owner_profile_id from tenants order by created_at asc limit 1);

-- 2.13c tenant_payments (migration_043) — registro manual de pagamento por
-- empresa assinante (não existe gateway de pagamento na plataforma; é só
-- uma agenda de "empresa X pagou o mês Y", exclusiva do Administrador
-- Master, tela "Assinaturas/Cobranças").
create table tenant_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  due_date date,
  paid_date date,
  method text,
  status text not null default 'pendente' check (status in ('pendente', 'pago', 'atrasado', 'cancelado')),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references profiles(id) on delete set null
);
create index idx_tenant_payments_tenant on tenant_payments(tenant_id);

-- 2.13d platform_settings (migration_043) — dados globais do SaaS EM SI
-- (diferente de system_settings, que é por-tenant). Singleton de verdade:
-- 1 linha só pra plataforma inteira, tela "Configurações da Plataforma".
create table platform_settings (
  id boolean primary key default true check (id),
  support_email text,
  support_phone text,
  welcome_message text,
  default_trial_days integer check (default_trial_days is null or default_trial_days > 0),
  updated_at timestamptz not null default now()
);
insert into platform_settings (id) values (true);

-- 2.13e platform_metrics_snapshots (migration_043) — 1 linha por dia,
-- capturada pelo cron diário (api/cron-daily-check.js) ou manualmente pelo
-- Administrador Master (tela "Métricas históricas"), pra alimentar gráficos
-- de evolução mês a mês sem depender de reconstruir histórico perdido.
create table platform_metrics_snapshots (
  snapshot_date date primary key,
  active_tenants integer not null,
  total_tenants integer not null,
  mrr numeric not null,
  total_clients integer not null,
  total_gerentes integer not null,
  total_contracts_active integer not null,
  total_capital_active numeric not null,
  captured_at timestamptz not null default now()
);

-- ============================================================================
-- 3. TRIGGER: criar profiles automaticamente ao registrar em auth.users
-- ============================================================================

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_max_clientes int;
begin
  -- Fase 1c (SaaS multi-empresa): 'tenant_id' em raw_user_meta_data resolve
  -- direto o tenant — usado só pelos fluxos SERVIDOR-A-SERVIDOR de criação
  -- de conta (api/create-user.js, api/create-tenant.js — service_role,
  -- tenant_id vem de um profile já autenticado no servidor, nunca do corpo
  -- da requisição HTTP). 'invite_token' (Fase 4) é o caminho pro cadastro
  -- PÚBLICO (login.js, cliente se autocadastrando com `?convite=<token>` na
  -- URL) — resolve_invite_token() já validou o token antes de mostrar o
  -- formulário, mas o valor final é sempre resolvido aqui de novo, no
  -- servidor, nunca confiando cegamente no que o navegador mandou. Sem
  -- nenhum dos dois campos (cadastro público comum, sem link de convite),
  -- cai no fallback de sempre — seu próprio tenant.
  v_tenant_id := coalesce(
    nullif(new.raw_user_meta_data->>'tenant_id', '')::uuid,
    (select id from tenants where invite_token = new.raw_user_meta_data->>'invite_token' and active),
    default_tenant_id()
  );

  -- Fase 5 (limite de clientes por plano): só aplicado quando a origem é o
  -- cadastro PÚBLICO (self-signup) — reconhecido pela AUSÊNCIA do campo
  -- 'tenant_id' bruto no metadata (esse campo só é enviado pelos endpoints
  -- servidor-a-servidor, que já fazem sua própria checagem de limite ANTES
  -- de chegar aqui, olhando o papel certo — 'gerente' ou 'cliente' — coisa
  -- que este trigger não sabe ainda nesse ponto, já que todo mundo nasce
  -- 'cliente' aqui antes de uma eventual promoção).
  if new.raw_user_meta_data->>'tenant_id' is null then
    select (p.limits->>'max_clientes')::int into v_max_clientes
    from tenants t left join plans p on p.id = t.plan_id
    where t.id = v_tenant_id;

    if v_max_clientes is not null and v_max_clientes <= (select count(*) from clients where tenant_id = v_tenant_id) then
      raise exception 'CLIENT_LIMIT_EXCEEDED';
    end if;
  end if;

  insert into public.profiles (id, full_name, email, role, cpf, phone, tenant_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    lower(new.email),
    'cliente',
    new.raw_user_meta_data->>'cpf',
    new.raw_user_meta_data->>'phone',
    v_tenant_id
  )
  on conflict (id) do nothing;

  insert into public.clients (profile_id, company, job_title, salary, pix_key, client_group, tenant_id)
  values (
    new.id,
    new.raw_user_meta_data->>'company',
    new.raw_user_meta_data->>'job_title',
    nullif(new.raw_user_meta_data->>'salary', ''),
    new.raw_user_meta_data->>'pix_key',
    nullif(new.raw_user_meta_data->>'client_group', ''),
    v_tenant_id
  )
  on conflict (profile_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Ao promover uma conta de cliente para gerente, remove a linha de clients
-- criada por padrão pelo trigger acima (senão o novo gerente continua
-- aparecendo na lista de clientes).
create or replace function trg_cleanup_client_on_promotion()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.role = 'gerente' and old.role = 'cliente' then
    delete from clients where profile_id = new.id;
  end if;
  return new;
end;
$$;

create trigger after_profile_role_promoted
  after update of role on profiles
  for each row execute function trg_cleanup_client_on_promotion();

-- ============================================================================
-- 4. FUNÇÕES HELPER DE RLS (security definer para evitar recursão de policy)
-- ============================================================================

create or replace function is_gerente()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'gerente' and active
  );
$$;

create or replace function is_primary_admin()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'gerente' and is_primary_admin and active
  );
$$;

-- Dono da plataforma inteira (Fase 2/3 da transformação em SaaS multi-
-- empresa) — global, não por-tenant. Diferente de is_primary_admin(), que
-- qualquer empresa cliente do SaaS também tem (o admin primário DELA).
create or replace function is_platform_owner()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and platform_owner and active
  );
$$;

create or replace function is_active_gerente(p_id uuid)
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (select 1 from profiles where id = p_id and role = 'gerente' and active);
$$;

-- Tenant do usuário autenticado — usada em toda política de RLS que precisa
-- restringir visibilidade a "só o meu tenant" (Fase 1a da transformação em
-- SaaS multi-empresa, ver migration_031.sql para o histórico completo).
create or replace function current_tenant_id()
returns uuid
language sql stable
security definer set search_path = public
as $$
  select tenant_id from profiles where id = auth.uid();
$$;

-- Trava de segurança: só o admin primário (ou uma chamada com service_role,
-- usada pelas serverless functions de /api ao criar/promover conta) pode
-- mudar `role`/`is_primary_admin` de qualquer linha de profiles — protege
-- contra um gerente secundário se auto-promover chamando a REST API direto
-- (fora das RPCs/telas do app, que já checam is_primary_admin() por conta
-- própria, mas RLS sozinha não bastava pra fechar esse buraco).
create or replace function prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- `active` entrou aqui junto de role/is_primary_admin: sem essa checagem, um
  -- gerente desativado (sessão do navegador ainda válida — desativar não
  -- revoga o token) conseguia se REATIVAR sozinho com um PATCH direto em
  -- profiles (a policy profiles_update_self permite update na própria linha
  -- sem restringir coluna), recuperando acesso total.
  if (new.role is distinct from old.role
      or new.is_primary_admin is distinct from old.is_primary_admin
      or new.active is distinct from old.active)
     and not is_primary_admin()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: só o administrador primário pode alterar papel/privilégio/status de uma conta';
  end if;

  -- platform_owner (Fase 2, SaaS multi-empresa) é mais rígido que os 3
  -- campos acima: nem is_primary_admin() basta aqui — só service_role (uso
  -- interno/scripts administrativos), nunca uma sessão de usuário comum,
  -- senão o admin primário de QUALQUER tenant conseguiria se auto-promover
  -- a dono da plataforma inteira via REST direto.
  if new.platform_owner is distinct from old.platform_owner
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: platform_owner só pode ser alterado internamente';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_profile_privilege_escalation on profiles;
create trigger trg_prevent_profile_privilege_escalation
  before update of role, is_primary_admin, active, platform_owner on profiles
  for each row execute function prevent_profile_privilege_escalation();

-- ============================================================================
-- 5. FUNÇÕES DE NEGÓCIO
-- ============================================================================

-- 5.1 Saldo devedor em aberto de um cliente (considera ciclo de renovação mais
-- recente em aberto no lugar da soma de parcelas, quando existir)
create or replace function client_outstanding_balance(p_client_id uuid)
returns numeric
language plpgsql stable
security definer set search_path = public
as $$
begin
  -- Fase 1b (SaaS multi-empresa): gerente só consulta saldo de cliente do
  -- PRÓPRIO tenant — sem isso, um gerente de outra empresa podia informar o
  -- profile_id de um cliente alheio e receber o saldo devedor dele de volta,
  -- mesmo sem conseguir ver esse cliente na lista (RLS da Fase 1a não cobre
  -- chamada de função, só select direto em tabela).
  if not (
    (is_gerente() and exists(select 1 from clients where profile_id = p_client_id and tenant_id = current_tenant_id()))
    or auth.uid() = p_client_id
  ) then
    raise exception 'FORBIDDEN';
  end if;

  return (select coalesce(sum(
    case
      when exists (
        select 1 from renewal_cycles rc
        where rc.contract_id = lc.id and rc.status in ('pendente','atrasada')
      )
      then (
        select rc.full_debt_amount from renewal_cycles rc
        where rc.contract_id = lc.id and rc.status in ('pendente','atrasada')
        order by rc.cycle_number desc limit 1
      )
      else (
        select coalesce(sum(i.amount_due - i.principal_paid_partial - i.interest_paid_partial), 0) from installments i
        where i.contract_id = lc.id and i.status in ('pendente','atrasada')
      )
    end
  ), 0)
  from loan_contracts lc
  where lc.client_id = p_client_id
    and lc.status in ('em_aberto', 'atrasado'));
end;
$$;

-- 5.1b Capital ainda em aberto de um cliente (só o principal, sem juros) —
-- é isso que consome o limite de crédito, não o saldo devedor total (que já
-- inclui juros a receber). Renovação não abate capital, então conta o
-- principal_amount inteiro do contrato enquanto houver ciclo em aberto.
create or replace function client_outstanding_principal(p_client_id uuid)
returns numeric
language plpgsql stable
security definer set search_path = public
as $$
begin
  -- Fase 1b: mesmo raciocínio de client_outstanding_balance() acima.
  if not (
    (is_gerente() and exists(select 1 from clients where profile_id = p_client_id and tenant_id = current_tenant_id()))
    or auth.uid() = p_client_id
  ) then
    raise exception 'FORBIDDEN';
  end if;

  return (select coalesce(sum(
    case
      when exists (
        select 1 from renewal_cycles rc
        where rc.contract_id = lc.id and rc.status in ('pendente','atrasada')
      )
      then lc.principal_amount
      else (
        select coalesce(sum(i.principal_share - i.principal_paid_partial), 0) from installments i
        where i.contract_id = lc.id and i.status in ('pendente','atrasada')
      )
    end
  ), 0)
  from loan_contracts lc
  where lc.client_id = p_client_id
    and lc.status in ('em_aberto', 'atrasado'));
end;
$$;

-- 5.2 Checagem de limite de crédito (uso interno/gerente — chamada sempre com
-- p_client_id verificado por quem chama; client_outstanding_principal() já
-- reforça a própria checagem de titularidade/role por baixo). Fase 1b: não
-- precisou de filtro de tenant PRÓPRIO — a chamada a client_outstanding_
-- principal() já lança FORBIDDEN antes de qualquer coisa se p_client_id for
-- de outro tenant, então essa proteção já chega aqui "de graça".
create or replace function check_credit_limit(p_client_id uuid, p_new_principal numeric)
returns boolean
language plpgsql stable
security definer set search_path = public
as $$
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;
  return (client_outstanding_principal(p_client_id) + p_new_principal) <=
         (select credit_limit from clients where profile_id = p_client_id);
end;
$$;

-- 5.3 Trigger de defesa em profundidade no insert de contrato
create or replace function trg_check_credit_limit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- Trava a linha do cliente ANTES de somar o saldo em aberto — sem isso,
  -- duas criações de contrato concorrentes (dois gerentes, ou duplo-clique)
  -- podiam, juntas, ultrapassar o limite mesmo cada uma passando na
  -- checagem isoladamente (race condition clássica check-then-act). Mesmo
  -- padrão de defesa já usado em receive_payment/renew_installment pra
  -- parcela/ciclo, replicado aqui pro cliente.
  perform 1 from clients where profile_id = new.client_id for update;
  if not check_credit_limit(new.client_id, new.principal_amount) then
    raise exception 'CREDIT_LIMIT_EXCEEDED';
  end if;
  return new;
end;
$$;

create trigger before_insert_loan_contract
  before insert on loan_contracts
  for each row execute function trg_check_credit_limit();

-- 5.3a Defesa em profundidade: bloqueia SOLICITAÇÃO de empréstimo (cliente,
-- pré-contrato) acima do limite de crédito disponível. Diferente de
-- check_credit_limit (só gerente), aqui quem insere é o próprio cliente —
-- client_outstanding_principal() já valida auth.uid() = p_client_id por baixo.
create or replace function trg_check_credit_limit_request()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_limit numeric;
begin
  -- Bug real corrigido (2026-08-10, achado testando o fluxo completo de uma
  -- 2ª empresa em produção): cliente-solicitar.js nunca envia `tenant_id` no
  -- insert, então a coluna sempre caía no DEFAULT (default_tenant_id(), o
  -- seu próprio tenant) — todo cliente de QUALQUER empresa assinante que
  -- solicitava empréstimo tinha a solicitação parar na caixa "Solicitações"
  -- do Administrador Master, nunca na da própria empresa. Corrigido
  -- forçando o tenant_id correto aqui, SEMPRE a partir do próprio perfil de
  -- quem está inserindo (current_tenant_id()) — nunca confiando em nada que
  -- o cliente mandou (ou deixou de mandar). Roda antes da checagem de
  -- limite abaixo, então já protege esse cálculo também.
  new.tenant_id := current_tenant_id();

  -- Mesma trava de corrida do trigger acima, agora pro fluxo de solicitação.
  select credit_limit into v_limit from clients where profile_id = new.client_id for update;
  if (client_outstanding_principal(new.client_id) + new.requested_amount) > coalesce(v_limit, 0) then
    raise exception 'CREDIT_LIMIT_EXCEEDED';
  end if;
  return new;
end;
$$;

create trigger before_insert_loan_request
  before insert on loan_requests
  for each row execute function trg_check_credit_limit_request();

-- 5.3b Número do contrato: 5 dígitos aleatórios, únicos
create or replace function generate_contract_number()
returns integer
language plpgsql
as $$
declare
  candidate integer;
  already_used boolean;
begin
  loop
    candidate := floor(random() * 90000 + 10000)::integer; -- 10000..99999
    select exists(select 1 from loan_contracts where contract_number = candidate) into already_used;
    exit when not already_used;
  end loop;
  return candidate;
end;
$$;

create or replace function set_contract_number()
returns trigger
language plpgsql
as $$
begin
  if new.contract_number is null then
    new.contract_number := generate_contract_number();
  end if;
  return new;
end;
$$;

create trigger before_insert_contract_number
  before insert on loan_contracts
  for each row execute function set_contract_number();

-- 5.4 Cálculo de parcelas (juros simples, dividido igualmente) — usado tanto
-- para preview (sem gravar) quanto para geração de verdade
create or replace function calc_installments_preview(
  p_principal numeric,
  p_interest_rate numeric,
  p_installments_count integer,
  p_due_type due_type,
  p_first_installment_date date,
  p_custom_interval_days integer default null
)
returns table (
  sequence_number integer,
  due_date date,
  principal_share numeric,
  interest_share numeric
)
language plpgsql stable
as $$
declare
  total_interest numeric(12,2);
  principal_per numeric(12,2);
  interest_per numeric(12,2);
  principal_accum numeric(12,2) := 0;
  interest_accum numeric(12,2) := 0;
  step interval;
  i integer;
begin
  total_interest := round(p_principal * p_interest_rate / 100.0, 2);
  principal_per := round(p_principal / p_installments_count, 2);
  interest_per := round(total_interest / p_installments_count, 2);
  step := case p_due_type
    when 'mensal' then interval '1 month'
    when 'quinzenal' then interval '15 days'
    when 'semanal' then interval '7 days'
    when 'personalizado' then (coalesce(p_custom_interval_days, 30) || ' days')::interval
  end;
  for i in 1..p_installments_count loop
    sequence_number := i;
    due_date := p_first_installment_date + (step * (i - 1));
    -- A última parcela absorve o resto do arredondamento (método do maior
    -- resto) — sem isso, `round(principal/count,2)` fixo em toda parcela
    -- podia perder/sobrar centavos que nunca eram atribuídos a nenhuma
    -- parcela (ex: R$1.000 ÷ 3 = R$333,33 × 3 = R$999,99, faltando R$0,01
    -- pra bater com principal_amount do contrato).
    if i = p_installments_count then
      principal_share := p_principal - principal_accum;
      interest_share := total_interest - interest_accum;
    else
      principal_share := principal_per;
      interest_share := interest_per;
      principal_accum := principal_accum + principal_per;
      interest_accum := interest_accum + interest_per;
    end if;
    return next;
  end loop;
end;
$$;

-- 5.5 Criação de contrato (transacional): valida limite, insere contrato,
-- grava parcelas (as calculadas ou as editadas manualmente pelo gerente),
-- vincula solicitação de origem se houver.
-- p_installments_override: jsonb array [{sequence_number, due_date, principal_share, interest_share}, ...]
-- ou null para usar o cálculo automático.
create or replace function create_loan_contract(
  p_client_id uuid,
  p_principal_amount numeric,
  p_interest_rate numeric,
  p_installments_count integer,
  p_due_type due_type,
  p_contract_date date,
  p_first_installment_date date,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_allows_renewal boolean,
  p_late_fee_percent numeric,
  p_late_interest_percent numeric,
  p_observations text,
  p_origin_request_id uuid default null,
  p_installments_override jsonb default null,
  p_custom_interval_days integer default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_contract_id uuid;
  v_row jsonb;
  v_principal_sum numeric;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN: apenas gerentes podem criar contratos';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c: cliente precisa pertencer ao mesmo tenant de quem cria o
  -- contrato — sem isso, uma chamada direta à RPC (fora do fluxo normal do
  -- app, que já só deixa escolher clientes do próprio tenant) conseguia
  -- criar um contrato em nome de cliente de OUTRO tenant.
  if not exists (select 1 from clients where profile_id = p_client_id and tenant_id = v_tenant_id) then
    raise exception 'FORBIDDEN: cliente não pertence ao seu tenant';
  end if;

  insert into loan_contracts (
    client_id, created_by, origin_request_id, tenant_id,
    principal_amount, interest_rate, installments_count, due_type, custom_interval_days,
    has_operational_fee, operational_fee_amount,
    contract_date, first_installment_date,
    allows_renewal, late_fee_percent, late_interest_percent, observations
  ) values (
    p_client_id, auth.uid(), p_origin_request_id, v_tenant_id,
    p_principal_amount, p_interest_rate, p_installments_count, p_due_type, p_custom_interval_days,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0),
    p_contract_date, p_first_installment_date,
    p_allows_renewal, coalesce(p_late_fee_percent, 0), coalesce(p_late_interest_percent, 0), p_observations
  ) returning id into v_contract_id;

  if p_installments_override is not null then
    for v_row in select * from jsonb_array_elements(p_installments_override) loop
      -- Defesa em profundidade: o wizard já trava capital/juros negativos no
      -- JS, mas a RPC é pública (security definer) e não deveria confiar só
      -- na UI pra isso — parcela com juros negativo apareceria como lucro
      -- negativo mais tarde, sem nenhum aviso.
      if (v_row->>'principal_share')::numeric < 0 or (v_row->>'interest_share')::numeric < 0 then
        raise exception 'INVALID_AMOUNT';
      end if;
      insert into installments (contract_id, sequence_number, due_date, principal_share, interest_share, tenant_id)
      values (
        v_contract_id,
        (v_row->>'sequence_number')::integer,
        (v_row->>'due_date')::date,
        (v_row->>'principal_share')::numeric,
        (v_row->>'interest_share')::numeric,
        v_tenant_id
      );
    end loop;
  else
    insert into installments (contract_id, sequence_number, due_date, principal_share, interest_share, tenant_id)
    select v_contract_id, sequence_number, due_date, principal_share, interest_share, v_tenant_id
    from calc_installments_preview(p_principal_amount, p_interest_rate, p_installments_count, p_due_type, p_first_installment_date, p_custom_interval_days);
  end if;

  -- Reconciliação: a soma do capital das parcelas geradas/editadas precisa
  -- bater com o capital do contrato (dentro de uma tolerância de centavos
  -- de arredondamento) — sem isso, um valor digitado errado no wizard (ou
  -- um override malformado) desalinha o capital total sem nenhum aviso,
  -- inflando/reduzindo artificialmente o limite de crédito consumido por
  -- esse contrato (client_outstanding_principal soma as parcelas em aberto).
  select coalesce(sum(principal_share), 0) into v_principal_sum from installments where contract_id = v_contract_id;
  if abs(v_principal_sum - p_principal_amount) > greatest(0.02 * p_installments_count, 0.02) then
    raise exception 'PRINCIPAL_MISMATCH';
  end if;

  if p_origin_request_id is not null then
    update loan_requests
      set status = 'aprovada', resulting_contract_id = v_contract_id,
          decided_by = auth.uid(), decided_at = now()
      where id = p_origin_request_id and tenant_id = v_tenant_id;
  end if;

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (
    p_client_id, 'contrato_criado', 'in_app', v_contract_id,
    'Novo contrato criado',
    'Seu contrato #' || v_contract_id || ' no valor de R$ ' || p_principal_amount || ' foi criado.',
    v_tenant_id
  );

  return v_contract_id;
end;
$$;

-- 5.5b Login por CPF: função pública (chamada ANTES do login, então precisa
-- ser security definer) que só resolve CPF -> e-mail, nada mais sensível.
-- INTENCIONALMENTE sem filtro de tenant (Fase 1b, SaaS multi-empresa): CPF é
-- único em toda a PLATAFORMA (profiles.cpf unique, sem escopo por tenant), e
-- quem digita o CPF ainda não tem sessão nenhuma (current_tenant_id() daria
-- null de qualquer forma) — o sistema só descobre a que tenant a pessoa
-- pertence DEPOIS de autenticar. Implicação de produto que fica registrada
-- aqui: hoje o mesmo CPF não pode ser cliente de duas empresas diferentes na
-- plataforma (um profile = um tenant, sempre) — se isso precisar mudar no
-- futuro, é redesenho de identidade, não um ajuste desta função.
create or replace function email_for_cpf(p_cpf text)
returns text
language sql stable
security definer set search_path = public
as $$
  select email from profiles where cpf = p_cpf limit 1;
$$;

-- 5.5c Dados públicos da empresa pro cliente (nome/whatsapp) — o SELECT
-- direto em system_settings é exclusivo de gerente (vazava taxas/caixa
-- interno), então o cliente usa esta RPC pros 2 únicos campos que precisa.
-- Fase 1b: troca "where id = true" (a única linha que podia existir até
-- agora) por "where tenant_id = current_tenant_id()" — hoje ainda dá no
-- mesmo resultado (só existe 1 linha), mas já deixa a função certa pro dia
-- em que system_settings passar a ter 1 linha por tenant (mudança de chave
-- primária ainda pendente, fora do escopo desta fase).
create or replace function public_company_info()
returns table (company_name text, company_whatsapp text)
language plpgsql stable
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'FORBIDDEN';
  end if;
  return query select s.company_name, s.company_whatsapp from system_settings s where s.tenant_id = current_tenant_id();
end;
$$;

-- 5.5d Feature "Indicações" — cliente indica outro cliente (clients.
-- referred_by_client_id, preenchido pelo gerente no cadastro). Quem indicou
-- acompanha o andamento da dívida de quem ele indicou num menu próprio.

-- Usada só dentro de RLS (loan_contracts/installments/renewal_cycles) —
-- nunca chamada direto pelo frontend. Fase 1b: exige que o cliente indicado
-- esteja no MESMO tenant de quem chama — na prática um vínculo de indicação
-- só deveria existir dentro do mesmo tenant mesmo, isso é defesa em
-- profundidade caso esse dado fique inconsistente por algum outro motivo.
create or replace function is_referrer_of(p_client_id uuid)
returns boolean
language sql stable
security definer set search_path = public
as $$
  select coalesce((select referrals_enabled from tenants where id = current_tenant_id()), false)
    and exists(
      select 1 from clients
      where profile_id = p_client_id
        and referred_by_client_id = auth.uid()
        and tenant_id = current_tenant_id()
    );
$$;

-- Gate leve do menu "Indicações" — chamada 1x no login do cliente.
create or replace function has_referrals()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select coalesce((select referrals_enabled from tenants where id = current_tenant_id()), false)
    and exists(select 1 from clients where referred_by_client_id = auth.uid() and tenant_id = current_tenant_id());
$$;

-- Lista curada (só profile_id + nome) de quem o cliente logado indicou — a
-- tela Indicações usa isso pra saber DE QUEM buscar contratos/parcelas.
-- Bypassa RLS de clients/profiles por ser security definer, mas devolve só 2
-- campos não-sensíveis — nunca CPF/telefone/endereço/renda/pix do indicado
-- (esses ficam protegidos pela RLS normal de clients, que não muda).
create or replace function list_my_referred_clients()
returns table (client_id uuid, full_name text)
language sql stable
security definer set search_path = public
as $$
  select c.profile_id, p.full_name
  from clients c
  join profiles p on p.id = c.profile_id
  where c.referred_by_client_id = auth.uid()
    and c.tenant_id = current_tenant_id()
    and coalesce((select referrals_enabled from tenants where id = current_tenant_id()), false)
  order by p.full_name;
$$;

-- Autocomplete do campo "Indicado por": busca clientes por nome (parcial,
-- case-insensitive) enquanto o gerente digita. Só gerente chama (vaza nomes/
-- CPF de outros clientes). p_exclude_client_id evita que o próprio cliente em
-- edição apareça como opção de indicador (defesa em profundidade — o mesmo
-- já é bloqueado pelo check clients_no_self_referral no banco). Fase 1b:
-- sem o filtro de tenant abaixo, um gerente de outra empresa conseguia
-- digitar qualquer coisa nesse campo e ver nome+CPF de clientes de QUALQUER
-- tenant da plataforma — era a única função de busca sem nenhum filtro.
create or replace function search_clients_for_referral(p_query text, p_exclude_client_id uuid default null)
returns table (profile_id uuid, full_name text, cpf text)
language plpgsql stable
security definer set search_path = public
as $$
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  if not coalesce((select referrals_enabled from tenants where id = current_tenant_id()), false) then
    return; -- lista vazia — recurso desligado pra este tenant, sem erro
  end if;

  return query
    select p.id, p.full_name, p.cpf
    from profiles p
    join clients c on c.profile_id = p.id
    where p.role = 'cliente'
      and c.tenant_id = current_tenant_id()
      and (p_exclude_client_id is null or p.id <> p_exclude_client_id)
      and p.full_name ilike '%' || trim(p_query) || '%'
    order by p.full_name
    limit 8;
end;
$$;

-- 5.6 Rejeitar solicitação
create or replace function reject_request(p_request_id uuid, p_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_client_id uuid;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c: filtro de tenant_id abaixo garante que um gerente só reprova
  -- solicitação do próprio tenant — REQUEST_NOT_FOUND_OR_ALREADY_DECIDED
  -- também cobre "existe mas é de outro tenant", sem revelar a diferença.
  update loan_requests
    set status = 'reprovada', decision_reason = p_reason, decided_by = auth.uid(), decided_at = now()
    where id = p_request_id and status = 'pendente' and tenant_id = v_tenant_id
    returning client_id into v_client_id;

  if v_client_id is null then
    raise exception 'REQUEST_NOT_FOUND_OR_ALREADY_DECIDED';
  end if;

  insert into notifications_log (recipient_id, event, channel, title, body, tenant_id)
  values (v_client_id, 'solicitacao_reprovada', 'in_app', 'Solicitação reprovada',
          coalesce('Motivo: ' || p_reason, 'Sua solicitação de empréstimo foi reprovada.'), v_tenant_id);
end;
$$;

-- 5.6b Sincroniza o status do CONTRATO a partir do estado real das suas
-- parcelas/ciclos — reabre quem tem pendência em dia (em_aberto), atrasa
-- quem tem pendência vencida (atrasado), e fecha (quitado ou perda, se
-- alguma parcela/ciclo foi perdido) quem não tem mais nada pendente/
-- atrasado. Função única reusada por refresh_overdue_status() (cron diário),
-- receive_payment/receive_cycle_payment (quitação) e as RPCs de marcar/
-- reverter perda — evita duplicar essa lógica em 5 lugares diferentes.
create or replace function recompute_contract_status(p_contract_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_has_atrasada boolean;
  v_has_open boolean;
  v_has_loss boolean;
  v_new_status contract_status;
begin
  -- Fase 1c: só existia checagem nenhuma antes — qualquer cliente autenticado
  -- podia chamar essa RPC direto. Não vaza/corrompe dado real (recalcula a
  -- partir do estado verdadeiro das parcelas, não aceita valor arbitrário),
  -- mas não deveria ser chamável por conta de cliente. Precisa aceitar
  -- service_role porque também é chamada de dentro de refresh_overdue_status
  -- (cron diário, sem sessão de usuário).
  if not is_gerente() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN';
  end if;

  select
    exists(select 1 from installments where contract_id = p_contract_id and status = 'atrasada')
      or exists(select 1 from renewal_cycles where contract_id = p_contract_id and status = 'atrasada'),
    exists(select 1 from installments where contract_id = p_contract_id and status in ('pendente', 'atrasada'))
      or exists(select 1 from renewal_cycles where contract_id = p_contract_id and status in ('pendente', 'atrasada'))
    into v_has_atrasada, v_has_open;

  if v_has_open then
    v_new_status := case when v_has_atrasada then 'atrasado' else 'em_aberto' end;
  else
    select exists(select 1 from installments where contract_id = p_contract_id and status = 'perda')
        or exists(select 1 from renewal_cycles where contract_id = p_contract_id and status = 'perda')
      into v_has_loss;
    v_new_status := case when v_has_loss then 'perda' else 'quitado' end;
  end if;

  update loan_contracts set status = v_new_status, updated_at = now()
    where id = p_contract_id and status <> v_new_status;
end;
$$;

-- 5.7 Receber pagamento (quitação total ou parcial de uma parcela)
create or replace function receive_payment(
  p_installment_id uuid,
  p_amount_received numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_notes text default null,
  p_late_charge_amount numeric default 0,
  p_received_at date default current_date
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_installment installments%rowtype;
  v_contract loan_contracts%rowtype;
  v_payment_id uuid;
  v_remaining_interest numeric;
  v_remaining_principal numeric;
  v_remaining_total numeric;
  v_max_allowed numeric;
  v_pay_interest numeric;
  v_pay_principal numeric;
  v_pay_late numeric;
  v_after_interest numeric;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c: sem o filtro de tenant_id abaixo, um gerente de outra empresa
  -- podia informar o id de uma parcela de QUALQUER tenant e registrar um
  -- pagamento contra ela — grava dinheiro no lugar errado, o tipo de bug
  -- mais grave desta fase inteira. v_installment.id is null cobre "não
  -- existe" e "existe mas é de outro tenant" com a mesma mensagem, sem
  -- revelar a diferença.
  select * into v_installment from installments where id = p_installment_id and tenant_id = v_tenant_id for update;
  if v_installment.id is null then
    raise exception 'NOT_FOUND';
  end if;
  if v_installment.status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  v_remaining_interest := v_installment.interest_share - v_installment.interest_paid_partial;
  v_remaining_principal := v_installment.principal_share - v_installment.principal_paid_partial;
  v_remaining_total := v_remaining_interest + v_remaining_principal;
  -- encargo de atraso (juros/multa por dias em atraso) é cobrado por cima do
  -- saldo contratual da parcela, não entra no controle de parcial da parcela.
  v_max_allowed := v_remaining_total + coalesce(p_late_charge_amount, 0);

  if p_amount_received <= 0 or p_amount_received > v_max_allowed + 0.01 then
    raise exception 'INVALID_AMOUNT';
  end if;

  select * into v_contract from loan_contracts where id = v_installment.contract_id for update;

  -- paga juros primeiro, depois capital, e qualquer valor além do saldo
  -- contratual da parcela é encargo de atraso (lucro extra, sem afetar o
  -- controle de pagamento parcial da parcela) --
  -- permite pagamento parcial: se p_amount_received < v_remaining_total,
  -- a parcela continua em aberto pelo valor restante.
  v_pay_interest := least(p_amount_received, v_remaining_interest);
  v_after_interest := p_amount_received - v_pay_interest;
  v_pay_principal := least(v_after_interest, v_remaining_principal);
  v_pay_late := v_after_interest - v_pay_principal;

  insert into payments (
    contract_id, installment_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract.id, p_installment_id, 'quitacao_parcela', p_amount_received,
    v_pay_principal, v_pay_interest + v_pay_late, v_pay_late,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date), v_tenant_id
  ) returning id into v_payment_id;

  update installments set
    principal_paid_partial = principal_paid_partial + v_pay_principal,
    interest_paid_partial = interest_paid_partial + v_pay_interest
  where id = p_installment_id;

  if v_remaining_total - p_amount_received <= 0.01 then
    update installments set status = 'paga', paid_at = coalesce(p_received_at, current_date) where id = p_installment_id;
    perform recompute_contract_status(v_contract.id);

    insert into notifications_log (recipient_id, event, channel, related_contract_id, related_installment_id, title, body, tenant_id)
    values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id, p_installment_id,
            'Pagamento recebido', 'Recebemos seu pagamento de R$ ' || p_amount_received || '.', v_tenant_id);
  else
    insert into notifications_log (recipient_id, event, channel, related_contract_id, related_installment_id, title, body, tenant_id)
    values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id, p_installment_id,
            'Pagamento parcial recebido',
            'Recebemos R$ ' || p_amount_received || '. Restam R$ ' || round(v_remaining_total - p_amount_received, 2) || ' desta parcela.', v_tenant_id);
  end if;

  return v_payment_id;
end;
$$;

-- 5.8 Renovar parcela (paga só juros, dívida cheia renova por mais um ciclo)
create or replace function renew_installment(
  p_source_type request_source,
  p_source_id uuid, -- installment_id OU renewal_cycle_id, conforme p_source_type
  p_interest_only_amount numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_notes text default null,
  p_late_charge_amount numeric default 0,
  p_received_at date default current_date,
  p_new_due_date date default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_contract_id uuid;
  v_due_type due_type;
  v_custom_days integer;
  v_principal numeric;
  v_interest numeric;
  v_full_debt numeric;
  v_new_due_date date;
  v_cycle_number integer;
  v_new_cycle_id uuid;
  v_payment_id uuid;
  v_client_id uuid;
  v_step interval;
  v_status installment_status;
  v_installments_count integer;
  v_allows_renewal boolean;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

  if p_interest_only_amount < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if p_source_type = 'installment' then
    -- Descontar o que já foi pago parcialmente (principal_paid_partial/
    -- interest_paid_partial) antes de renovar — mesmo ajuste que
    -- receive_payment já faz corretamente. Sem isso, renovar uma parcela que
    -- tinha recebido pagamento parcial recriava a dívida CHEIA original no
    -- novo ciclo, fazendo o valor já pago "sumir" do saldo devedor do
    -- cliente. greatest(0, ...) é defesa extra contra qualquer estado
    -- inconsistente anterior (parcela editada com valor abaixo do já pago).
    -- Fase 1c: filtro de tenant_id evita renovar parcela de outro tenant.
    select i.contract_id,
           greatest(0, i.principal_share - i.principal_paid_partial),
           greatest(0, i.interest_share - i.interest_paid_partial),
           i.status
      into v_contract_id, v_principal, v_interest, v_status
      from installments i where i.id = p_source_id and i.tenant_id = v_tenant_id for update;
  else
    select rc.contract_id, 0, (rc.full_debt_amount - 0), rc.status
      into v_contract_id, v_principal, v_interest, v_status
      from renewal_cycles rc where rc.id = p_source_id and rc.tenant_id = v_tenant_id for update;
    -- para ciclos já renovados, o "capital" permanece o mesmo da 1ª parcela original;
    -- full_debt_amount do ciclo anterior já é o total (capital+juros) então usamos ele
    select rc.full_debt_amount into v_full_debt from renewal_cycles rc where rc.id = p_source_id and rc.tenant_id = v_tenant_id;
    v_principal := 0;
    v_interest := v_full_debt; -- mantém o valor cheio como base do próximo ciclo abaixo
  end if;

  if v_contract_id is null then
    raise exception 'NOT_FOUND';
  end if;

  -- defesa contra corrida: duplo-clique ou dois gerentes renovando a mesma
  -- parcela/ciclo quase simultaneamente. O FOR UPDATE acima trava a linha, mas
  -- sem essa checagem a 2ª chamada (liberada após a 1ª commitar) seguia em
  -- frente do mesmo jeito, gerando um segundo renewal_cycles + payments
  -- duplicado pro mesmo evento — mesmo padrão de proteção já usado em
  -- receive_payment/receive_cycle_payment.
  if v_status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  select lc.due_type, lc.client_id, lc.custom_interval_days, lc.installments_count, lc.allows_renewal
    into v_due_type, v_client_id, v_custom_days, v_installments_count, v_allows_renewal
    from loan_contracts lc where lc.id = v_contract_id;

  -- Renovação só é permitida em contratos de parcela única com o flag
  -- habilitado — a RPC nunca validava isso no servidor, só a UI escondia o
  -- botão (openReceberModal só monta a aba "Renovar" quando canRenew=true);
  -- um cliente técnico chamando a RPC direto conseguiria renovar qualquer
  -- contrato multi-parcela, deixando a relação entre as demais parcelas e o
  -- ciclo renovado ambígua (ver decisão documentada em CLAUDE.md).
  if v_installments_count <> 1 or not coalesce(v_allows_renewal, false) then
    raise exception 'RENEWAL_NOT_ALLOWED';
  end if;

  v_full_debt := coalesce(v_full_debt, v_principal + v_interest);

  v_step := case v_due_type
    when 'mensal' then interval '1 month'
    when 'quinzenal' then interval '15 days'
    when 'semanal' then interval '7 days'
    when 'personalizado' then (coalesce(v_custom_days, 30) || ' days')::interval
  end;
  -- p_new_due_date deixa o gerente escolher a data manualmente (tela de
  -- recebimento) — se não vier, cai no cálculo automático de sempre.
  v_new_due_date := coalesce(p_new_due_date, coalesce(p_received_at, current_date) + v_step);

  select coalesce(max(cycle_number), 0) + 1 into v_cycle_number
    from renewal_cycles where contract_id = v_contract_id;

  insert into renewal_cycles (
    contract_id, cycle_number, origin_installment_id, previous_cycle_id,
    interest_only_amount, full_debt_amount, new_due_date, created_by, tenant_id
  ) values (
    v_contract_id, v_cycle_number,
    case when p_source_type = 'installment' then p_source_id else null end,
    case when p_source_type = 'renewal_cycle' then p_source_id else null end,
    p_interest_only_amount, v_full_debt, v_new_due_date, auth.uid(), v_tenant_id
  ) returning id into v_new_cycle_id;

  if p_source_type = 'installment' then
    update installments set status = 'renovada', renewed_into_cycle_id = v_new_cycle_id where id = p_source_id;
  else
    update renewal_cycles set status = 'renovada' where id = p_source_id;
  end if;

  insert into payments (
    contract_id, renewal_cycle_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract_id, v_new_cycle_id, 'renovacao_juros', p_interest_only_amount + coalesce(p_late_charge_amount, 0),
    0, p_interest_only_amount + coalesce(p_late_charge_amount, 0), coalesce(p_late_charge_amount, 0),
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date), v_tenant_id
  ) returning id into v_payment_id;

  -- Inclui 'perda' de propósito: um contrato marcado em cobrança que ainda
  -- assim recebe uma renovação volta a ficar em_aberto — sem isso, ele
  -- continuava invisível pra client_outstanding_principal/_balance (que
  -- filtram só em_aberto/atrasado), subestimando o limite de crédito
  -- consumido pelo cliente mesmo com uma dívida ativa sendo paga de novo.
  update loan_contracts set status = 'em_aberto', updated_at = now()
    where id = v_contract_id and status in ('em_aberto', 'atrasado', 'perda');

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (v_client_id, 'renovacao_registrada', 'in_app', v_contract_id,
          'Renovação registrada', 'Sua dívida foi renovada. Novo vencimento: ' || v_new_due_date, v_tenant_id);

  return v_new_cycle_id;
end;
$$;

-- 5.8b Quitar definitivamente um ciclo de renovação (encerra o contrato,
-- em vez de renovar mais uma vez)
create or replace function receive_cycle_payment(
  p_cycle_id uuid,
  p_amount_received numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_notes text default null,
  p_late_charge_amount numeric default 0,
  p_received_at date default current_date
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_cycle renewal_cycles%rowtype;
  v_contract loan_contracts%rowtype;
  v_principal numeric;
  v_interest numeric;
  v_full_amount_due numeric;
  v_payment_id uuid;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c: mesmo raciocínio de receive_payment() — sem o filtro de
  -- tenant_id, um gerente de outra empresa conseguia quitar um ciclo de
  -- renovação de QUALQUER tenant.
  select * into v_cycle from renewal_cycles where id = p_cycle_id and tenant_id = v_tenant_id for update;
  if v_cycle.id is null then
    raise exception 'NOT_FOUND';
  end if;
  if v_cycle.status not in ('pendente', 'atrasada') then
    raise exception 'CYCLE_NOT_PAYABLE';
  end if;

  -- Ciclo de renovação NÃO tem controle de pagamento parcial (diferente de
  -- installments, que tem principal_paid_partial/interest_paid_partial) —
  -- essa função só existe pra quitação total. Sem essa checagem, um valor
  -- menor que o devido era aceito do mesmo jeito e o ciclo/contrato eram
  -- marcados como quitados mesmo sem o valor real ter entrado, inflando o
  -- lucro registrado nos relatórios (que gravavam o valor CHEIO esperado,
  -- não o que realmente veio em p_amount_received).
  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  v_full_amount_due := v_cycle.full_debt_amount + coalesce(p_late_charge_amount, 0);
  if p_amount_received <= 0 or abs(p_amount_received - v_full_amount_due) > 0.01 then
    raise exception 'INVALID_AMOUNT';
  end if;

  select * into v_contract from loan_contracts where id = v_cycle.contract_id for update;
  v_principal := v_contract.principal_amount;
  v_interest := v_cycle.full_debt_amount - v_principal;

  insert into payments (
    contract_id, renewal_cycle_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract.id, p_cycle_id, 'quitacao_final', p_amount_received,
    v_principal, v_interest + coalesce(p_late_charge_amount, 0), coalesce(p_late_charge_amount, 0),
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date), v_tenant_id
  ) returning id into v_payment_id;

  update renewal_cycles set status = 'paga', paid_at = coalesce(p_received_at, current_date) where id = p_cycle_id;
  perform recompute_contract_status(v_contract.id);

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id,
          'Pagamento recebido', 'Recebemos seu pagamento de R$ ' || p_amount_received || '. Contrato quitado.', v_tenant_id);

  return v_payment_id;
end;
$$;

-- 5.9 Recalcular status de atraso/perda (chamado 1x/dia pelo cron)
create or replace function refresh_overdue_status()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_client_id uuid;
  v_contract_id uuid;
begin
  update installments set status = 'atrasada'
    where status = 'pendente' and due_date < current_date;

  update renewal_cycles set status = 'atrasada'
    where status = 'pendente' and new_due_date < current_date;

  -- Perda automática — marca a PARCELA/CICLO específico que ultrapassou o
  -- prazo configurado (loss_days_threshold), não mais o contrato inteiro:
  -- outras parcelas do mesmo contrato continuam intocadas (decisão explícita
  -- do usuário, 2026-07-27 — "perda da parcela específica"). O valor
  -- perdido é o capital ainda não recuperado daquela parcela/ciclo. Isso
  -- roda ANTES da sincronização de status do contrato logo abaixo, pra um
  -- contrato cuja única pendência acabou de virar perda não ser promovido
  -- por engano pra 'em_aberto' (não existe mais 'atrasada' nele) em vez de
  -- corretamente fechar como 'perda'.
  update installments set
    status = 'perda',
    principal_lost = greatest(0, principal_share - principal_paid_partial),
    loss_recognized_at = now()
  where status = 'atrasada'
    and due_date < current_date - (select loss_days_threshold from system_settings);

  update renewal_cycles rc set
    status = 'perda',
    principal_lost = coalesce((select lc.principal_amount from loan_contracts lc where lc.id = rc.contract_id), 0),
    loss_recognized_at = now()
  where status = 'atrasada'
    and new_due_date < current_date - (select loss_days_threshold from system_settings);

  -- Sincroniza o status de cada contrato ainda aberto a partir do estado
  -- real das suas parcelas/ciclos (em_aberto/atrasado/quitado/perda) — uma
  -- função só (recompute_contract_status), reusada também pelas RPCs de
  -- recebimento e de marcar/reverter perda, substitui as 3 atualizações que
  -- existiam soltas aqui antes.
  for v_contract_id in select id from loan_contracts where status in ('em_aberto', 'atrasado')
  loop
    perform recompute_contract_status(v_contract_id);
  end loop;

  -- Recalcula o score de todo cliente com contrato atrasado ou em perda, para
  -- o score refletir o estado atual mesmo sem nenhum recebimento novo (senão
  -- o score de um cliente inadimplente que não interage mais fica parado).
  for v_client_id in
    select distinct client_id from loan_contracts where status in ('atrasado', 'perda')
  loop
    perform recalculate_client_score(v_client_id);
  end loop;
end;
$$;

-- 5.9b Marcar/reverter perda manualmente numa parcela ou ciclo específico —
-- mesmo efeito da perda automática do cron (ver refresh_overdue_status),
-- só que disparado pelo gerente a qualquer momento (não precisa esperar o
-- prazo configurado). "Reverter" é o caminho de recuperação: se o cliente
-- pagar depois de já reconhecida a perda, o gerente reverte a parcela/ciclo
-- específico (ela volta a aparecer no Cobrar normalmente) e o pagamento
-- entra como lucro no mês em que realmente aconteceu — nunca reabre
-- retroativamente o mês em que a perda já foi contabilizada.
create or replace function mark_installment_loss(p_installment_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_installment installments%rowtype;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  select * into v_installment from installments where id = p_installment_id and tenant_id = current_tenant_id() for update;
  if v_installment.id is null then raise exception 'NOT_FOUND'; end if;
  if v_installment.status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  update installments set
    status = 'perda',
    principal_lost = greatest(0, principal_share - principal_paid_partial),
    loss_recognized_at = now()
  where id = p_installment_id;

  perform recompute_contract_status(v_installment.contract_id);
end;
$$;

create or replace function revert_installment_loss(p_installment_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_installment installments%rowtype;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  select * into v_installment from installments where id = p_installment_id and tenant_id = current_tenant_id() for update;
  if v_installment.id is null then raise exception 'NOT_FOUND'; end if;
  if v_installment.status <> 'perda' then raise exception 'NOT_IN_LOSS'; end if;

  update installments set
    status = case when due_date < current_date then 'atrasada' else 'pendente' end,
    principal_lost = 0,
    loss_recognized_at = null
  where id = p_installment_id;

  perform recompute_contract_status(v_installment.contract_id);
end;
$$;

create or replace function mark_cycle_loss(p_cycle_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_cycle renewal_cycles%rowtype;
  v_principal numeric;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  select * into v_cycle from renewal_cycles where id = p_cycle_id and tenant_id = current_tenant_id() for update;
  if v_cycle.id is null then raise exception 'NOT_FOUND'; end if;
  if v_cycle.status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  select principal_amount into v_principal from loan_contracts where id = v_cycle.contract_id;

  update renewal_cycles set
    status = 'perda',
    principal_lost = coalesce(v_principal, 0),
    loss_recognized_at = now()
  where id = p_cycle_id;

  perform recompute_contract_status(v_cycle.contract_id);
end;
$$;

create or replace function revert_cycle_loss(p_cycle_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_cycle renewal_cycles%rowtype;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  select * into v_cycle from renewal_cycles where id = p_cycle_id and tenant_id = current_tenant_id() for update;
  if v_cycle.id is null then raise exception 'NOT_FOUND'; end if;
  if v_cycle.status <> 'perda' then raise exception 'NOT_IN_LOSS'; end if;

  update renewal_cycles set
    status = case when new_due_date < current_date then 'atrasada' else 'pendente' end,
    principal_lost = 0,
    loss_recognized_at = null
  where id = p_cycle_id;

  perform recompute_contract_status(v_cycle.contract_id);
end;
$$;

-- 5.10 Recalcular score de crédito de um cliente
create or replace function recalculate_client_score(p_client_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_total int; v_on_time int; v_early int; v_avg_delay numeric;
  v_quitados int; v_recovery boolean; v_renewals_on_time int; v_has_perda boolean;
  v_any_renewal_paid boolean; v_graduated boolean;
  v_overdue_now boolean; v_delay_penalty numeric; v_overdue_penalty numeric; v_perda_penalty numeric;
  v_qualidade numeric; v_volume numeric; v_maturidade numeric; v_score numeric;
begin
  -- service_role: chamada interna via refresh_overdue_status() no cron diário
  -- (api/cron-daily-check.js), sem sessão de usuário (auth.uid() nulo). Sem
  -- essa checagem, QUALQUER cliente autenticado podia chamar esta RPC direto
  -- e forçar o recálculo do score de qualquer outro cliente à vontade.
  if not is_gerente() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN';
  end if;

  -- Fase 1c: gerente só recalcula cliente do PRÓPRIO tenant — chamada via
  -- service_role (cron, iterando clientes de TODOS os tenants) não tem
  -- sessão de usuário pra comparar contra, e deve continuar irrestrita.
  if is_gerente() and not exists (select 1 from clients where profile_id = p_client_id and tenant_id = current_tenant_id()) then
    raise exception 'FORBIDDEN';
  end if;

  select count(*) filter (where i.status = 'paga'),
         count(*) filter (where i.status = 'paga' and i.paid_at::date <= i.due_date),
         count(*) filter (where i.status = 'paga' and i.paid_at::date < i.due_date)
    into v_total, v_on_time, v_early
    from installments i join loan_contracts lc on lc.id = i.contract_id
    where lc.client_id = p_client_id and i.due_date > current_date - interval '365 days';

  select coalesce(avg(i.paid_at::date - i.due_date), 0) into v_avg_delay
    from installments i join loan_contracts lc on lc.id = i.contract_id
    where lc.client_id = p_client_id and i.status = 'paga' and i.paid_at::date > i.due_date;

  -- Contratos quitados com sucesso: bônus (item novo, aprovado pelo usuário)
  select count(*) into v_quitados from loan_contracts
    where client_id = p_client_id and status = 'quitado';

  -- Recuperação: pagou uma parcela atrasada (mesmo que com atraso) nos
  -- últimos 90 dias — sinaliza reação positiva após um período de atraso.
  select exists(
    select 1 from installments i join loan_contracts lc on lc.id = i.contract_id
    where lc.client_id = p_client_id and i.status = 'paga'
      and i.paid_at::date > i.due_date and i.paid_at > now() - interval '90 days'
  ) into v_recovery;

  -- Renovações pagas em dia: agora somam pontos (antes subtraíam — corrigido
  -- porque renovar em dia é comportamento recorrente saudável, não um sinal
  -- de risco).
  select count(*) into v_renewals_on_time from renewal_cycles rc
    join loan_contracts lc on lc.id = rc.contract_id
    where lc.client_id = p_client_id and rc.status = 'paga' and rc.paid_at::date <= rc.new_due_date;

  -- "Graduação": qualquer renovação paga (em dia ou não) já conta pro marco
  -- de primeira renovação — o bônus de PONTOS por renovar em dia é outra
  -- conta (v_renewals_on_time acima).
  select exists(
    select 1 from renewal_cycles rc join loan_contracts lc on lc.id = rc.contract_id
    where lc.client_id = p_client_id and rc.status = 'paga'
  ) into v_any_renewal_paid;

  select exists(
    select 1 from loan_contracts where client_id = p_client_id and status = 'perda'
  ) into v_has_perda;

  -- Atraso ATUAL (parcela/ciclo vencido e ainda não pago) — mesmo padrão
  -- "due_date < hoje ao vivo" usado no resto do sistema (não confia só na
  -- coluna status, que só é atualizada 1x/dia pelo cron).
  select exists(
    select 1 from installments i join loan_contracts lc on lc.id = i.contract_id
    where lc.client_id = p_client_id and i.status in ('pendente', 'atrasada') and i.due_date < current_date
    union all
    select 1 from renewal_cycles rc join loan_contracts lc on lc.id = rc.contract_id
    where lc.client_id = p_client_id and rc.status in ('pendente', 'atrasada') and rc.new_due_date < current_date
  ) into v_overdue_now;

  -- Cliente novo começa e permanece com score 50 até quitar o primeiro
  -- contrato ou fazer a primeira renovação — só a partir desse marco
  -- ("graduação") os BÔNUS de comportamento passam a mexer no score. Mas
  -- perda e atraso (histórico ou atual) são sinais de risco que sempre
  -- valem, graduado ou não — não podem ficar escondidos atrás da graduação.
  v_graduated := (v_quitados > 0) or v_any_renewal_paid;

  v_delay_penalty := least(20, greatest(0, v_avg_delay * 2));
  v_overdue_penalty := case when v_overdue_now then 15 else 0 end;
  v_perda_penalty := case when v_has_perda then 30 else 0 end;

  if not v_graduated then
    v_score := 50 - v_delay_penalty - v_overdue_penalty - v_perda_penalty;
  else
    -- Reprovações de solicitação NÃO entram mais como critério (decisão
    -- explícita do usuário — nunca deve ser usado pra avaliar o cliente).
    --
    -- Regra revisada em 2026-07-10 (aprovada pelo usuário): chegar a 100 não
    -- pode ser fácil, e cada ponto acima de 80 deve custar progressivamente
    -- mais. Separamos QUALIDADE (consistência de pagamento, 0 a 1) de
    -- MATURIDADE (volume de histórico acumulado, 0 a 1, com retornos
    -- decrescentes via 1 - e^(-volume/8)) — o bônus é o produto dos dois, não
    -- a soma. Isso faz um único contrato quitado adiantado valer só ~7 pts
    -- de bônus (score ~77), enquanto encostar em 100 exige dezenas de
    -- eventos positivos sustentados (parcelas pagas, contratos quitados,
    -- renovações em dia) — impossível de forçar rápido, porque cada evento
    -- extra rende cada vez menos.
    v_qualidade := least(1,
      0.6 * coalesce(v_on_time::numeric / nullif(v_total, 0), 0.5) +
      0.4 * coalesce(v_early::numeric / nullif(v_total, 0), 0.3)
    );
    v_volume := v_total + v_quitados + v_renewals_on_time;
    v_maturidade := 1 - exp(-v_volume / 8.0);

    v_score := 70
      + 30 * v_qualidade * v_maturidade
      + (case when v_recovery then 2 else 0 end)
      - v_delay_penalty - v_overdue_penalty - v_perda_penalty;
  end if;

  v_score := least(100, greatest(0, round(v_score)));

  update clients set
    score = v_score,
    score_tier = case
      when v_score >= 85 then 'Ouro'
      when v_score >= 70 then 'Bom'
      when v_score >= 50 then 'Atenção'
      else 'Alto risco'
    end,
    score_updated_at = now()
  where profile_id = p_client_id;
end;
$$;

create or replace function recalculate_all_scores()
returns void
language plpgsql
security definer set search_path = public
as $$
declare v_client record;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  -- Fase 1c: sem o filtro de tenant_id, "Recalcular todos" (botão manual e
  -- disparo automático no login) recalculava o score de TODOS os clientes
  -- da PLATAFORMA inteira, não só do próprio tenant.
  for v_client in select profile_id from clients where tenant_id = current_tenant_id() loop
    perform recalculate_client_score(v_client.profile_id);
  end loop;
end;
$$;

-- 5.11 Criar novo cliente diretamente pelo gerente (cadastro manual, sem passar por auth.users)
-- Usado quando o gerente cadastra um cliente que ainda não tem login — o cliente reivindica
-- a conta depois via "esqueci minha senha" no mesmo e-mail, OU o gerente já cria com convite.
-- Mantido simples: apenas atualiza campos de um cliente já existente (criado via signUp).
create or replace function update_client_profile(
  p_client_id uuid,
  p_full_name text,
  p_cpf text,
  p_phone text,
  p_credit_limit numeric,
  p_client_group text,
  p_notes text,
  p_company text default null,
  p_job_title text default null,
  p_salary text default null,
  p_pix_key text default null,
  p_referred_by_client_id uuid default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_referrals_enabled boolean;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c: sem esta checagem, um gerente conseguia editar nome/CPF/
  -- telefone/limite de crédito de cliente de QUALQUER tenant da plataforma.
  if not exists (select 1 from clients where profile_id = p_client_id and tenant_id = v_tenant_id) then
    raise exception 'FORBIDDEN';
  end if;

  -- Recurso "Indicações" é exclusivo do Tenant #1 (ver tenants.referrals_
  -- enabled) — trava o valor em NULL sempre que o tenant não tem o recurso
  -- ligado, não importa o que o front-end mandar em p_referred_by_client_id.
  select referrals_enabled into v_referrals_enabled from tenants where id = v_tenant_id;

  update profiles set full_name = p_full_name, cpf = p_cpf, phone = p_phone, updated_at = now()
    where id = p_client_id;

  update clients set credit_limit = p_credit_limit,
    client_group = p_client_group, notes = p_notes,
    company = p_company, job_title = p_job_title, salary = p_salary, pix_key = p_pix_key,
    referred_by_client_id = case when coalesce(v_referrals_enabled, false) then p_referred_by_client_id else null end
    where profile_id = p_client_id;
end;
$$;

-- 5.11z Completar cadastro após login social (Google) — o cadastro manual
-- (login.js, aba "Criar conta") sempre exige CPF/telefone/empresa/cargo/
-- renda/grupo/chave Pix antes de enviar pro Supabase Auth; o botão "Continuar
-- com Google" pula esse formulário inteiro (só nome/e-mail vêm do Google),
-- deixando esses campos nulos. Essa RPC é chamada pelo front (tela nova
-- renderCompleteRegistrationScreen em login.js) logo após o primeiro login
-- via Google, ANTES do cliente conseguir ver a tela "cadastro em análise" —
-- garante que todo cliente, não importa como entrou, sempre tem os mesmos
-- dados mínimos que o admin precisa pra aprovar o cadastro.
-- Só funciona enquanto approval_status ainda é 'pendente' — depois que o
-- admin decide, esse auto-serviço fecha (edição de cliente já aprovado é
-- sempre via update_client_profile, exclusiva do gerente).
create or replace function complete_client_registration(
  p_full_name text,
  p_cpf text,
  p_phone text,
  p_company text,
  p_job_title text,
  p_salary text,
  p_client_group text,
  p_pix_key text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_client_id uuid := auth.uid();
begin
  if v_client_id is null then raise exception 'FORBIDDEN'; end if;
  if not exists (select 1 from clients where profile_id = v_client_id and approval_status = 'pendente') then
    raise exception 'FORBIDDEN';
  end if;
  if p_full_name is null or trim(p_full_name) = '' then raise exception 'MISSING_FULL_NAME'; end if;
  if p_cpf is null or length(regexp_replace(p_cpf, '\D', '', 'g')) <> 11 then raise exception 'INVALID_CPF'; end if;
  if p_phone is null or trim(p_phone) = '' then raise exception 'MISSING_PHONE'; end if;
  if p_company is null or trim(p_company) = '' then raise exception 'MISSING_COMPANY'; end if;
  if p_job_title is null or trim(p_job_title) = '' then raise exception 'MISSING_JOB_TITLE'; end if;
  if p_salary is null or trim(p_salary) = '' then raise exception 'MISSING_SALARY'; end if;
  if p_client_group is null or trim(p_client_group) = '' then raise exception 'MISSING_GROUP'; end if;
  if p_pix_key is null or trim(p_pix_key) = '' then raise exception 'MISSING_PIX_KEY'; end if;

  update profiles set full_name = p_full_name, cpf = p_cpf, phone = p_phone, updated_at = now()
    where id = v_client_id;
  update clients set company = p_company, job_title = p_job_title, salary = p_salary,
    client_group = p_client_group, pix_key = p_pix_key
    where profile_id = v_client_id;
end;
$$;

-- 5.11a Editar contrato (campos que não exigem recalcular parcelas já geradas)
create or replace function update_contract(
  p_contract_id uuid,
  p_interest_rate numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_allows_renewal boolean,
  p_late_fee_percent numeric,
  p_late_interest_percent numeric,
  p_observations text
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  update loan_contracts set
    interest_rate = p_interest_rate,
    has_operational_fee = p_has_operational_fee,
    operational_fee_amount = coalesce(p_operational_fee_amount, 0),
    allows_renewal = p_allows_renewal,
    late_fee_percent = coalesce(p_late_fee_percent, 0),
    late_interest_percent = coalesce(p_late_interest_percent, 0),
    observations = p_observations,
    updated_at = now()
  -- Fase 1c: sem o filtro de tenant_id, um gerente editava contrato de
  -- qualquer tenant informando o id direto.
  where id = p_contract_id and tenant_id = current_tenant_id();
end;
$$;

-- Editar/reagendar uma parcela específica — permitido em QUALQUER status
-- (inclusive já paga/renovada, ou de contrato já finalizado/quitado), pra
-- o administrador poder corrigir um dado lançado errado. A proteção contra
-- reduzir abaixo do valor já efetivamente recebido continua valendo sempre
-- (ver AMOUNT_BELOW_ALREADY_PAID abaixo) — isso não recalcula pagamentos já
-- registrados em `payments`/ciclos de renovação já criados, é só a edição
-- do registro da própria parcela.
create or replace function update_installment_schedule(
  p_installment_id uuid,
  p_due_date date,
  p_principal_share numeric,
  p_interest_share numeric
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_installment installments%rowtype;
  v_installments_count integer;
  v_principal_amount numeric;
  v_principal_sum numeric;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  -- Fase 1c: sem o filtro de tenant_id, um gerente editava/reagendava
  -- parcela de qualquer tenant informando o id direto.
  select * into v_installment from installments where id = p_installment_id and tenant_id = current_tenant_id();
  if v_installment.id is null then raise exception 'NOT_FOUND'; end if;

  -- Não deixa o novo valor ficar abaixo do que já foi pago (parcial ou
  -- integralmente) — sem essa checagem, o saldo restante (amount_due -
  -- paid_partial) ficava negativo, e "Pago parcial: resta R$-X" aparecia
  -- nas telas do cliente.
  if p_principal_share < v_installment.principal_paid_partial
    or p_interest_share < v_installment.interest_paid_partial
  then
    raise exception 'AMOUNT_BELOW_ALREADY_PAID';
  end if;

  update installments set
    due_date = p_due_date,
    principal_share = p_principal_share,
    interest_share = p_interest_share,
    -- Se a parcela já foi reconhecida como perda, o valor perdido precisa
    -- acompanhar a correção do capital — senão uma edição posterior (ex:
    -- corrigir um valor digitado errado) deixaria o abate do lucro
    -- registrado num mês antigo desatualizado em relação ao capital real.
    principal_lost = case when status = 'perda' then greatest(0, p_principal_share - v_installment.principal_paid_partial) else principal_lost end
  where id = p_installment_id;

  -- Reconciliação: mesmo raciocínio de create_loan_contract — a soma do
  -- capital de todas as parcelas do contrato precisa continuar batendo com
  -- o capital contratado, dentro de uma tolerância de centavos de
  -- arredondamento. Sem isso, um typo no valor da parcela (ex: 5000 em vez
  -- de 500) muda silenciosamente o capital total do contrato, distorcendo
  -- o limite de crédito consumido (client_outstanding_principal) sem
  -- nenhum aviso pro admin.
  select installments_count, principal_amount into v_installments_count, v_principal_amount
    from loan_contracts where id = v_installment.contract_id;
  select coalesce(sum(principal_share), 0) into v_principal_sum
    from installments where contract_id = v_installment.contract_id;
  if abs(v_principal_sum - v_principal_amount) > greatest(0.02 * v_installments_count, 0.02) then
    raise exception 'PRINCIPAL_MISMATCH';
  end if;
end;
$$;

-- Editar a taxa operacional de ENTRADA de um pagamento já recebido —
-- diferente de update_contract (que edita a taxa de SAÍDA, uma vez por
-- contrato), essa taxa é cobrada por PAGAMENTO e fica em payments, não em
-- installments. net_profit (coluna gerada) recalcula sozinho ao mudar
-- operational_fee_amount, então relatórios/lucro líquido já refletem o ajuste.
create or replace function update_payment_fee(
  p_payment_id uuid,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  -- Fase 1c: sem o filtro de tenant_id, um gerente editava a taxa de um
  -- pagamento de qualquer tenant informando o id direto.
  if not exists (select 1 from payments where id = p_payment_id and tenant_id = current_tenant_id()) then raise exception 'NOT_FOUND'; end if;

  update payments set
    has_operational_fee = p_has_operational_fee,
    operational_fee_amount = coalesce(p_operational_fee_amount, 0)
  where id = p_payment_id and tenant_id = current_tenant_id();
end;
$$;

-- Excluir um contrato inteiro (e todo o histórico ligado a ele)
create or replace function delete_contract(p_contract_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  -- Fase 1c: confirma que o contrato pertence ao próprio tenant ANTES de
  -- excluir qualquer coisa — sem isso, um gerente conseguia apagar contrato
  -- (e todo o histórico ligado) de QUALQUER tenant informando o id direto.
  if not exists (select 1 from loan_contracts where id = p_contract_id and tenant_id = current_tenant_id()) then
    raise exception 'NOT_FOUND';
  end if;
  delete from payments where contract_id = p_contract_id;
  delete from renewal_cycles where contract_id = p_contract_id;
  delete from installments where contract_id = p_contract_id;
  update loan_requests set resulting_contract_id = null where resulting_contract_id = p_contract_id;
  delete from loan_contracts where id = p_contract_id;
end;
$$;

-- 5.11b Editar dados básicos de outro administrador/gerente (nunca altera
-- is_primary_admin por aqui, propositalmente)
create or replace function update_gerente_profile(
  p_gerente_id uuid,
  p_full_name text,
  p_phone text,
  p_active boolean
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  -- Só o admin primário edita conta de gerente (2026-07-11, decisão
  -- explícita do usuário) — antes qualquer gerente conseguia editar
  -- qualquer outro, inclusive reativar/desativar contas. Fase 1c: filtro de
  -- tenant_id evita que o admin primário de um tenant edite gerente de
  -- OUTRO tenant.
  if not is_primary_admin() then raise exception 'FORBIDDEN'; end if;
  update profiles set full_name = p_full_name, phone = p_phone, active = p_active, updated_at = now()
    where id = p_gerente_id and role = 'gerente' and tenant_id = current_tenant_id();
end;
$$;

-- 5.12 Aprovar / reprovar o cadastro de um cliente (item obrigatório antes de
-- ele conseguir usar o sistema, além da confirmação de e-mail do Supabase Auth)
create or replace function approve_client(p_client_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant_id := current_tenant_id();
  -- Fase 1c: sem o filtro de tenant_id, um gerente aprovava cadastro de
  -- cliente de QUALQUER tenant informando o id direto.
  update clients set approval_status = 'aprovado', decided_by = auth.uid(), decided_at = now(), decision_reason = null
    where profile_id = p_client_id and tenant_id = v_tenant_id;

  insert into notifications_log (recipient_id, event, channel, title, body, tenant_id)
  values (p_client_id, 'solicitacao_aprovada', 'in_app', 'Cadastro aprovado',
          'Sua conta foi aprovada. Você já pode usar o SIGES normalmente.', v_tenant_id);
end;
$$;

create or replace function reject_client(p_client_id uuid, p_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant_id := current_tenant_id();
  update clients set approval_status = 'rejeitado', decided_by = auth.uid(), decided_at = now(), decision_reason = p_reason
    where profile_id = p_client_id and tenant_id = v_tenant_id;

  insert into notifications_log (recipient_id, event, channel, title, body, tenant_id)
  values (p_client_id, 'solicitacao_reprovada', 'in_app', 'Cadastro não aprovado',
          coalesce('Motivo: ' || p_reason, 'Seu cadastro não foi aprovado.'), v_tenant_id);
end;
$$;

-- 5.12a Registrar evento na trilha de auditoria. Callable por anon E
-- authenticated (grant padrão do Supabase já cobre) — precisa funcionar até
-- SEM sessão (ex: tentativa de login falha, onde auth.uid() ainda é null).
-- actor_name/actor_role são resolvidos e congelados no momento do evento.
create or replace function log_audit_event(
  p_action text,
  p_description text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_actor_role text;
  v_tenant_id uuid;
begin
  if v_actor_id is not null then
    select full_name, role::text, tenant_id into v_actor_name, v_actor_role, v_tenant_id from profiles where id = v_actor_id;
  end if;
  -- tenant_id fica NULL quando não há sessão (ex: tentativa de login falha,
  -- onde v_actor_id já é null e não há profile pra resolver tenant nenhum) —
  -- mesmo design nullable de audit_log já decidido na Fase 1a.
  insert into audit_log (actor_id, actor_name, actor_role, action, description, metadata, tenant_id)
  values (v_actor_id, coalesce(v_actor_name, 'Anônimo'), v_actor_role, p_action, p_description, coalesce(p_metadata, '{}'::jsonb), v_tenant_id);

  -- Retenção: mantém só os 500 eventos mais recentes (pedido do usuário,
  -- 2026-07-30) — poda a cada insert, direto aqui, em vez de depender de um
  -- cron separado (a tabela nunca cresce ilimitada, mesmo que o cron diário
  -- falhe ou não rode). Volume de inserts é baixo (uma ação por vez), então
  -- o custo desse DELETE extra a cada chamada é desprezível.
  -- Fase 1c: poda por TENANT (não mais pela tabela inteira) — sem isso, um
  -- tenant com muita atividade podia empurrar pra fora o histórico de OUTRO
  -- tenant, incluindo o do dono da plataforma. `is not distinct from` trata
  -- NULL corretamente (eventos sem tenant são podados entre si, à parte).
  delete from audit_log where tenant_id is not distinct from v_tenant_id and id in (
    select id from audit_log where tenant_id is not distinct from v_tenant_id order by created_at desc offset 500
  );
end;
$$;

-- 5.13 Apagar todos os dados de negócio — só o admin primário. Chamada pela
-- serverless function /api/wipe-all-data.js, que também remove as contas de
-- auth.users dos clientes via service_role (SQL puro não alcança auth.users).
create or replace function wipe_all_business_data()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  -- Fase 5: "Zona de risco" virou exclusiva do Administrador Master (mesmo
  -- requisito original do pivô SaaS que fechou Planejamento/Auditoria) —
  -- antes o admin primário de QUALQUER empresa cliente da plataforma podia
  -- apagar os próprios dados de negócio sozinho, sem passar pelo dono da
  -- plataforma. is_primary_admin() sozinho não bastava mais aqui.
  if not is_platform_owner() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c — ACHADO MAIS GRAVE de toda a auditoria: cada "where true" abaixo
  -- apagava a tabela INTEIRA, de TODOS os tenants da plataforma. O admin
  -- primário de qualquer empresa cliente do SaaS conseguia, sem querer ou
  -- não, apagar os dados de TODAS as outras empresas de uma vez. Agora cada
  -- delete é escopado ao próprio tenant.
  delete from payments where tenant_id = v_tenant_id;
  delete from renewal_cycles where tenant_id = v_tenant_id;
  delete from installments where tenant_id = v_tenant_id;
  delete from loan_contracts where tenant_id = v_tenant_id;
  delete from loan_requests where tenant_id = v_tenant_id;
  delete from notifications_log where tenant_id = v_tenant_id;
  delete from push_subscriptions where tenant_id = v_tenant_id;
  delete from clients where tenant_id = v_tenant_id;
  delete from profiles where role = 'cliente' and tenant_id = v_tenant_id;
end;
$$;

-- 5.13b Planejamento (caixa atual / LTV) também virou exclusivo do
-- Administrador Master (Fase 5) — mas as 2 colunas vivem na MESMA linha de
-- system_settings que dados de empresa/taxas (editáveis por qualquer admin
-- primário), então não dá pra travar isso via RLS sem quebrar Configurações
-- pra todo mundo. Duas RPCs estreitas em vez de UPDATE direto na tabela —
-- gerente-planejamento.js parou de usar supa.from('system_settings').update()
-- pra esses 2 campos especificamente.
create or replace function update_planning_cash(p_value numeric)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  update system_settings set planning_current_cash = p_value where tenant_id = current_tenant_id();
end;
$$;

create or replace function update_planning_ltv(p_value numeric)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  update system_settings set planning_ltv_percent = p_value where tenant_id = current_tenant_id();
end;
$$;

-- 5.14 Gestão de tenants (Fase 3 da transformação em SaaS — Administrador
-- Master gerencia as empresas clientes da plataforma, sem cobrança ainda).

-- Lista todas as empresas + estatísticas básicas — só o Administrador
-- Master vê isto (cada empresa continua só enxergando a própria via
-- tenants_select de RLS).
create or replace function list_tenants_with_stats()
returns table (
  id uuid,
  name text,
  active boolean,
  referrals_enabled boolean,
  created_at timestamptz,
  owner_profile_id uuid,
  admin_name text,
  admin_email text,
  gerente_count bigint,
  cliente_count bigint,
  contract_count bigint,
  invite_token text,
  plan_id uuid,
  plan_name text,
  trial_ends_at timestamptz
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  return query
  select
    t.id, t.name, t.active, t.referrals_enabled, t.created_at, t.owner_profile_id,
    p.full_name, p.email,
    -- Só gerentes SECUNDÁRIOS contam pro limite do plano — o Administrador
    -- (is_primary_admin=true) é sempre 1, fixo, nunca disputa a vaga do
    -- limite (bug real corrigido 2026-08-11: antes contava os dois juntos,
    -- então um plano com "1 gerente" já nascia sem vaga nenhuma pro
    -- Administrador criar um gerente de verdade).
    (select count(*) from profiles g where g.tenant_id = t.id and g.role = 'gerente' and not g.is_primary_admin),
    (select count(*) from clients c where c.tenant_id = t.id),
    (select count(*) from loan_contracts lc where lc.tenant_id = t.id),
    t.invite_token,
    t.plan_id,
    pl.name,
    t.trial_ends_at
  from tenants t
  left join profiles p on p.id = t.owner_profile_id
  left join plans pl on pl.id = t.plan_id
  order by t.created_at asc;
end;
$$;

-- Renomear/(des)ativar uma empresa. Trava de segurança: o Administrador
-- Master nunca consegue desativar o PRÓPRIO tenant por aqui (se travasse a
-- própria conta, ninguém mais poderia reverter — só um acesso direto ao
-- banco resolveria). p_trial_ends_at ajusta o fim do teste grátis dessa
-- empresa manualmente (estender/encurtar um caso pontual, ou mandar null
-- pra "converter pra pago") — normalmente já vem preenchido automaticamente
-- por assign_tenant_plan() quando o plano atribuído tem trial_days.
create or replace function update_tenant(p_tenant_id uuid, p_name text, p_active boolean, p_trial_ends_at timestamptz)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  if p_tenant_id = current_tenant_id() and not p_active then
    raise exception 'CANNOT_DEACTIVATE_OWN_TENANT';
  end if;
  update tenants set
    name = coalesce(nullif(trim(p_name), ''), name),
    active = p_active,
    suspended_at = case when p_active then suspended_at else now() end,
    trial_ends_at = p_trial_ends_at
  where id = p_tenant_id;
end;
$$;

-- Excluir empresa (fase final do pivô SaaS, 2026-08-10) — irreversível, por
-- isso com travas: nunca a própria empresa do Administrador Master, e só
-- funciona com a empresa já SUSPENSA (exige passar por update_tenant com
-- active=false antes, evita exclusão de 1 clique numa empresa ainda ativa).
-- Limpa TODO dado de negócio do tenant (mesmas tabelas de
-- wipe_all_business_data, mas escopado a p_tenant_id em vez de
-- current_tenant_id() — e cobre TAMBÉM planning_debts/system_settings, que
-- wipe_all_business_data não tocava por ser "apagar meus dados", não
-- "apagar minha empresa"). Devolve os profile_id (gerente + cliente) do
-- tenant pra api/delete-tenant.js apagar cada um via Admin API (isso
-- cascateia profiles automaticamente) — só depois de todos apagados é que
-- dá pra apagar a linha de tenants (profiles.tenant_id ainda referenciaria
-- ela até lá).
create or replace function prepare_tenant_deletion(p_tenant_id uuid)
returns setof uuid
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  if p_tenant_id = current_tenant_id() then raise exception 'CANNOT_DELETE_OWN_TENANT'; end if;
  if not exists (select 1 from tenants where id = p_tenant_id) then raise exception 'NOT_FOUND'; end if;
  if (select active from tenants where id = p_tenant_id) then raise exception 'TENANT_MUST_BE_SUSPENDED'; end if;

  delete from payments where tenant_id = p_tenant_id;
  delete from renewal_cycles where tenant_id = p_tenant_id;
  delete from installments where tenant_id = p_tenant_id;
  delete from loan_contracts where tenant_id = p_tenant_id;
  delete from loan_requests where tenant_id = p_tenant_id;
  delete from notifications_log where tenant_id = p_tenant_id;
  delete from push_subscriptions where tenant_id = p_tenant_id;
  delete from planning_debts where tenant_id = p_tenant_id;
  delete from system_settings where tenant_id = p_tenant_id;
  delete from clients where tenant_id = p_tenant_id;
  -- audit_log é histórico cross-tenant só visível ao Administrador Master —
  -- não apaga, só solta a referência (mesmo tratamento de eventos sem
  -- sessão, tenant_id já é nullable).
  update audit_log set tenant_id = null where tenant_id = p_tenant_id;

  return query select id from profiles where tenant_id = p_tenant_id;
end;
$$;

-- Painel executivo da plataforma (Plataforma SaaS → Início) — um único
-- jsonb com tudo que a tela precisa, calculado no servidor num round-trip
-- só (em vez de várias queries separadas). Só o Administrador Master chama.
-- `capital_active`/`total_capital_active` usam SUM(principal_amount) dos
-- contratos em aberto/atrasado — uma aproximação (não desconta capital já
-- pago via installments, diferente da metodologia "carteira ativa" mais
-- precisa usada no Dashboard de cada tenant) deliberadamente mais simples,
-- por ser um número de visão executiva agregada, não uma conciliação
-- contábil exata.
create or replace function get_platform_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_result jsonb;
  v_month_start date := date_trunc('month', current_date)::date;
  v_prev_month_start date := date_trunc('month', current_date - interval '1 month')::date;
  v_prev_month_end date := (v_month_start - interval '1 day')::date;
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;

  select jsonb_build_object(
    'generated_at', now(),
    'summary', jsonb_build_object(
      'total_tenants', (select count(*) from tenants),
      'active_tenants', (select count(*) from tenants where active),
      'suspended_tenants', (select count(*) from tenants where not active),
      'new_this_month', (select count(*) from tenants where created_at::date >= v_month_start),
      'new_last_month', (select count(*) from tenants where created_at::date >= v_prev_month_start and created_at::date <= v_prev_month_end),
      'suspended_this_month', (select count(*) from tenants where suspended_at is not null and suspended_at::date >= v_month_start),
      'deleted_this_month', (select count(*) from audit_log where action = 'empresa_excluida' and created_at::date >= v_month_start),
      'deleted_total', (select count(*) from audit_log where action = 'empresa_excluida'),
      'total_clients', (select count(*) from clients),
      'total_gerentes', (select count(*) from profiles where role = 'gerente' and active),
      'total_contracts_active', (select count(*) from loan_contracts where status in ('em_aberto', 'atrasado')),
      'total_capital_active', (select coalesce(sum(principal_amount), 0) from loan_contracts where status in ('em_aberto', 'atrasado')),
      -- MRR/ticket médio excluem empresa em TESTE ativo (trial_ends_at no
      -- futuro) — ainda não é receita real, só uma projeção do que passa a
      -- valer se/quando a empresa converter pra pago (migration_043).
      'mrr', (
        select coalesce(sum(p.price_monthly), 0) from tenants t join plans p on p.id = t.plan_id
        where t.active and (t.trial_ends_at is null or t.trial_ends_at <= now())
      ),
      'avg_ticket', (
        select case when count(*) > 0 then coalesce(sum(p.price_monthly), 0) / count(*) else 0 end
        from tenants t join plans p on p.id = t.plan_id
        where t.active and p.price_monthly is not null and (t.trial_ends_at is null or t.trial_ends_at <= now())
      ),
      'avg_lifetime_days_suspended', (
        select coalesce(avg(extract(epoch from (suspended_at - created_at)) / 86400), 0)
        from tenants where suspended_at is not null
      ),
      'trials_active', (select count(*) from tenants where active and trial_ends_at is not null and trial_ends_at > now()),
      'trials_expiring_soon', (select count(*) from tenants where active and trial_ends_at is not null and trial_ends_at > now() and trial_ends_at <= now() + interval '7 days'),
      'trials_expired', (select count(*) from tenants where active and trial_ends_at is not null and trial_ends_at <= now()),
      'overdue_payments_count', (select count(*) from tenant_payments where status = 'atrasado'),
      'overdue_payments_amount', (select coalesce(sum(amount), 0) from tenant_payments where status = 'atrasado')
    ),
    'by_plan', (
      select coalesce(jsonb_agg(row), '[]'::jsonb) from (
        select
          coalesce(p.name, 'Sem plano') as plan_name,
          count(t.id) as tenant_count,
          coalesce(sum(p.price_monthly) filter (where t.trial_ends_at is null or t.trial_ends_at <= now()), 0) as mrr_contribution
        from tenants t
        left join plans p on p.id = t.plan_id
        where t.active
        group by p.name
        order by count(t.id) desc
      ) row
    ),
    'tenants', (
      select coalesce(jsonb_agg(row), '[]'::jsonb) from (
        select
          t.id, t.name, t.active, t.created_at, t.suspended_at, t.trial_ends_at,
          p.name as plan_name, p.limits as plan_limits,
          -- Mesmo critério de list_tenants_with_stats — só gerentes
          -- secundários contam pro limite ("Perto do limite do plano").
          (select count(*) from profiles g where g.tenant_id = t.id and g.role = 'gerente' and not g.is_primary_admin) as gerente_count,
          (select count(*) from clients c where c.tenant_id = t.id) as cliente_count,
          (select count(*) from loan_contracts lc where lc.tenant_id = t.id and lc.status in ('em_aberto', 'atrasado')) as contract_count,
          (select coalesce(sum(lc.principal_amount), 0) from loan_contracts lc where lc.tenant_id = t.id and lc.status in ('em_aberto', 'atrasado')) as capital_active,
          (select max(a.created_at) from audit_log a where a.tenant_id = t.id and a.action = 'login_sucesso') as last_login_at,
          (select count(*) from audit_log a where a.tenant_id = t.id and a.action = 'erro_sistema' and a.created_at >= now() - interval '7 days') as errors_recent,
          (select count(*) from tenant_payments tp where tp.tenant_id = t.id and tp.status = 'atrasado') as overdue_count,
          (select coalesce(sum(tp.amount), 0) from tenant_payments tp where tp.tenant_id = t.id and tp.status = 'atrasado') as overdue_amount,
          (select min(tp.due_date) from tenant_payments tp where tp.tenant_id = t.id and tp.status = 'atrasado') as overdue_oldest_due
        from tenants t
        left join plans p on p.id = t.plan_id
        order by t.created_at desc
      ) row
    )
  ) into v_result;

  return v_result;
end;
$$;

-- Usada no login (js/auth.js) pra bloquear acesso de QUALQUER usuário
-- (gerente ou cliente) de uma empresa suspensa pelo Administrador Master —
-- sem exigir is_gerente()/is_platform_owner(), só o próprio tenant de quem
-- chama. Não vaza nada sensível (só um boolean sobre a própria empresa).
create or replace function is_my_tenant_active()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select coalesce((select active from tenants where id = current_tenant_id()), true);
$$;

-- 5.15 Link de convite (Fase 4) — cada empresa (admin primário dela) gera e
-- compartilha o próprio link com os clientes dela. O Administrador Master
-- também pode gerar/consultar de qualquer empresa (suporte).

-- Consultado pela tela Configurações (admin primário da própria empresa).
create or replace function get_my_tenant_invite_info()
returns table (invite_token text, company_name text)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not is_primary_admin() then raise exception 'FORBIDDEN'; end if;
  return query select t.invite_token, t.name from tenants t where t.id = current_tenant_id();
end;
$$;

-- p_tenant_id omitido = a própria empresa de quem chama (admin primário).
-- Informado = só o Administrador Master pode mexer na empresa de outro.
create or replace function regenerate_tenant_invite_token(p_tenant_id uuid default null)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  v_target uuid;
  v_new_token text;
begin
  v_target := coalesce(p_tenant_id, current_tenant_id());
  if not (is_platform_owner() or (is_primary_admin() and v_target = current_tenant_id())) then
    raise exception 'FORBIDDEN';
  end if;
  v_new_token := replace(gen_random_uuid()::text, '-', '');
  update tenants set invite_token = v_new_token where id = v_target;
  return v_new_token;
end;
$$;

-- Pública (anon) — chamada pela tela de cadastro ANTES de qualquer sessão
-- existir, pra mostrar "você está se cadastrando em <empresa>" e validar o
-- link antes de deixar o cadastro prosseguir. Só devolve o nome da empresa
-- (mesma informação que public_company_info() já expõe) — nunca o id real
-- do tenant nem qualquer outro dado.
create or replace function resolve_invite_token(p_token text)
returns table (company_name text)
language sql
stable
security definer set search_path = public
as $$
  select name from tenants where invite_token = p_token and active;
$$;

-- 5.16 Planos configuráveis (Fase 5) — exclusivo do Administrador Master.
-- `limits` (jsonb) fica 100% na mão dele: cria/edita/renomeia plano, e
-- escolhe manualmente quais das chaves conhecidas valem em cada um, pela
-- tela "Planos" (js/screens/plataforma-planos.js).

create or replace function list_plans()
returns setof plans
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  return query select * from plans order by sort_order asc, created_at asc;
end;
$$;

-- p_id null = cria um plano novo; informado = atualiza o existente.
-- p_trial_days: quantos dias de teste grátis uma empresa ganha ao ser
-- atribuída a este plano (null = sem trial). Não é um plano à parte —
-- qualquer plano vira "o Trial do Premium" só preenchendo este campo.
create or replace function upsert_plan(
  p_id uuid,
  p_name text,
  p_description text,
  p_price_monthly numeric,
  p_active boolean,
  p_sort_order integer,
  p_limits jsonb,
  p_trial_days integer
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  if p_name is null or trim(p_name) = '' then raise exception 'INVALID_NAME'; end if;
  if p_trial_days is not null and p_trial_days <= 0 then raise exception 'INVALID_TRIAL_DAYS'; end if;

  if p_id is null then
    insert into plans (name, description, price_monthly, active, sort_order, limits, trial_days)
    values (trim(p_name), nullif(trim(p_description), ''), p_price_monthly, coalesce(p_active, true), coalesce(p_sort_order, 0), coalesce(p_limits, '{}'::jsonb), p_trial_days)
    returning id into v_id;
  else
    update plans set
      name = trim(p_name),
      description = nullif(trim(p_description), ''),
      price_monthly = p_price_monthly,
      active = coalesce(p_active, true),
      sort_order = coalesce(p_sort_order, 0),
      limits = coalesce(p_limits, '{}'::jsonb),
      trial_days = p_trial_days
    where id = p_id
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

-- Apagar um plano é seguro mesmo com empresas usando ele — tenants.plan_id
-- é `on delete set null`, então essas empresas só voltam a ficar "sem
-- plano" (ilimitado), nunca travadas/quebradas.
create or replace function delete_plan(p_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  -- Zera trial_ends_at de qualquer empresa que estava nesse plano ANTES de
  -- apagar — sem isso, tenants.plan_id vira null (on delete set null) mas
  -- trial_ends_at ficava órfão, mostrando "sem plano (ilimitado)" e "Em
  -- teste — expira em Nd" ao mesmo tempo na tela Empresas (contraditório,
  -- bug real achado em teste ao vivo, 2026-08-11).
  update tenants set trial_ends_at = null where plan_id = p_id;
  delete from plans where id = p_id;
end;
$$;

-- Atribuir/remover o plano de uma empresa — p_plan_id null = "sem plano"
-- (ilimitado). Chamado pela tela "Empresas". Se o plano NOVO for diferente
-- do atual e tiver trial_days configurado, o teste começa a contar AGORA
-- (trial_ends_at = now() + trial_days). Reatribuir o MESMO plano de novo
-- não reinicia um teste já em andamento. Plano sem trial_days, ou "sem
-- plano", zera trial_ends_at.
create or replace function assign_tenant_plan(p_tenant_id uuid, p_plan_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_current_plan_id uuid;
  v_trial_days integer;
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;

  select plan_id into v_current_plan_id from tenants where id = p_tenant_id;

  if p_plan_id is distinct from v_current_plan_id then
    v_trial_days := null;
    if p_plan_id is not null then
      select trial_days into v_trial_days from plans where id = p_plan_id;
    end if;

    update tenants set
      plan_id = p_plan_id,
      trial_ends_at = case when v_trial_days is not null then now() + (v_trial_days::text || ' days')::interval else null end
    where id = p_tenant_id;
  end if;
end;
$$;

-- Consultado por QUALQUER usuário autenticado (gerente OU cliente, mesmo
-- padrão de is_my_tenant_active() — não vaza nada sensível, só as chaves de
-- recurso/limite do PRÓPRIO tenant) pra decisões de UI (esconder botão de
-- extrato/promissória/backup fora do plano). Também replicado como checagem
-- no servidor em pontos sensíveis (ver api/create-user.js). Sempre devolve
-- um jsonb (nunca null) — tenant sem plano = '{}' = nenhuma chave de limite
-- presente = tudo liberado/ilimitado nos pontos de checagem (que tratam
-- ausência de chave como "sem limite").
create or replace function get_my_plan_limits()
returns jsonb
language sql
stable
security definer set search_path = public
as $$
  select coalesce(
    (select p.limits from tenants t left join plans p on p.id = t.plan_id where t.id = current_tenant_id()),
    '{}'::jsonb
  );
$$;

-- 5.16 Assinaturas/Cobranças (migration_043) — registro manual de pagamento
-- por empresa assinante (não existe gateway de pagamento na plataforma; é
-- só uma agenda de "empresa X pagou o mês Y", tela "Assinaturas/Cobranças").
create or replace function list_tenant_payments()
returns table (
  id uuid, tenant_id uuid, tenant_name text, amount numeric, due_date date,
  paid_date date, method text, status text, notes text, created_at timestamptz
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  return query
  select tp.id, tp.tenant_id, t.name, tp.amount, tp.due_date, tp.paid_date, tp.method, tp.status, tp.notes, tp.created_at
  from tenant_payments tp
  join tenants t on t.id = tp.tenant_id
  order by coalesce(tp.due_date, tp.created_at::date) desc, tp.created_at desc;
end;
$$;

create or replace function upsert_tenant_payment(
  p_id uuid,
  p_tenant_id uuid,
  p_amount numeric,
  p_due_date date,
  p_paid_date date,
  p_method text,
  p_status text,
  p_notes text
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'INVALID_AMOUNT'; end if;
  if not exists (select 1 from tenants where id = p_tenant_id) then raise exception 'NOT_FOUND'; end if;
  -- "not in" com NULL nunca dá true (lógica de 3 valores do SQL) — sem essa
  -- checagem em separado, um p_status NULL passava direto pro INSERT/UPDATE
  -- e quebrava com o erro cru do Postgres (violação de NOT NULL) em vez da
  -- mensagem amigável INVALID_STATUS (bug real achado em teste ao vivo,
  -- 2026-08-11 — inofensivo hoje porque a tela sempre envia um valor, mas é
  -- a mesma defesa em profundidade já aplicada em outros pontos do schema).
  if p_status is null or p_status not in ('pendente', 'pago', 'atrasado', 'cancelado') then raise exception 'INVALID_STATUS'; end if;

  if p_id is null then
    insert into tenant_payments (tenant_id, amount, due_date, paid_date, method, status, notes, created_by)
    values (p_tenant_id, p_amount, p_due_date, p_paid_date, nullif(trim(p_method), ''), p_status, nullif(trim(p_notes), ''), auth.uid())
    returning id into v_id;
  else
    update tenant_payments set
      tenant_id = p_tenant_id, amount = p_amount, due_date = p_due_date, paid_date = p_paid_date,
      method = nullif(trim(p_method), ''), status = p_status, notes = nullif(trim(p_notes), '')
    where id = p_id
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

-- Geração em lote das cobranças do mês (migration_046) — cria 1 cobrança
-- PENDENTE por empresa ativa com plano pago, usando o preço do plano.
-- Idempotente por mês: empresa que já tem cobrança com vencimento no mesmo
-- mês é PULADA (rodar 2x não duplica). Empresa em TESTE ativo também é
-- pulada — ainda não é pagante, mesmo critério já usado no MRR.
create or replace function generate_monthly_tenant_payments(p_due_date date)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_created integer := 0;
  v_skipped integer := 0;
  v_month_start date;
  v_month_end date;
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  if p_due_date is null then raise exception 'INVALID_DUE_DATE'; end if;

  v_month_start := date_trunc('month', p_due_date)::date;
  v_month_end := (v_month_start + interval '1 month' - interval '1 day')::date;

  -- Conta os pulados ANTES de inserir (depois seriam indistinguíveis dos
  -- recém-criados).
  select count(*) into v_skipped
  from tenants t
  join plans p on p.id = t.plan_id
  where t.active
    and p.price_monthly is not null
    and p.price_monthly > 0
    and (t.trial_ends_at is null or t.trial_ends_at <= now())
    and exists (
      select 1 from tenant_payments tp
      where tp.tenant_id = t.id
        and tp.due_date between v_month_start and v_month_end
        and tp.status <> 'cancelado'
    );

  insert into tenant_payments (tenant_id, amount, due_date, status, created_by)
  select t.id, p.price_monthly, p_due_date, 'pendente', auth.uid()
  from tenants t
  join plans p on p.id = t.plan_id
  where t.active
    and p.price_monthly is not null
    and p.price_monthly > 0
    and (t.trial_ends_at is null or t.trial_ends_at <= now())
    and not exists (
      select 1 from tenant_payments tp
      where tp.tenant_id = t.id
        and tp.due_date between v_month_start and v_month_end
        and tp.status <> 'cancelado'
    );

  get diagnostics v_created = row_count;

  return jsonb_build_object('created', v_created, 'skipped', v_skipped);
end;
$$;

-- Prévia (sem gravar nada) — o modal mostra quantas serão criadas antes de
-- confirmar. Mesmos critérios de generate_monthly_tenant_payments acima; se
-- divergirem no futuro, os dois precisam mudar juntos.
create or replace function preview_monthly_tenant_payments(p_due_date date)
returns jsonb
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_month_start date;
  v_month_end date;
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  if p_due_date is null then raise exception 'INVALID_DUE_DATE'; end if;

  v_month_start := date_trunc('month', p_due_date)::date;
  v_month_end := (v_month_start + interval '1 month' - interval '1 day')::date;

  return (
    select jsonb_build_object(
      'to_create', count(*) filter (where not ja_tem),
      'to_skip', count(*) filter (where ja_tem),
      'total_amount', coalesce(sum(price_monthly) filter (where not ja_tem), 0)
    )
    from (
      select
        p.price_monthly,
        exists (
          select 1 from tenant_payments tp
          where tp.tenant_id = t.id
            and tp.due_date between v_month_start and v_month_end
            and tp.status <> 'cancelado'
        ) as ja_tem
      from tenants t
      join plans p on p.id = t.plan_id
      where t.active
        and p.price_monthly is not null
        and p.price_monthly > 0
        and (t.trial_ends_at is null or t.trial_ends_at <= now())
    ) elegiveis
  );
end;
$$;

-- Marcação automática de atraso (migration_046) — chamada pelo cron diário
-- (api/cron-daily-check.js). Sem isso, o status 'atrasado' de
-- tenant_payments só existia se o Administrador Master lembrasse de setar
-- na mão, o que na prática nunca acontecia. Mesmo raciocínio do
-- refresh_overdue_status() que já existe pras parcelas dos clientes.
create or replace function refresh_tenant_payment_status()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not (is_platform_owner() or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'FORBIDDEN';
  end if;

  update tenant_payments
  set status = 'atrasado'
  where status = 'pendente'
    and due_date is not null
    and due_date < current_date;
end;
$$;

create or replace function delete_tenant_payment(p_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  delete from tenant_payments where id = p_id;
end;
$$;

-- 5.17 Configurações da Plataforma (migration_043) — dados globais do SaaS
-- em si (não de uma empresa).
create or replace function get_platform_settings()
returns platform_settings
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  return (select s from platform_settings s limit 1);
end;
$$;

create or replace function update_platform_settings(
  p_support_email text,
  p_support_phone text,
  p_welcome_message text,
  p_default_trial_days integer
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  update platform_settings set
    support_email = nullif(trim(p_support_email), ''),
    support_phone = nullif(trim(p_support_phone), ''),
    welcome_message = nullif(trim(p_welcome_message), ''),
    default_trial_days = p_default_trial_days,
    updated_at = now()
  where id = true;
end;
$$;

-- 5.18 Comunicados (migration_043) — aviso in-app do Administrador Master
-- pros administradores (gerentes) de uma empresa específica ou de todas.
-- Reaproveita notifications_log/o sino já existente (channel='in_app'), sem
-- e-mail/push — é comunicação da plataforma pro cliente-empresa, não um
-- evento financeiro do negócio de cada um.
create or replace function broadcast_platform_message(p_title text, p_body text, p_tenant_id uuid default null)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_count integer;
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  if p_title is null or trim(p_title) = '' then raise exception 'INVALID_TITLE'; end if;
  if p_body is null or trim(p_body) = '' then raise exception 'INVALID_BODY'; end if;
  if p_tenant_id is not null and not exists (select 1 from tenants where id = p_tenant_id) then raise exception 'NOT_FOUND'; end if;

  insert into notifications_log (recipient_id, event, channel, title, body, tenant_id)
  select id, 'aviso_plataforma', 'in_app', trim(p_title), trim(p_body), tenant_id
  from profiles
  where role = 'gerente' and active
    and (p_tenant_id is null or tenant_id = p_tenant_id);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Histórico de comunicados já enviados — reconstrói cada "disparo" agrupando
-- por (title, body, sent_at) exato: todas as linhas inseridas por uma mesma
-- chamada de broadcast_platform_message compartilham o mesmo sent_at (now()
-- é estável dentro da mesma instrução SQL), então o agrupamento reconstrói
-- o lote certinho sem precisar de uma tabela de "campanhas" separada.
create or replace function list_platform_broadcasts()
returns table (title text, body text, sent_at timestamptz, recipient_count bigint, tenant_scope text)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  return query
  select
    n.title, n.body, n.sent_at, count(*),
    case when count(distinct n.tenant_id) = 1
      -- min()/max() não existem pra uuid no Postgres — (array_agg(...))[1]
      -- pega o mesmo valor único de qualquer jeito, já que aqui só entra
      -- nesse ramo quando TODAS as linhas do grupo compartilham o mesmo
      -- tenant_id (count(distinct)=1), então não importa qual delas.
      then coalesce((select t.name from tenants t where t.id = (array_agg(n.tenant_id))[1]), 'Empresa excluída')
      else 'Todas as empresas'
    end
  from notifications_log n
  where n.event = 'aviso_plataforma'::notification_event
  group by n.title, n.body, n.sent_at
  order by n.sent_at desc
  limit 50;
end;
$$;

-- 5.19 Métricas históricas (migration_043) — snapshot diário (chamado pelo
-- cron já existente, api/cron-daily-check.js), pra alimentar gráficos de
-- evolução mês a mês sem precisar reconstruir histórico que nunca foi
-- guardado.
create or replace function capture_platform_metrics_snapshot()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not (is_platform_owner() or coalesce(auth.role(), '') = 'service_role') then
    raise exception 'FORBIDDEN';
  end if;

  insert into platform_metrics_snapshots (
    snapshot_date, active_tenants, total_tenants, mrr, total_clients,
    total_gerentes, total_contracts_active, total_capital_active
  )
  select
    current_date,
    (select count(*) from tenants where active),
    (select count(*) from tenants),
    (select coalesce(sum(p.price_monthly), 0) from tenants t join plans p on p.id = t.plan_id
       where t.active and (t.trial_ends_at is null or t.trial_ends_at <= now())),
    (select count(*) from clients),
    (select count(*) from profiles where role = 'gerente' and active),
    (select count(*) from loan_contracts where status in ('em_aberto', 'atrasado')),
    (select coalesce(sum(principal_amount), 0) from loan_contracts where status in ('em_aberto', 'atrasado'))
  on conflict (snapshot_date) do update set
    active_tenants = excluded.active_tenants,
    total_tenants = excluded.total_tenants,
    mrr = excluded.mrr,
    total_clients = excluded.total_clients,
    total_gerentes = excluded.total_gerentes,
    total_contracts_active = excluded.total_contracts_active,
    total_capital_active = excluded.total_capital_active,
    captured_at = now();
end;
$$;

create or replace function list_platform_metrics_snapshots()
returns setof platform_metrics_snapshots
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  return query select * from platform_metrics_snapshots order by snapshot_date asc;
end;
$$;

-- ============================================================================
-- 6. ROW LEVEL SECURITY
-- ============================================================================

alter table profiles enable row level security;
alter table clients enable row level security;
alter table loan_requests enable row level security;
alter table loan_contracts enable row level security;
alter table installments enable row level security;
alter table renewal_cycles enable row level security;
alter table payments enable row level security;
alter table notifications_log enable row level security;
alter table push_subscriptions enable row level security;
alter table system_settings enable row level security;
alter table planning_debts enable row level security;
alter table audit_log enable row level security;
alter table tenants enable row level security;
alter table tenant_payments enable row level security;
alter table platform_settings enable row level security;
alter table platform_metrics_snapshots enable row level security;

-- tenants — cada gerente só vê a PRÓPRIA linha (comparação é com o id da
-- própria tabela, não com uma coluna tenant_id — tenants É a entidade
-- tenant, não referencia uma); o Administrador Master vê TODAS (Fase 3 —
-- tela "Empresas"). Sem policy de insert/update/delete — criar/editar
-- tenant é sempre via RPC security definer (create_tenant/update_tenant).
create policy "tenants_select" on tenants for select
  using (is_platform_owner() or (is_gerente() and id = current_tenant_id()));

-- plans (Fase 5) — só o Administrador Master lê a tabela inteira (tela
-- "Planos"). Um gerente comum nunca consulta `plans` direto — os limites
-- efetivos do PRÓPRIO tenant vêm da RPC get_my_plan_limits() (security
-- definer, bypassa RLS, devolve só o `limits` jsonb do plano atual). Sem
-- policy de insert/update/delete — sempre via RPC (upsert_plan/delete_plan).
alter table plans enable row level security;
create policy "plans_select_platform_owner" on plans for select
  using (is_platform_owner());

-- tenant_payments / platform_settings / platform_metrics_snapshots
-- (migration_043) — mesma exclusividade de plans: só o Administrador Master
-- lê, e sempre via RPC security definer (sem policy de insert/update/delete).
create policy "tenant_payments_platform_owner" on tenant_payments for select
  using (is_platform_owner());
create policy "platform_settings_select_owner" on platform_settings for select
  using (is_platform_owner());
create policy "platform_metrics_select_owner" on platform_metrics_snapshots for select
  using (is_platform_owner());

-- profiles
-- is_gerente() sozinho, sem checar tenant_id, deixaria um gerente de
-- QUALQUER empresa ler o perfil de QUALQUER outro usuário da plataforma —
-- todo "using (is_gerente())" bruto abaixo tem o mesmo problema e recebeu o
-- mesmo tratamento (Fase 1a da transformação em SaaS multi-empresa, ver
-- migration_031.sql). Como só existe 1 tenant até a Fase 3, isso não muda
-- nenhum comportamento hoje.
create policy "profiles_select" on profiles for select
  using (id = auth.uid() or (is_gerente() and tenant_id = current_tenant_id()));
create policy "profiles_update_self" on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
-- NENHUMA policy de UPDATE/INSERT/DELETE "genérica pra qualquer gerente"
-- (removida a antiga "profiles_gerente_all" — dava a QUALQUER gerente, mesmo
-- secundário, permissão de escrever direto na tabela via REST, contornando
-- os controles de is_primary_admin() das RPCs). Toda escrita legítima já
-- passa por função security definer (update_client_profile,
-- update_gerente_profile, handle_new_user), que bypassa RLS por ser dona da
-- tabela — não precisa de policy nenhuma aqui.

-- clients
create policy "clients_select" on clients for select
  using (profile_id = auth.uid() or (is_gerente() and tenant_id = current_tenant_id()));
create policy "clients_gerente_write" on clients for insert with check (is_gerente());
create policy "clients_gerente_update" on clients for update
  using (is_gerente() and tenant_id = current_tenant_id());

-- loan_requests
create policy "requests_select" on loan_requests for select
  using (client_id = auth.uid() or (is_gerente() and tenant_id = current_tenant_id()));
-- with check trava também os campos de DECISÃO (status/decided_by/etc.) —
-- sem isso, um cliente técnico conseguia inserir a própria solicitação já
-- com status='aprovado' via REST direto, contornando a aprovação do gerente.
create policy "requests_insert_self" on loan_requests for insert
  with check (
    client_id = auth.uid()
    and exists (select 1 from clients c where c.profile_id = auth.uid() and c.approval_status = 'aprovado')
    and status = 'pendente'
    and decided_by is null
    and decision_reason is null
    and decided_at is null
    and resulting_contract_id is null
  );
create policy "requests_update_gerente" on loan_requests for update
  using (is_gerente() and tenant_id = current_tenant_id());

-- loan_contracts
-- is_referrer_of(client_id): quem indicou este cliente também pode ler os
-- contratos dele (tela "Indicações") — dado financeiro, sem PII, diferente de
-- clients/profiles (que continuam fechados pro indicador).
create policy "contracts_select" on loan_contracts for select
  using (client_id = auth.uid() or (is_gerente() and tenant_id = current_tenant_id()) or is_referrer_of(client_id));
-- "for all" combina com "contracts_select" via OU (Postgres soma todas as
-- políticas permissivas aplicáveis) — por isso o USING abaixo também precisa
-- do filtro de tenant, senão essa política sozinha reabriria a leitura sem
-- filtro nenhum. O WITH CHECK (validar o que pode ser GRAVADO) fica igual
-- por enquanto — ver Fase 1c.
create policy "contracts_gerente_all" on loan_contracts for all
  using (is_gerente() and tenant_id = current_tenant_id()) with check (is_gerente());

-- installments
create policy "installments_select" on installments for select
  using ((is_gerente() and tenant_id = current_tenant_id()) or exists (
    select 1 from loan_contracts lc where lc.id = installments.contract_id
      and (lc.client_id = auth.uid() or is_referrer_of(lc.client_id))
  ));
create policy "installments_gerente_write" on installments for all
  using (is_gerente() and tenant_id = current_tenant_id()) with check (is_gerente());

-- renewal_cycles
create policy "renewal_select" on renewal_cycles for select
  using ((is_gerente() and tenant_id = current_tenant_id()) or exists (
    select 1 from loan_contracts lc where lc.id = renewal_cycles.contract_id
      and (lc.client_id = auth.uid() or is_referrer_of(lc.client_id))
  ));
create policy "renewal_gerente_write" on renewal_cycles for all
  using (is_gerente() and tenant_id = current_tenant_id()) with check (is_gerente());

-- payments
create policy "payments_select" on payments for select
  using ((is_gerente() and tenant_id = current_tenant_id()) or exists (
    select 1 from loan_contracts lc where lc.id = payments.contract_id and lc.client_id = auth.uid()
  ));
create policy "payments_gerente_write" on payments for all
  using (is_gerente() and tenant_id = current_tenant_id()) with check (is_gerente());

-- notifications_log
create policy "notifications_select" on notifications_log for select
  using (recipient_id = auth.uid() or (is_gerente() and tenant_id = current_tenant_id()));
create policy "notifications_update_own" on notifications_log for update
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());
create policy "notifications_gerente_insert" on notifications_log for insert
  with check (is_gerente());

-- push_subscriptions
create policy "push_select_own" on push_subscriptions for select using (profile_id = auth.uid());
create policy "push_insert_own" on push_subscriptions for insert with check (profile_id = auth.uid());
create policy "push_delete_own" on push_subscriptions for delete using (profile_id = auth.uid());

-- system_settings
-- Só gerentes leem a tabela inteira — vazava taxas/percentuais/caixa interno
-- pra qualquer cliente autenticado (a anon key é pública, e a policy antiga
-- só checava auth.uid() is not null, sem checar o papel). Cliente usa a RPC
-- public_company_info() (security definer, ver seção 5) que só devolve
-- company_name/company_whatsapp — os 2 únicos campos que ele realmente usa.
create policy "settings_select_gerente" on system_settings for select
  using (is_gerente() and tenant_id = current_tenant_id());
-- is_primary_admin(), não is_gerente(): Configurações é tela exclusiva do
-- Administrador (routes primaryOnly:true no router) — antes um gerente
-- secundário conseguia alterar taxas/thresholds/caixa via REST direto,
-- contornando a restrição que só existia na UI.
create policy "settings_gerente_update" on system_settings for update
  using (is_primary_admin() and tenant_id = current_tenant_id());

-- planning_debts
-- is_platform_owner() (Fase 5, fecha um requisito original do pivô SaaS:
-- "Planejamento é só meu" — nenhuma empresa cliente da plataforma deve ter
-- essa tela, nem o próprio admin primário dela). Tabela dedicada, só usada
-- por Planejamento — sem risco de colisão com outro uso legítimo.
create policy "planning_debts_gerente_all" on planning_debts for all
  using (is_platform_owner() and tenant_id = current_tenant_id()) with check (is_platform_owner());

-- audit_log — só leitura, e só o Administrador Master (Fase 3, decisão
-- explícita do fundador: Auditoria NUNCA é uma tela do produto SaaS, nem
-- pro admin primário de uma empresa cliente — só ele vê). Escrita é
-- exclusivamente via log_audit_event() (security definer, bypassa RLS),
-- inclusive pra registrar eventos sem sessão (login falho) — por isso não
-- existe policy de insert. is_platform_owner() enxerga TODOS os tenants de
-- propósito (inclusive linhas com tenant_id nulo, de eventos sem sessão) —
-- é o único lugar do sistema com visibilidade cross-tenant intencional.
create policy "audit_log_select_platform_owner" on audit_log for select
  using (is_platform_owner());

-- ============================================================================
-- 7. ÍNDICES DE APOIO
-- ============================================================================

create index idx_installments_contract on installments(contract_id);
create index idx_installments_due_date on installments(due_date) where status in ('pendente','atrasada');
create index idx_renewal_cycles_contract on renewal_cycles(contract_id);
create index idx_renewal_cycles_due_date on renewal_cycles(new_due_date) where status in ('pendente','atrasada');
create index idx_payments_contract on payments(contract_id);
create index idx_loan_contracts_client on loan_contracts(client_id);
create index idx_loan_contracts_status on loan_contracts(status);
create index idx_loan_requests_status on loan_requests(status);
create index idx_notifications_recipient on notifications_log(recipient_id, read_at);
create index idx_clients_referred_by on clients(referred_by_client_id);


-- ============================================================================
-- CORREÇÕES DA AUDITORIA TÉCNICA DE 2026-08-23 (migration_048)
--
-- Este bloco fecha os 4 achados CRÍTICOS e os demais achados de banco da
-- varredura completa do sistema. Ele vive no FIM do arquivo, depois das
-- definições originais, e as substitui — mesmo padrão já usado no bloco de
-- system_settings da seção 2.13. Rodar schema.sql de ponta a ponta numa
-- instalação nova produz exatamente o mesmo estado final da produção.
--
-- Ao editar qualquer função/policy definida ACIMA, confira se ela não é
-- redefinida aqui embaixo — senão a sua alteração é sobrescrita na hora do
-- fresh install e você vai debugar um comportamento que só acontece em
-- instalação nova.
-- ============================================================================

-- ============================================================================
-- 1. SEC-01 — tenant_id (e email/cpf) imutáveis em profiles
--
-- A policy "profiles_update_self" permite que a pessoa edite a própria linha
-- sem restringir coluna, e este gatilho só disparava em role/is_primary_admin/
-- active/platform_owner. tenant_id ficava livre — e como current_tenant_id()
-- lê exatamente essa coluna, alterá-la reescreve tudo o que a RLS entende por
-- "minha empresa": um PATCH e o administrador da Empresa A passa a ler a
-- carteira inteira da Empresa B.
--
-- email entra junto porque é o que email_for_cpf() devolve no login por CPF
-- (deve ser trocado só por api/update-user-email.js, que mantém auth.users em
-- sincronia); cpf entra porque é âncora de identidade e chave de login.
-- ============================================================================

create or replace function prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- `active` entrou aqui junto de role/is_primary_admin: sem essa checagem, um
  -- gerente desativado (sessão do navegador ainda válida — desativar não
  -- revoga o token) conseguia se REATIVAR sozinho com um PATCH direto em
  -- profiles (a policy profiles_update_self permite update na própria linha
  -- sem restringir coluna), recuperando acesso total.
  if (new.role is distinct from old.role
      or new.is_primary_admin is distinct from old.is_primary_admin
      or new.active is distinct from old.active)
     and not is_primary_admin()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: só o administrador primário pode alterar papel/privilégio/status de uma conta';
  end if;

  -- platform_owner (Fase 2, SaaS multi-empresa) é mais rígido que os 3
  -- campos acima: nem is_primary_admin() basta aqui — só service_role (uso
  -- interno/scripts administrativos), nunca uma sessão de usuário comum,
  -- senão o admin primário de QUALQUER tenant conseguiria se auto-promover
  -- a dono da plataforma inteira via REST direto.
  if new.platform_owner is distinct from old.platform_owner
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: platform_owner só pode ser alterado internamente';
  end if;

  -- SEC-01 (auditoria 2026-08-23): tenant_id é a coluna que current_tenant_id()
  -- lê pra resolver "minha empresa" em TODA policy de RLS do sistema. Trocá-la
  -- é equivalente a trocar de empresa — nem o admin primário pode, só
  -- service_role (api/create-user.js e api/create-tenant.js, onde o valor vem
  -- de um profile já autenticado no servidor).
  if new.tenant_id is distinct from old.tenant_id
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: a empresa de um usuário não pode ser alterada por aqui';
  end if;

  -- email/cpf: identidade de login. email precisa ficar em sincronia com
  -- auth.users (só api/update-user-email.js faz isso corretamente, via
  -- service_role); cpf é único na plataforma e resolve o login por CPF.
  -- update_client_profile()/update_gerente_profile()/complete_client_
  -- registration() são security definer e rodam como donas da tabela, então
  -- continuam podendo gravar normalmente sem esbarrar aqui.
  if (new.email is distinct from old.email or new.cpf is distinct from old.cpf)
     and not is_gerente()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: e-mail e CPF são alterados pelo administrador, não diretamente';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_profile_privilege_escalation on profiles;
create trigger trg_prevent_profile_privilege_escalation
  before update of role, is_primary_admin, active, platform_owner, tenant_id, email, cpf on profiles
  for each row execute function prevent_profile_privilege_escalation();


-- ============================================================================
-- 2. SEC-02 — WITH CHECK com filtro de empresa nas políticas de escrita
--
-- Seis políticas terminavam em `with check (is_gerente())`, sem comparar
-- tenant_id. O USING foi corrigido na Fase 1a/1c; o WITH CHECK (o que valida
-- a linha que está sendo GRAVADA) nunca foi — o próprio comentário do schema
-- registrava isso como pendente. Na prática permitia:
--   - inserir contrato/parcela/ciclo/pagamento na empresa alheia;
--   - MOVER uma linha própria pra outra empresa (o USING aprova, porque a
--     linha ainda é sua no momento da checagem);
--   - inserir cliente sem filtro nenhum;
--   - notificar QUALQUER usuário de QUALQUER empresa (o mais explorável).
--
-- Defesa em dupla camada: a policy passa a validar, e um gatilho BEFORE força
-- tenant_id a partir do perfil de quem grava — mesmo padrão que
-- trg_check_credit_limit_request() já usava corretamente em loan_requests.
-- ============================================================================

-- 2.1 Gatilho genérico: nunca confia no tenant_id que veio da requisição.
-- Chamadas com service_role (serverless /api, cron) não têm auth.uid(), então
-- current_tenant_id() volta null — nesse caso preserva o valor recebido, que
-- naquele caminho vem sempre de um profile já autenticado no servidor.
create or replace function trg_force_tenant_id()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is not null then
    new.tenant_id := v_tenant;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_force_tenant_clients on clients;
create trigger trg_force_tenant_clients
  before insert on clients
  for each row execute function trg_force_tenant_id();

drop trigger if exists trg_force_tenant_contracts on loan_contracts;
create trigger trg_force_tenant_contracts
  before insert on loan_contracts
  for each row execute function trg_force_tenant_id();

drop trigger if exists trg_force_tenant_installments on installments;
create trigger trg_force_tenant_installments
  before insert on installments
  for each row execute function trg_force_tenant_id();

drop trigger if exists trg_force_tenant_renewals on renewal_cycles;
create trigger trg_force_tenant_renewals
  before insert on renewal_cycles
  for each row execute function trg_force_tenant_id();

drop trigger if exists trg_force_tenant_payments on payments;
create trigger trg_force_tenant_payments
  before insert on payments
  for each row execute function trg_force_tenant_id();

-- 2.2 Gatilho que impede MOVER uma linha de negócio entre empresas.
-- O gatilho acima só cobre INSERT (um UPDATE não deve reescrever tenant_id
-- silenciosamente); aqui a regra é: uma vez gravada, a linha nunca troca de
-- empresa por uma sessão de usuário.
create or replace function trg_freeze_tenant_id()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: um registro não pode mudar de empresa';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_freeze_tenant_clients on clients;
create trigger trg_freeze_tenant_clients
  before update of tenant_id on clients
  for each row execute function trg_freeze_tenant_id();

drop trigger if exists trg_freeze_tenant_contracts on loan_contracts;
create trigger trg_freeze_tenant_contracts
  before update of tenant_id on loan_contracts
  for each row execute function trg_freeze_tenant_id();

drop trigger if exists trg_freeze_tenant_installments on installments;
create trigger trg_freeze_tenant_installments
  before update of tenant_id on installments
  for each row execute function trg_freeze_tenant_id();

drop trigger if exists trg_freeze_tenant_renewals on renewal_cycles;
create trigger trg_freeze_tenant_renewals
  before update of tenant_id on renewal_cycles
  for each row execute function trg_freeze_tenant_id();

drop trigger if exists trg_freeze_tenant_payments on payments;
create trigger trg_freeze_tenant_payments
  before update of tenant_id on payments
  for each row execute function trg_freeze_tenant_id();

drop trigger if exists trg_freeze_tenant_requests on loan_requests;
create trigger trg_freeze_tenant_requests
  before update of tenant_id on loan_requests
  for each row execute function trg_freeze_tenant_id();

-- 2.3 As políticas em si.

drop policy if exists "clients_gerente_write" on clients;
create policy "clients_gerente_write" on clients for insert
  with check (is_gerente() and tenant_id = current_tenant_id());

drop policy if exists "contracts_gerente_all" on loan_contracts;
create policy "contracts_gerente_all" on loan_contracts for all
  using (is_gerente() and tenant_id = current_tenant_id())
  with check (is_gerente() and tenant_id = current_tenant_id());

drop policy if exists "installments_gerente_write" on installments;
create policy "installments_gerente_write" on installments for all
  using (is_gerente() and tenant_id = current_tenant_id())
  with check (is_gerente() and tenant_id = current_tenant_id());

drop policy if exists "renewal_gerente_write" on renewal_cycles;
create policy "renewal_gerente_write" on renewal_cycles for all
  using (is_gerente() and tenant_id = current_tenant_id())
  with check (is_gerente() and tenant_id = current_tenant_id());

drop policy if exists "payments_gerente_write" on payments;
create policy "payments_gerente_write" on payments for all
  using (is_gerente() and tenant_id = current_tenant_id())
  with check (is_gerente() and tenant_id = current_tenant_id());

-- notifications_log: além do filtro de empresa, exige que o DESTINATÁRIO
-- pertença à mesma empresa. Sem isso, mesmo com tenant_id correto na linha,
-- um gerente conseguiria endereçar o aviso a um usuário de outra empresa.
drop policy if exists "notifications_gerente_insert" on notifications_log;
create policy "notifications_gerente_insert" on notifications_log for insert
  with check (
    is_gerente()
    and tenant_id = current_tenant_id()
    and exists (
      select 1 from profiles p
      where p.id = notifications_log.recipient_id
        and p.tenant_id = current_tenant_id()
    )
  );

-- planning_debts já exigia is_platform_owner() no USING; fecha o WITH CHECK
-- pelo mesmo motivo das demais (só existe uma pessoa com esse papel, então o
-- risco era baixo — mas a regra deve ser uniforme).
drop policy if exists "planning_debts_gerente_all" on planning_debts;
create policy "planning_debts_gerente_all" on planning_debts for all
  using (is_platform_owner() and tenant_id = current_tenant_id())
  with check (is_platform_owner() and tenant_id = current_tenant_id());


-- ============================================================================
-- 3. OPS-01 — refresh_overdue_status() religado
--
-- `(select loss_days_threshold from system_settings)` era uma subconsulta
-- ESCALAR sobre uma tabela que, desde que a PK virou tenant_id (migration_046)
-- e o gatilho after_tenant_created passou a criar uma linha por empresa,
-- retorna várias linhas. O Postgres aborta com "more than one row returned by
-- a subquery used as an expression" e, como é tudo uma transação só, TODA a
-- função reverte — inclusive os dois UPDATE de atraso, que sozinhos
-- funcionariam.
--
-- Efeito diário (silencioso, porque api/cron-daily-check.js não conferia o
-- retorno): parcelas nunca passavam a 'atrasada' no banco, perdas nunca eram
-- reconhecidas, status de contrato nunca sincronizava, score de inadimplente
-- nunca recalculava e o aviso de "parcela em atraso" nunca saía (depende de um
-- status que ninguém atualizava). A interface mascarava parte disso via
-- effectiveInstallmentStatus(), que recalcula o atraso na tela — por isso
-- passou despercebido enquanto os relatórios, que leem a coluna real, ficavam
-- errados.
--
-- Correção: subconsulta CORRELACIONADA com a empresa da própria linha. Cada
-- empresa passa a usar o próprio loss_days_threshold, que é o comportamento
-- que sempre foi pretendido.
-- ============================================================================

create or replace function refresh_overdue_status()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_client_id uuid;
  v_contract_id uuid;
begin
  update installments set status = 'atrasada'
    where status = 'pendente' and due_date < current_date;

  update renewal_cycles set status = 'atrasada'
    where status = 'pendente' and new_due_date < current_date;

  -- Perda automática — marca a PARCELA/CICLO específico que ultrapassou o
  -- prazo configurado (loss_days_threshold), não mais o contrato inteiro:
  -- outras parcelas do mesmo contrato continuam intocadas (decisão explícita
  -- do usuário, 2026-07-27 — "perda da parcela específica"). O valor
  -- perdido é o capital ainda não recuperado daquela parcela/ciclo. Isso
  -- roda ANTES da sincronização de status do contrato logo abaixo, pra um
  -- contrato cuja única pendência acabou de virar perda não ser promovido
  -- por engano pra 'em_aberto' (não existe mais 'atrasada' nele) em vez de
  -- corretamente fechar como 'perda'.
  --
  -- OPS-01: o limiar é lido da linha de system_settings DA EMPRESA da própria
  -- parcela (i.tenant_id), nunca da tabela inteira. coalesce(...,60) mantém o
  -- default do schema caso alguma empresa fique sem linha de configuração.
  update installments i set
    status = 'perda',
    principal_lost = greatest(0, i.principal_share - i.principal_paid_partial),
    loss_recognized_at = now()
  where i.status = 'atrasada'
    and i.due_date < current_date - coalesce(
      (select s.loss_days_threshold from system_settings s where s.tenant_id = i.tenant_id),
      60
    );

  update renewal_cycles rc set
    status = 'perda',
    principal_lost = coalesce((select lc.principal_amount from loan_contracts lc where lc.id = rc.contract_id), 0),
    loss_recognized_at = now()
  where rc.status = 'atrasada'
    and rc.new_due_date < current_date - coalesce(
      (select s.loss_days_threshold from system_settings s where s.tenant_id = rc.tenant_id),
      60
    );

  -- Sincroniza o status de cada contrato ainda aberto a partir do estado
  -- real das suas parcelas/ciclos (em_aberto/atrasado/quitado/perda).
  for v_contract_id in select id from loan_contracts where status in ('em_aberto', 'atrasado')
  loop
    perform recompute_contract_status(v_contract_id);
  end loop;

  -- Recalcula o score de todo cliente com contrato atrasado ou em perda, para
  -- o score refletir o estado atual mesmo sem nenhum recebimento novo (senão
  -- o score de um cliente inadimplente que não interage mais fica parado).
  for v_client_id in
    select distinct client_id from loan_contracts where status in ('atrasado', 'perda')
  loop
    perform recalculate_client_score(v_client_id);
  end loop;
end;
$$;


-- ============================================================================
-- 4. OPS-03 — policy de UPDATE em push_subscriptions
--
-- js/push.js faz upsert(..., { onConflict: 'endpoint' }), que no Postgres vira
-- INSERT ... ON CONFLICT DO UPDATE. O caminho de UPDATE exige policy de
-- UPDATE, e a tabela só tinha SELECT/INSERT/DELETE. Resultado: o primeiro
-- registro do aparelho funcionava e TODO login seguinte era barrado pela RLS
-- — erro engolido pelo catch de push.js, que só escrevia "Push não disponível"
-- no console. Na prática o push parava de se re-registrar sem ninguém saber.
--
-- O USING olha a linha ANTIGA (dona anterior do endpoint) e o WITH CHECK a
-- nova: em aparelho compartilhado, quem assume o endpoint precisa poder
-- gravar a própria linha. Por isso o USING aceita qualquer dono anterior —
-- o endpoint é único por navegador/aparelho, então reivindicá-lo é o
-- comportamento correto de reatribuição.
-- ============================================================================

drop policy if exists "push_update_own" on push_subscriptions;
create policy "push_update_own" on push_subscriptions for update
  using (true)
  with check (profile_id = auth.uid());


-- ============================================================================
-- 5. SEC-03 — log_audit_event() endurecido
--
-- A função é security definer e NÃO verifica autorização — o que é
-- intencional: o registro de "login falhou" precisa acontecer antes de existir
-- sessão. Mas isso significava que qualquer pessoa na internet podia gravar
-- linhas em audit_log com action/description/metadata à escolha dela.
--
-- Combinado com o `value="${a}"` sem escape em gerente-auditoria.js (corrigido
-- no frontend nesta mesma rodada), virava XSS armazenado no navegador do
-- Administrador Master. Aqui fechamos a ORIGEM:
--   - `action` sem sessão fica restrito às 2 ações que realmente precisam ser
--     registradas antes do login (login_falho, login_sucesso);
--   - textos ganham teto de tamanho (evita inundar a tabela por linha);
--   - metadata sem sessão é descartada (não há motivo pra um anônimo escolher
--     o conteúdo de um jsonb que o admin vai ler).
-- ============================================================================

create or replace function log_audit_event(
  p_action text,
  p_description text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_actor_role text;
  v_tenant_id uuid;
  v_action text;
  v_description text;
  v_metadata jsonb;
begin
  -- SEC-03: `action` alimenta um <option value> na tela Auditoria e um mapa de
  -- rótulos — precisa ser um identificador simples, nunca texto livre.
  v_action := substring(coalesce(p_action, '') from 1 for 60);
  if v_action !~ '^[a-z0-9_]+$' then
    raise exception 'INVALID_ACTION';
  end if;

  v_description := substring(coalesce(p_description, '') from 1 for 500);

  if v_actor_id is not null then
    select full_name, role::text, tenant_id into v_actor_name, v_actor_role, v_tenant_id from profiles where id = v_actor_id;
    v_metadata := coalesce(p_metadata, '{}'::jsonb);
  else
    -- Sem sessão: só os eventos do próprio fluxo de login, e sem metadata
    -- escolhida por quem chama.
    if v_action not in ('login_falho', 'login_sucesso') then
      raise exception 'FORBIDDEN';
    end if;
    v_metadata := '{}'::jsonb;
  end if;

  -- tenant_id fica NULL quando não há sessão (ex: tentativa de login falha,
  -- onde v_actor_id já é null e não há profile pra resolver tenant nenhum) —
  -- mesmo design nullable de audit_log já decidido na Fase 1a.
  insert into audit_log (actor_id, actor_name, actor_role, action, description, metadata, tenant_id)
  values (v_actor_id, coalesce(v_actor_name, 'Anônimo'), v_actor_role, v_action, v_description, v_metadata, v_tenant_id);

  -- Retenção: mantém só os 500 eventos mais recentes POR TENANT.
  -- `is not distinct from` trata NULL corretamente (eventos sem tenant são
  -- podados entre si, à parte).
  delete from audit_log where tenant_id is not distinct from v_tenant_id and id in (
    select id from audit_log where tenant_id is not distinct from v_tenant_id order by created_at desc offset 500
  );
end;
$$;


-- ============================================================================
-- 6. UX-18 — notificações com número do contrato e valor formatado
--
-- As mensagens gravadas pelas RPCs mostravam o UUID do contrato e o número
-- cru do Postgres: "Seu contrato #a3f9c8e2-4b1d-… no valor de R$ 1000.00".
-- Agora usam contract_number (5 dígitos, o mesmo que aparece em toda tela) e
-- formatação brasileira.
-- ============================================================================

-- Formata numeric como moeda brasileira ("1234.5" -> "R$ 1.234,50").
-- to_char com o locale do servidor não é confiável (depende de lc_numeric),
-- então a máscara 'FM999G999G999D00' é aplicada e os separadores trocados
-- explicitamente: o Postgres emite ',' como agrupador e '.' como decimal no
-- locale padrão C, que é exatamente o inverso do português.
create or replace function fmt_brl(p_value numeric)
returns text
language sql immutable
as $$
  select 'R$ ' || translate(to_char(coalesce(p_value, 0), 'FM999G999G999G999D00'), ',.', '.,');
$$;

create or replace function create_loan_contract(
  p_client_id uuid,
  p_principal_amount numeric,
  p_interest_rate numeric,
  p_installments_count integer,
  p_due_type due_type,
  p_contract_date date,
  p_first_installment_date date,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_allows_renewal boolean,
  p_late_fee_percent numeric,
  p_late_interest_percent numeric,
  p_observations text,
  p_origin_request_id uuid default null,
  p_installments_override jsonb default null,
  p_custom_interval_days integer default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_contract_id uuid;
  v_contract_number integer;
  v_row jsonb;
  v_principal_sum numeric;
  v_override_count integer;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN: apenas gerentes podem criar contratos';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c: cliente precisa pertencer ao mesmo tenant de quem cria o
  -- contrato — sem isso, uma chamada direta à RPC (fora do fluxo normal do
  -- app, que já só deixa escolher clientes do próprio tenant) conseguia
  -- criar um contrato em nome de cliente de OUTRO tenant.
  if not exists (select 1 from clients where profile_id = p_client_id and tenant_id = v_tenant_id) then
    raise exception 'FORBIDDEN: cliente não pertence ao seu tenant';
  end if;

  -- Auditoria 2026-08-23: a RPC nunca validou faixa de taxa nem coerência de
  -- datas. Um erro de digitação (300% em vez de 3%) entrava calado e só
  -- aparecia meses depois no extrato do cliente.
  if p_interest_rate < 0 or p_interest_rate > 1000 then
    raise exception 'INVALID_INTEREST_RATE';
  end if;
  if p_first_installment_date < p_contract_date then
    raise exception 'INVALID_DATE_ORDER';
  end if;
  if p_installments_count < 1 or p_installments_count > 360 then
    raise exception 'INVALID_INSTALLMENTS_COUNT';
  end if;

  insert into loan_contracts (
    client_id, created_by, origin_request_id, tenant_id,
    principal_amount, interest_rate, installments_count, due_type, custom_interval_days,
    has_operational_fee, operational_fee_amount,
    contract_date, first_installment_date,
    allows_renewal, late_fee_percent, late_interest_percent, observations
  ) values (
    p_client_id, auth.uid(), p_origin_request_id, v_tenant_id,
    p_principal_amount, p_interest_rate, p_installments_count, p_due_type, p_custom_interval_days,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0),
    p_contract_date, p_first_installment_date,
    p_allows_renewal, coalesce(p_late_fee_percent, 0), coalesce(p_late_interest_percent, 0), p_observations
  ) returning id, contract_number into v_contract_id, v_contract_number;

  if p_installments_override is not null then
    select jsonb_array_length(p_installments_override) into v_override_count;
    -- A contagem declarada no contrato precisa bater com o que foi de fato
    -- gravado — senão installments_count vira um número decorativo e a regra
    -- "renovação só em contrato de parcela única" passa a olhar dado errado.
    if v_override_count <> p_installments_count then
      raise exception 'INSTALLMENTS_COUNT_MISMATCH';
    end if;
    for v_row in select * from jsonb_array_elements(p_installments_override) loop
      -- Defesa em profundidade: o wizard já trava capital/juros negativos no
      -- JS, mas a RPC é pública (security definer) e não deveria confiar só
      -- na UI pra isso — parcela com juros negativo apareceria como lucro
      -- negativo mais tarde, sem nenhum aviso.
      if (v_row->>'principal_share')::numeric < 0 or (v_row->>'interest_share')::numeric < 0 then
        raise exception 'INVALID_AMOUNT';
      end if;
      insert into installments (contract_id, sequence_number, due_date, principal_share, interest_share, tenant_id)
      values (
        v_contract_id,
        (v_row->>'sequence_number')::integer,
        (v_row->>'due_date')::date,
        (v_row->>'principal_share')::numeric,
        (v_row->>'interest_share')::numeric,
        v_tenant_id
      );
    end loop;
  else
    insert into installments (contract_id, sequence_number, due_date, principal_share, interest_share, tenant_id)
    select v_contract_id, sequence_number, due_date, principal_share, interest_share, v_tenant_id
    from calc_installments_preview(p_principal_amount, p_interest_rate, p_installments_count, p_due_type, p_first_installment_date, p_custom_interval_days);
  end if;

  -- Reconciliação: a soma do capital das parcelas geradas/editadas precisa
  -- bater com o capital do contrato (dentro de uma tolerância de centavos).
  select coalesce(sum(principal_share), 0) into v_principal_sum from installments where contract_id = v_contract_id;
  if abs(v_principal_sum - p_principal_amount) > greatest(0.02 * p_installments_count, 0.02) then
    raise exception 'PRINCIPAL_MISMATCH';
  end if;

  if p_origin_request_id is not null then
    update loan_requests
      set status = 'aprovada', resulting_contract_id = v_contract_id,
          decided_by = auth.uid(), decided_at = now()
      where id = p_origin_request_id and tenant_id = v_tenant_id and client_id = p_client_id;
  end if;

  -- UX-18: número do contrato (5 dígitos) e valor formatado, não o UUID.
  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (
    p_client_id, 'contrato_criado', 'in_app', v_contract_id,
    'Novo contrato criado',
    'Seu contrato #' || v_contract_number || ' no valor de ' || fmt_brl(p_principal_amount) || ' foi criado.',
    v_tenant_id
  );

  return v_contract_id;
end;
$$;


-- ============================================================================
-- 7. OPS-08 — numeração de contrato por empresa, sem laço infinito
--
-- generate_contract_number() sorteava 5 dígitos (90.000 valores possíveis) e
-- repetia até achar um livre, com unicidade GLOBAL entre todas as empresas.
-- Dois problemas: o laço degrada conforme o espaço enche e NUNCA TERMINA
-- quando esgotar (trava a transação); e cada empresa esperaria a própria
-- sequência, não um número compartilhado com as concorrentes.
--
-- Agora a unicidade é (tenant_id, contract_number) e a numeração é sequencial
-- por empresa a partir de 10000 — determinística, sem sorteio, sem laço.
-- ============================================================================

alter table loan_contracts drop constraint if exists loan_contracts_contract_number_key;
create unique index if not exists loan_contracts_tenant_number_uidx
  on loan_contracts(tenant_id, contract_number);

drop function if exists generate_contract_number();

create or replace function set_contract_number()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_next integer;
begin
  if new.contract_number is null then
    -- Sequencial por empresa. O lock explícito serializa duas criações
    -- concorrentes na MESMA empresa (sem ele, as duas leriam o mesmo max e a
    -- segunda quebraria no índice único); empresas diferentes não se
    -- bloqueiam, porque a chave do advisory lock inclui o tenant.
    perform pg_advisory_xact_lock(hashtext('contract_number:' || new.tenant_id::text));
    select coalesce(max(contract_number), 9999) + 1 into v_next
      from loan_contracts where tenant_id = new.tenant_id;
    new.contract_number := v_next;
  end if;
  return new;
end;
$$;

-- O gatilho precisa rodar DEPOIS de trg_force_tenant_id (que resolve
-- new.tenant_id), e os gatilhos BEFORE de um mesmo evento disparam em ordem
-- alfabética de nome. "trg_force_tenant_contracts" < "trg_set_contract_number"
-- garante a ordem correta; o nome antigo (before_insert_contract_number)
-- viria antes de "trg_*" e leria tenant_id ainda nulo.
drop trigger if exists before_insert_contract_number on loan_contracts;
drop trigger if exists trg_set_contract_number on loan_contracts;
create trigger trg_set_contract_number
  before insert on loan_contracts
  for each row execute function set_contract_number();


-- ============================================================================
-- 8. FIN-04 — data de pagamento com limite inferior
--
-- O campo tinha `max` no HTML (não aceita futuro) mas nenhum `min`, e as RPCs
-- não validavam nada. Um pagamento podia ser lançado com data de anos atrás,
-- movendo receita entre meses já fechados sem trava nem registro do ajuste.
-- Teto de retroatividade: 365 dias. Futuro continua proibido.
-- ============================================================================

create or replace function assert_received_at_valid(p_received_at date)
returns void
-- `stable`, nunca `immutable`: a função lê current_date, que muda entre
-- transações. Marcar como immutable autorizaria o planejador a avaliar a
-- chamada uma vez e reaproveitar o resultado — o que faria o limite de
-- retroatividade "congelar" num dia antigo.
language plpgsql stable
as $$
begin
  if p_received_at is null then
    return;
  end if;
  if p_received_at > current_date then
    raise exception 'RECEIVED_AT_IN_FUTURE';
  end if;
  if p_received_at < current_date - 365 then
    raise exception 'RECEIVED_AT_TOO_OLD';
  end if;
end;
$$;

create or replace function receive_payment(
  p_installment_id uuid,
  p_amount_received numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_notes text default null,
  p_late_charge_amount numeric default 0,
  p_received_at date default current_date
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_installment installments%rowtype;
  v_contract loan_contracts%rowtype;
  v_payment_id uuid;
  v_remaining_interest numeric;
  v_remaining_principal numeric;
  v_remaining_total numeric;
  v_max_allowed numeric;
  v_pay_interest numeric;
  v_pay_principal numeric;
  v_pay_late numeric;
  v_after_interest numeric;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  perform assert_received_at_valid(p_received_at);

  v_tenant_id := current_tenant_id();

  -- Fase 1c: sem o filtro de tenant_id abaixo, um gerente de outra empresa
  -- podia informar o id de uma parcela de QUALQUER tenant e registrar um
  -- pagamento contra ela — grava dinheiro no lugar errado.
  select * into v_installment from installments where id = p_installment_id and tenant_id = v_tenant_id for update;
  if v_installment.id is null then
    raise exception 'NOT_FOUND';
  end if;
  if v_installment.status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  v_remaining_interest := v_installment.interest_share - v_installment.interest_paid_partial;
  v_remaining_principal := v_installment.principal_share - v_installment.principal_paid_partial;
  v_remaining_total := v_remaining_interest + v_remaining_principal;
  v_max_allowed := v_remaining_total + coalesce(p_late_charge_amount, 0);

  if p_amount_received <= 0 or p_amount_received > v_max_allowed + 0.01 then
    raise exception 'INVALID_AMOUNT';
  end if;

  select * into v_contract from loan_contracts where id = v_installment.contract_id for update;

  v_pay_interest := least(p_amount_received, v_remaining_interest);
  v_after_interest := p_amount_received - v_pay_interest;
  v_pay_principal := least(v_after_interest, v_remaining_principal);
  v_pay_late := v_after_interest - v_pay_principal;

  insert into payments (
    contract_id, installment_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract.id, p_installment_id, 'quitacao_parcela', p_amount_received,
    v_pay_principal, v_pay_interest + v_pay_late, v_pay_late,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date), v_tenant_id
  ) returning id into v_payment_id;

  update installments set
    principal_paid_partial = principal_paid_partial + v_pay_principal,
    interest_paid_partial = interest_paid_partial + v_pay_interest
  where id = p_installment_id;

  if v_remaining_total - p_amount_received <= 0.01 then
    update installments set status = 'paga', paid_at = coalesce(p_received_at, current_date) where id = p_installment_id;
    perform recompute_contract_status(v_contract.id);

    insert into notifications_log (recipient_id, event, channel, related_contract_id, related_installment_id, title, body, tenant_id)
    values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id, p_installment_id,
            'Pagamento recebido',
            'Recebemos seu pagamento de ' || fmt_brl(p_amount_received) || ' no contrato #' || v_contract.contract_number || '.', v_tenant_id);
  else
    insert into notifications_log (recipient_id, event, channel, related_contract_id, related_installment_id, title, body, tenant_id)
    values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id, p_installment_id,
            'Pagamento parcial recebido',
            'Recebemos ' || fmt_brl(p_amount_received) || '. Restam ' || fmt_brl(round(v_remaining_total - p_amount_received, 2)) || ' desta parcela.', v_tenant_id);
  end if;

  return v_payment_id;
end;
$$;

create or replace function receive_cycle_payment(
  p_cycle_id uuid,
  p_amount_received numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_notes text default null,
  p_late_charge_amount numeric default 0,
  p_received_at date default current_date
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_cycle renewal_cycles%rowtype;
  v_contract loan_contracts%rowtype;
  v_principal numeric;
  v_interest numeric;
  v_full_amount_due numeric;
  v_payment_id uuid;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  perform assert_received_at_valid(p_received_at);

  v_tenant_id := current_tenant_id();

  select * into v_cycle from renewal_cycles where id = p_cycle_id and tenant_id = v_tenant_id for update;
  if v_cycle.id is null then
    raise exception 'NOT_FOUND';
  end if;
  if v_cycle.status not in ('pendente', 'atrasada') then
    raise exception 'CYCLE_NOT_PAYABLE';
  end if;

  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  v_full_amount_due := v_cycle.full_debt_amount + coalesce(p_late_charge_amount, 0);
  if p_amount_received <= 0 or abs(p_amount_received - v_full_amount_due) > 0.01 then
    raise exception 'INVALID_AMOUNT';
  end if;

  select * into v_contract from loan_contracts where id = v_cycle.contract_id for update;
  v_principal := v_contract.principal_amount;
  v_interest := v_cycle.full_debt_amount - v_principal;

  insert into payments (
    contract_id, renewal_cycle_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract.id, p_cycle_id, 'quitacao_final', p_amount_received,
    v_principal, v_interest + coalesce(p_late_charge_amount, 0), coalesce(p_late_charge_amount, 0),
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date), v_tenant_id
  ) returning id into v_payment_id;

  update renewal_cycles set status = 'paga', paid_at = coalesce(p_received_at, current_date) where id = p_cycle_id;
  perform recompute_contract_status(v_contract.id);

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id,
          'Pagamento recebido',
          'Recebemos seu pagamento de ' || fmt_brl(p_amount_received) || '. Contrato #' || v_contract.contract_number || ' quitado.', v_tenant_id);

  return v_payment_id;
end;
$$;

create or replace function renew_installment(
  p_source_type request_source,
  p_source_id uuid,
  p_interest_only_amount numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_notes text default null,
  p_late_charge_amount numeric default 0,
  p_received_at date default current_date,
  p_new_due_date date default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_contract_id uuid;
  v_contract_number integer;
  v_due_type due_type;
  v_custom_days integer;
  v_principal numeric;
  v_interest numeric;
  v_full_debt numeric;
  v_new_due_date date;
  v_cycle_number integer;
  v_new_cycle_id uuid;
  v_payment_id uuid;
  v_client_id uuid;
  v_step interval;
  v_status installment_status;
  v_installments_count integer;
  v_allows_renewal boolean;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  perform assert_received_at_valid(p_received_at);

  v_tenant_id := current_tenant_id();

  if p_interest_only_amount < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if p_source_type = 'installment' then
    select i.contract_id,
           greatest(0, i.principal_share - i.principal_paid_partial),
           greatest(0, i.interest_share - i.interest_paid_partial),
           i.status
      into v_contract_id, v_principal, v_interest, v_status
      from installments i where i.id = p_source_id and i.tenant_id = v_tenant_id for update;
  else
    select rc.contract_id, rc.status, rc.full_debt_amount
      into v_contract_id, v_status, v_full_debt
      from renewal_cycles rc where rc.id = p_source_id and rc.tenant_id = v_tenant_id for update;
    v_principal := 0;
    v_interest := v_full_debt;
  end if;

  if v_contract_id is null then
    raise exception 'NOT_FOUND';
  end if;

  -- defesa contra corrida: duplo-clique ou dois gerentes renovando a mesma
  -- parcela/ciclo quase simultaneamente.
  if v_status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  select lc.due_type, lc.client_id, lc.custom_interval_days, lc.installments_count, lc.allows_renewal, lc.contract_number
    into v_due_type, v_client_id, v_custom_days, v_installments_count, v_allows_renewal, v_contract_number
    from loan_contracts lc where lc.id = v_contract_id for update;

  -- Renovação só é permitida em contratos de parcela única com o flag
  -- habilitado.
  if v_installments_count <> 1 or not coalesce(v_allows_renewal, false) then
    raise exception 'RENEWAL_NOT_ALLOWED';
  end if;

  v_full_debt := coalesce(v_full_debt, v_principal + v_interest);

  v_step := case v_due_type
    when 'mensal' then interval '1 month'
    when 'quinzenal' then interval '15 days'
    when 'semanal' then interval '7 days'
    when 'personalizado' then (coalesce(v_custom_days, 30) || ' days')::interval
  end;
  v_new_due_date := coalesce(p_new_due_date, coalesce(p_received_at, current_date) + v_step);

  -- Auditoria 2026-08-23: renovar pra uma data já vencida criava um ciclo que
  -- nascia atrasado, sem nenhum aviso.
  if v_new_due_date <= coalesce(p_received_at, current_date) then
    raise exception 'NEW_DUE_DATE_NOT_FUTURE';
  end if;

  select coalesce(max(cycle_number), 0) + 1 into v_cycle_number
    from renewal_cycles where contract_id = v_contract_id;

  insert into renewal_cycles (
    contract_id, cycle_number, origin_installment_id, previous_cycle_id,
    interest_only_amount, full_debt_amount, new_due_date, created_by, tenant_id
  ) values (
    v_contract_id, v_cycle_number,
    case when p_source_type = 'installment' then p_source_id else null end,
    case when p_source_type = 'renewal_cycle' then p_source_id else null end,
    p_interest_only_amount, v_full_debt, v_new_due_date, auth.uid(), v_tenant_id
  ) returning id into v_new_cycle_id;

  if p_source_type = 'installment' then
    update installments set status = 'renovada', renewed_into_cycle_id = v_new_cycle_id where id = p_source_id;
  else
    update renewal_cycles set status = 'renovada' where id = p_source_id;
  end if;

  insert into payments (
    contract_id, renewal_cycle_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract_id, v_new_cycle_id, 'renovacao_juros', p_interest_only_amount + coalesce(p_late_charge_amount, 0),
    0, p_interest_only_amount + coalesce(p_late_charge_amount, 0), coalesce(p_late_charge_amount, 0),
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date), v_tenant_id
  ) returning id into v_payment_id;

  update loan_contracts set status = 'em_aberto', updated_at = now()
    where id = v_contract_id and status in ('em_aberto', 'atrasado', 'perda');

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (v_client_id, 'renovacao_registrada', 'in_app', v_contract_id,
          'Renovação registrada',
          'Sua dívida do contrato #' || v_contract_number || ' foi renovada. Novo vencimento: ' ||
          to_char(v_new_due_date, 'DD/MM/YYYY') || '.', v_tenant_id);

  return v_new_cycle_id;
end;
$$;


-- ============================================================================
-- 9. FIN-01 — agregação no banco, não no navegador
--
-- O PostgREST corta a resposta em 1.000 linhas por padrão. Dashboard e
-- Relatórios buscavam as linhas cruas e somavam no JavaScript — passando de
-- 1.000 pagamentos no período, o total simplesmente parava de crescer, sem
-- erro e sem aviso. Um relatório que trava em zero levanta suspeita; um que
-- mostra R$ 180 mil quando o correto é R$ 240 mil, não.
--
-- Estas RPCs somam no Postgres (sem teto de linhas) e devolvem um jsonb
-- pequeno. Todas filtram por current_tenant_id() e exigem gerente.
-- ============================================================================

-- Totais financeiros de um período. `p_start` inclusivo, `p_end` EXCLUSIVO
-- (mesma convenção de periodoRange() em gerente-relatorios.js).
create or replace function financial_totals(p_start date, p_end date)
returns jsonb
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_result jsonb;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();

  select jsonb_build_object(
    'recebido', coalesce((
      select sum(amount_received) from payments
      where tenant_id = v_tenant and received_at >= p_start and received_at < p_end
    ), 0),
    'lucro_bruto', coalesce((
      select sum(interest_component) from payments
      where tenant_id = v_tenant and received_at >= p_start and received_at < p_end
    ), 0),
    -- Capital que VOLTOU pro caixa no período (parte principal dos
    -- recebimentos) — é o "Retornado" da tabela de Lucro Analítico.
    'retorno', coalesce((
      select sum(principal_component) from payments
      where tenant_id = v_tenant and received_at >= p_start and received_at < p_end
    ), 0),
    -- Total desembolsado: capital emprestado + taxa de saída (coluna gerada
    -- total_disbursed_amount). É o "Aporte" do Fluxo de Caixa.
    'aporte', coalesce((
      select sum(total_disbursed_amount) from loan_contracts
      where tenant_id = v_tenant and contract_date >= p_start and contract_date < p_end
    ), 0),
    'net_profit', coalesce((
      select sum(net_profit) from payments
      where tenant_id = v_tenant and received_at >= p_start and received_at < p_end
    ), 0),
    'taxa_entrada', coalesce((
      select sum(operational_fee_amount) from payments
      where tenant_id = v_tenant and has_operational_fee
        and received_at >= p_start and received_at < p_end
    ), 0),
    'taxa_saida', coalesce((
      select sum(operational_fee_amount) from loan_contracts
      where tenant_id = v_tenant and has_operational_fee
        and contract_date >= p_start and contract_date < p_end
    ), 0),
    'capital_emprestado', coalesce((
      select sum(principal_amount) from loan_contracts
      where tenant_id = v_tenant and contract_date >= p_start and contract_date < p_end
    ), 0),
    'contratos_novos', coalesce((
      select count(*) from loan_contracts
      where tenant_id = v_tenant and contract_date >= p_start and contract_date < p_end
    ), 0),
    'perda', coalesce((
      select sum(principal_lost) from installments
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= p_start and loss_recognized_at < p_end
    ), 0) + coalesce((
      select sum(principal_lost) from renewal_cycles
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= p_start and loss_recognized_at < p_end
    ), 0),
    'pagamentos_count', coalesce((
      select count(*) from payments
      where tenant_id = v_tenant and received_at >= p_start and received_at < p_end
    ), 0)
  ) into v_result;

  return v_result;
end;
$$;

-- Série temporal agregada (por dia ou por mês) — alimenta os gráficos sem
-- trazer uma linha por pagamento pro navegador.
create or replace function financial_series(p_start date, p_end date, p_bucket text)
returns table (
  bucket text,
  recebido numeric,
  lucro numeric,
  retorno numeric,
  juros numeric,
  taxa_entrada numeric,
  taxa_saida numeric,
  aporte numeric,
  perda numeric
)
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_fmt text;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();
  v_fmt := case when p_bucket = 'mes' then 'YYYY-MM' else 'YYYY-MM-DD' end;

  -- União de todas as fontes num só conjunto de colunas e um GROUP BY
  -- final. Um FULL OUTER JOIN em três lados exigiria coalesce aninhado na
  -- condição de junção e erra silenciosamente quando um período existe só
  -- na terceira fonte — a união não tem esse problema.
  return query
  select x.b::text,
         sum(x.recebido)::numeric,
         sum(x.lucro)::numeric,
         sum(x.retorno)::numeric,
         sum(x.juros)::numeric,
         sum(x.taxa_entrada)::numeric,
         sum(x.taxa_saida)::numeric,
         sum(x.aporte)::numeric,
         sum(x.perda)::numeric
  from (
    -- Pagamentos: entrada de caixa, lucro líquido, capital retornado, juros
    -- brutos e a taxa de ENTRADA efetivamente cobrada.
    select to_char(received_at, v_fmt) as b,
           amount_received as recebido,
           net_profit as lucro,
           principal_component as retorno,
           interest_component as juros,
           case when has_operational_fee then operational_fee_amount else 0 end as taxa_entrada,
           0::numeric as taxa_saida,
           0::numeric as aporte,
           0::numeric as perda
    from payments
    where tenant_id = v_tenant and received_at >= p_start and received_at < p_end

    -- Contratos: saída de caixa (aporte) e a taxa de SAÍDA.
    union all
    select to_char(contract_date, v_fmt), 0, 0, 0, 0, 0,
           case when has_operational_fee then operational_fee_amount else 0 end,
           total_disbursed_amount, 0
    from loan_contracts
    where tenant_id = v_tenant and contract_date >= p_start and contract_date < p_end

    -- Perdas reconhecidas no período (parcelas e ciclos).
    union all
    select to_char(loss_recognized_at, v_fmt), 0, 0, 0, 0, 0, 0, 0, principal_lost
    from installments
    where tenant_id = v_tenant and status = 'perda'
      and loss_recognized_at >= p_start and loss_recognized_at < p_end

    union all
    select to_char(loss_recognized_at, v_fmt), 0, 0, 0, 0, 0, 0, 0, principal_lost
    from renewal_cycles
    where tenant_id = v_tenant and status = 'perda'
      and loss_recognized_at >= p_start and loss_recognized_at < p_end
  ) x
  group by x.b
  order by 1;
end;
$$;

-- Números do topo do Dashboard, todos somados no banco.
create or replace function dashboard_totals()
returns jsonb
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_today date := current_date;
  v_month_start date := date_trunc('month', current_date)::date;
  v_prev_start date := date_trunc('month', current_date - interval '1 month')::date;
  v_prev_end date;
  v_result jsonb;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();
  -- Mesmo período comparável do mês anterior (dia 1 até o mesmo dia-do-mês).
  v_prev_end := least(
    v_prev_start + (v_today - v_month_start),
    (date_trunc('month', v_prev_start) + interval '1 month')::date - 1
  );

  -- Todas as janelas são semiabertas ([início, fim+1)) porque received_at e
  -- loss_recognized_at são timestamptz: comparar `<= data` só alcançaria a
  -- meia-noite exata do último dia e perderia qualquer registro gravado com
  -- hora real dentro dele.
  select jsonb_build_object(
    'recebido_hoje', coalesce((select sum(amount_received) from payments
      where tenant_id = v_tenant and received_at >= v_today and received_at < v_today + 1), 0),
    'recebido_mes', coalesce((select sum(amount_received) from payments
      where tenant_id = v_tenant and received_at >= v_month_start and received_at < v_today + 1), 0),
    'lucro_mes', coalesce((select sum(net_profit) from payments
      where tenant_id = v_tenant and received_at >= v_month_start and received_at < v_today + 1), 0),
    'lucro_prev', coalesce((select sum(net_profit) from payments
      where tenant_id = v_tenant and received_at >= v_prev_start and received_at < v_prev_end + 1), 0),
    'taxa_entrada_mes', coalesce((select sum(operational_fee_amount) from payments
      where tenant_id = v_tenant and has_operational_fee
        and received_at >= v_month_start and received_at < v_today + 1), 0),
    'taxa_saida_mes', coalesce((select sum(operational_fee_amount) from loan_contracts
      where tenant_id = v_tenant and has_operational_fee
        and contract_date >= v_month_start and contract_date <= v_today), 0),
    'taxa_saida_prev', coalesce((select sum(operational_fee_amount) from loan_contracts
      where tenant_id = v_tenant and has_operational_fee
        and contract_date >= v_prev_start and contract_date <= v_prev_end), 0),
    'perda_mes', coalesce((select sum(principal_lost) from installments
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= v_month_start and loss_recognized_at < v_today + 1), 0)
      + coalesce((select sum(principal_lost) from renewal_cycles
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= v_month_start and loss_recognized_at < v_today + 1), 0),
    'perda_prev', coalesce((select sum(principal_lost) from installments
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= v_prev_start and loss_recognized_at < v_prev_end + 1), 0)
      + coalesce((select sum(principal_lost) from renewal_cycles
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= v_prev_start and loss_recognized_at < v_prev_end + 1), 0),
    'contratos_em_aberto', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and status = 'em_aberto'), 0),
    'contratos_atrasado', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and status = 'atrasado'), 0),
    'contratos_quitado', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and status = 'quitado'), 0),
    'contratos_perda', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and status = 'perda'), 0),
    'contratos_novos_mes', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and contract_date >= v_month_start and contract_date <= v_today), 0),
    'capital_na_rua', coalesce((select sum(principal_amount) from loan_contracts
      where tenant_id = v_tenant and status in ('em_aberto', 'atrasado')), 0),
    'a_receber_mes', coalesce((select sum(amount_due - principal_paid_partial - interest_paid_partial)
      from installments
      where tenant_id = v_tenant and status in ('pendente', 'atrasada')
        and due_date >= v_month_start and due_date < v_month_start + interval '1 month'), 0)
      + coalesce((select sum(full_debt_amount) from renewal_cycles
      where tenant_id = v_tenant and status in ('pendente', 'atrasada')
        and new_due_date >= v_month_start and new_due_date < v_month_start + interval '1 month'), 0),
    'vencidos_count', coalesce((select count(*) from installments
      where tenant_id = v_tenant and status in ('pendente', 'atrasada') and due_date <= v_today), 0)
      + coalesce((select count(*) from renewal_cycles
      where tenant_id = v_tenant and status in ('pendente', 'atrasada') and new_due_date <= v_today), 0),
    'solicitacoes_pendentes', coalesce((select count(*) from loan_requests
      where tenant_id = v_tenant and status = 'pendente'), 0)
  ) into v_result;

  return v_result;
end;
$$;

-- Série dos últimos N dias de recebimento (gráfico de tendência do Dashboard).
create or replace function dashboard_trend(p_days integer default 30)
returns table (dia date, recebido numeric)
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();
  return query
  select d::date,
         coalesce((select sum(p.amount_received) from payments p
                   where p.tenant_id = v_tenant
                     and p.received_at >= d::date
                     and p.received_at < d::date + 1), 0)::numeric
  from generate_series(current_date - (greatest(p_days, 1) - 1), current_date, interval '1 day') d
  order by 1;
end;
$$;


-- ============================================================================
-- 10. OPS-01b / OPS-02 — registro de execução das rotinas + tela "Saúde"
--
-- A rotina diária falhava em silêncio: api/cron-daily-check.js chamava a RPC
-- com `await` solto, sem conferir o resultado. Agora cada tarefa do cron
-- registra o próprio desfecho aqui, e a tela "Saúde da Plataforma" (nova, modo
-- Plataforma SaaS) mostra quando cada uma rodou pela última vez e o que
-- aconteceu. O silêncio vira sinal.
-- ============================================================================

create table if not exists cron_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  status text not null check (status in ('ok', 'falhou', 'parcial')),
  message text,
  duration_ms integer,
  processed integer,
  remaining integer,
  ran_at timestamptz not null default now()
);
create index if not exists cron_runs_job_ran_at_idx on cron_runs(job, ran_at desc);

alter table cron_runs enable row level security;
drop policy if exists "cron_runs_select_owner" on cron_runs;
create policy "cron_runs_select_owner" on cron_runs for select
  using (is_platform_owner());
-- sem policy de insert — gravação só via service_role (o cron), que bypassa RLS.

-- Poda: mantém as 200 execuções mais recentes de cada tarefa.
create or replace function record_cron_run(
  p_job text,
  p_status text,
  p_message text default null,
  p_duration_ms integer default null,
  p_processed integer default null,
  p_remaining integer default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN';
  end if;

  insert into cron_runs (job, status, message, duration_ms, processed, remaining)
  values (p_job, p_status, substring(coalesce(p_message, '') from 1 for 400), p_duration_ms, p_processed, p_remaining);

  delete from cron_runs where job = p_job and id in (
    select id from cron_runs where job = p_job order by ran_at desc offset 200
  );
end;
$$;

-- Tudo o que a tela "Saúde da Plataforma" precisa, numa chamada só.
create or replace function get_platform_health()
returns jsonb
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;

  select jsonb_build_object(
    -- Última execução de cada tarefa + quantas falhas seguidas ela acumula.
    'jobs', coalesce((
      select jsonb_agg(j order by j->>'job')
      from (
        select jsonb_build_object(
          'job', last.job,
          'status', last.status,
          'message', last.message,
          'ran_at', last.ran_at,
          'duration_ms', last.duration_ms,
          'processed', last.processed,
          'remaining', last.remaining,
          -- Falhas seguidas = execuções com status 'falhou' desde a última
          -- que deu certo. 'parcial' não zera o contador nem conta como
          -- falha (a tarefa rodou, só não terminou o lote).
          'consecutive_failures', (
            select count(*) from cron_runs c2
            where c2.job = last.job
              and c2.status = 'falhou'
              and c2.ran_at > coalesce(
                (select max(c3.ran_at) from cron_runs c3
                 where c3.job = last.job and c3.status = 'ok'),
                '-infinity'::timestamptz
              )
          )
        ) as j
        from (
          select distinct on (job) job, status, message, ran_at, duration_ms, processed, remaining
          from cron_runs order by job, ran_at desc
        ) last
      ) agg
    ), '[]'::jsonb),

    'tenants_ativos', (select count(*) from tenants where active),
    'tenants_total', (select count(*) from tenants),

    'avisos_hoje', (select count(*) from notifications_log
      where channel = 'in_app' and sent_at >= current_date
        and event in ('vence_amanha', 'vence_hoje', 'atrasada')),
    'avisos_media_7d', (select round(count(*)::numeric / 7, 0) from notifications_log
      where channel = 'in_app' and sent_at >= current_date - 7 and sent_at < current_date
        and event in ('vence_amanha', 'vence_hoje', 'atrasada')),

    'emails_falhos_7d', (select count(*) from notifications_log
      where channel = 'email' and delivery_status = 'failed' and sent_at >= current_date - 7),

    'push_total', (select count(*) from push_subscriptions),

    -- Verificações de isolamento: nenhuma linha deveria ter empresa diferente
    -- da entidade de que depende. Tudo zero = isolamento íntegro.
    'orfaos', jsonb_build_object(
      'contratos_cliente_outra_empresa', (
        select count(*) from loan_contracts lc
        join clients c on c.profile_id = lc.client_id
        where c.tenant_id <> lc.tenant_id),
      'parcelas_contrato_outra_empresa', (
        select count(*) from installments i
        join loan_contracts lc on lc.id = i.contract_id
        where lc.tenant_id <> i.tenant_id),
      'ciclos_contrato_outra_empresa', (
        select count(*) from renewal_cycles rc
        join loan_contracts lc on lc.id = rc.contract_id
        where lc.tenant_id <> rc.tenant_id),
      'pagamentos_contrato_outra_empresa', (
        select count(*) from payments p
        join loan_contracts lc on lc.id = p.contract_id
        where lc.tenant_id <> p.tenant_id),
      'notificacoes_fora_da_empresa', (
        select count(*) from notifications_log n
        join profiles pr on pr.id = n.recipient_id
        where n.tenant_id is not null and pr.tenant_id <> n.tenant_id)
    ),

    -- Empresas sem linha de configuração: quebra Configurações e faz o
    -- limiar de perda cair no default. Deve ser sempre zero.
    'tenants_sem_settings', (
      select count(*) from tenants t
      where not exists (select 1 from system_settings s where s.tenant_id = t.id))
  ) into v_result;

  return v_result;
end;
$$;

-- Fila do dia pro cron: devolve tudo o que precisa ser notificado, já
-- deduplicado contra o que saiu hoje e já com e-mail do destinatário — o
-- serverless deixa de fazer 5 idas ao banco POR PARCELA (OPS-02).
create or replace function pending_due_notifications(p_limit integer default 500)
returns table (
  kind text,
  ref_id uuid,
  contract_id uuid,
  contract_number integer,
  client_id uuid,
  client_email text,
  event text,
  amount numeric,
  due_date date
)
language plpgsql stable
security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN';
  end if;

  return query
  with base as (
    select 'installment'::text as kind, i.id as ref_id, i.contract_id,
           lc.contract_number, lc.client_id, p.email as client_email,
           case
             when i.due_date < current_date then 'atrasada'
             when i.due_date = current_date then 'vence_hoje'
             else 'vence_amanha'
           end as event,
           (i.amount_due - i.principal_paid_partial - i.interest_paid_partial) as amount,
           i.due_date
    from installments i
    join loan_contracts lc on lc.id = i.contract_id
    join profiles p on p.id = lc.client_id
    join tenants t on t.id = i.tenant_id and t.active
    where i.status in ('pendente', 'atrasada')
      and i.due_date <= current_date + 1

    union all

    select 'cycle'::text, rc.id, rc.contract_id,
           lc.contract_number, lc.client_id, p.email,
           case
             when rc.new_due_date < current_date then 'atrasada'
             when rc.new_due_date = current_date then 'vence_hoje'
             else 'vence_amanha'
           end,
           rc.full_debt_amount,
           rc.new_due_date
    from renewal_cycles rc
    join loan_contracts lc on lc.id = rc.contract_id
    join profiles p on p.id = lc.client_id
    join tenants t on t.id = rc.tenant_id and t.active
    where rc.status in ('pendente', 'atrasada')
      and rc.new_due_date <= current_date + 1
  )
  select b.kind, b.ref_id, b.contract_id, b.contract_number, b.client_id,
         b.client_email, b.event, b.amount, b.due_date
  from base b
  where not exists (
    select 1 from notifications_log n
    where n.recipient_id = b.client_id
      and n.event::text = b.event
      and n.sent_at >= current_date
      and (
        (b.kind = 'installment' and n.related_installment_id = b.ref_id)
        or (b.kind = 'cycle' and n.related_contract_id = b.contract_id and n.related_installment_id is null)
      )
  )
  order by b.due_date asc
  limit greatest(p_limit, 1);
end;
$$;

-- Quantos ainda faltam depois do lote atual — alimenta o "N na fila" da tela
-- Saúde sem precisar puxar as linhas.
create or replace function pending_due_notifications_count()
returns integer
language plpgsql stable
security definer set search_path = public
as $$
declare v_n integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN';
  end if;
  select count(*) into v_n from pending_due_notifications(1000000);
  return v_n;
end;
$$;


-- ============================================================================
-- 11. SEC-05 — freio na consulta pública de CPF → e-mail
--
-- email_for_cpf() é security definer, não exige sessão, não filtra por empresa
-- e não tinha limite de chamadas. Ela PRECISA ser pública (é o que faz o login
-- por CPF funcionar antes de existir sessão), mas do jeito que estava era um
-- oráculo aberto: dado um CPF, devolvia o e-mail da pessoa — para a plataforma
-- inteira. Confirma se alguém é cliente de ALGUMA financeira do SIGES e
-- entrega o contato. Dado o volume de bases de CPF em circulação no Brasil,
-- é enumeração em massa viável, e tratamento de dado pessoal sem base legal
-- sob a LGPD.
--
-- Não dá pra fechar a função sem quebrar o login. O que dá pra fazer, e é o
-- que este bloco faz: pôr um teto por ORIGEM. Um fluxo de login legítimo faz
-- meia dúzia de consultas por janela; um varredor faz milhares. Acima do teto
-- a função passa a responder "não encontrei" — indistinguível de um CPF que
-- realmente não existe, então o varredor não aprende nada com o bloqueio.
-- ============================================================================

create table if not exists cpf_lookup_attempts (
  id bigserial primary key,
  origin text,
  attempted_at timestamptz not null default now()
);
create index if not exists cpf_lookup_attempts_idx on cpf_lookup_attempts(origin, attempted_at desc);

alter table cpf_lookup_attempts enable row level security;
-- Sem policy nenhuma: ninguém lê nem escreve direto. Só a função abaixo
-- (security definer) toca nesta tabela.

create or replace function email_for_cpf(p_cpf text)
returns text
language plpgsql
volatile
security definer set search_path = public
as $$
declare
  v_origin text;
  v_recent int;
  v_email text;
begin
  -- Chave da janela: o IP de origem quando o proxy do Supabase informa, senão
  -- um balde único compartilhado (degrada para limite global — pior para a
  -- experiência, melhor do que não limitar nada).
  begin
    v_origin := coalesce(
      split_part(current_setting('request.headers', true)::json->>'x-forwarded-for', ',', 1),
      'desconhecido'
    );
  exception when others then
    v_origin := 'desconhecido';
  end;
  if v_origin is null or v_origin = '' then v_origin := 'desconhecido'; end if;

  select count(*) into v_recent
  from cpf_lookup_attempts
  where origin = v_origin and attempted_at > now() - interval '10 minutes';

  insert into cpf_lookup_attempts (origin) values (v_origin);

  -- Poda oportunista: mantém a tabela pequena sem depender de cron.
  if random() < 0.02 then
    delete from cpf_lookup_attempts where attempted_at < now() - interval '1 hour';
  end if;

  -- 30 consultas em 10 minutos cobre com folga alguém errando a senha várias
  -- vezes, trocando de conta, ou uma família compartilhando a mesma rede.
  if v_recent >= 30 then
    return null;
  end if;

  select email into v_email from profiles where cpf = p_cpf limit 1;
  return v_email;
end;
$$;



-- ============================================================================
-- FIM DO SCHEMA
-- ============================================================================

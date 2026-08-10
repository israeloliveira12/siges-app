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
  'contrato_criado', 'pagamento_recebido', 'renovacao_registrada'
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
  if not is_primary_admin() then
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
  invite_token text
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
    (select count(*) from profiles g where g.tenant_id = t.id and g.role = 'gerente'),
    (select count(*) from clients c where c.tenant_id = t.id),
    (select count(*) from loan_contracts lc where lc.tenant_id = t.id),
    t.invite_token
  from tenants t
  left join profiles p on p.id = t.owner_profile_id
  order by t.created_at asc;
end;
$$;

-- Renomear/(des)ativar uma empresa. Trava de segurança: o Administrador
-- Master nunca consegue desativar o PRÓPRIO tenant por aqui (se travasse a
-- própria conta, ninguém mais poderia reverter — só um acesso direto ao
-- banco resolveria).
create or replace function update_tenant(p_tenant_id uuid, p_name text, p_active boolean)
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
    active = p_active
  where id = p_tenant_id;
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

-- tenants — cada gerente só vê a PRÓPRIA linha (comparação é com o id da
-- própria tabela, não com uma coluna tenant_id — tenants É a entidade
-- tenant, não referencia uma); o Administrador Master vê TODAS (Fase 3 —
-- tela "Empresas"). Sem policy de insert/update/delete — criar/editar
-- tenant é sempre via RPC security definer (create_tenant/update_tenant).
create policy "tenants_select" on tenants for select
  using (is_platform_owner() or (is_gerente() and id = current_tenant_id()));

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
-- is_primary_admin(): mesma razão acima — Planejamento também é primaryOnly.
create policy "planning_debts_gerente_all" on planning_debts for all
  using (is_primary_admin() and tenant_id = current_tenant_id()) with check (is_primary_admin());

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
-- FIM DO SCHEMA
-- ============================================================================

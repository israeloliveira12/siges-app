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
create type installment_status as enum ('pendente', 'paga', 'atrasada', 'renovada', 'cancelada');
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
  created_at timestamptz not null default now()
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

-- ============================================================================
-- 3. TRIGGER: criar profiles automaticamente ao registrar em auth.users
-- ============================================================================

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role, cpf, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    lower(new.email),
    'cliente',
    new.raw_user_meta_data->>'cpf',
    new.raw_user_meta_data->>'phone'
  )
  on conflict (id) do nothing;

  insert into public.clients (profile_id, company, job_title, salary, pix_key, client_group)
  values (
    new.id,
    new.raw_user_meta_data->>'company',
    new.raw_user_meta_data->>'job_title',
    nullif(new.raw_user_meta_data->>'salary', ''),
    new.raw_user_meta_data->>'pix_key',
    nullif(new.raw_user_meta_data->>'client_group', '')
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

create or replace function is_active_gerente(p_id uuid)
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (select 1 from profiles where id = p_id and role = 'gerente' and active);
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
  return new;
end;
$$;

drop trigger if exists trg_prevent_profile_privilege_escalation on profiles;
create trigger trg_prevent_profile_privilege_escalation
  before update of role, is_primary_admin, active on profiles
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
  if not (is_gerente() or auth.uid() = p_client_id) then
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
  if not (is_gerente() or auth.uid() = p_client_id) then
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
-- reforça a própria checagem de titularidade/role por baixo)
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
  select credit_limit into v_limit from clients where profile_id = new.client_id;
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
    principal_share := principal_per;
    interest_share := interest_per;
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
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN: apenas gerentes podem criar contratos';
  end if;

  insert into loan_contracts (
    client_id, created_by, origin_request_id,
    principal_amount, interest_rate, installments_count, due_type, custom_interval_days,
    has_operational_fee, operational_fee_amount,
    contract_date, first_installment_date,
    allows_renewal, late_fee_percent, late_interest_percent, observations
  ) values (
    p_client_id, auth.uid(), p_origin_request_id,
    p_principal_amount, p_interest_rate, p_installments_count, p_due_type, p_custom_interval_days,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0),
    p_contract_date, p_first_installment_date,
    p_allows_renewal, coalesce(p_late_fee_percent, 0), coalesce(p_late_interest_percent, 0), p_observations
  ) returning id into v_contract_id;

  if p_installments_override is not null then
    for v_row in select * from jsonb_array_elements(p_installments_override) loop
      insert into installments (contract_id, sequence_number, due_date, principal_share, interest_share)
      values (
        v_contract_id,
        (v_row->>'sequence_number')::integer,
        (v_row->>'due_date')::date,
        (v_row->>'principal_share')::numeric,
        (v_row->>'interest_share')::numeric
      );
    end loop;
  else
    insert into installments (contract_id, sequence_number, due_date, principal_share, interest_share)
    select v_contract_id, sequence_number, due_date, principal_share, interest_share
    from calc_installments_preview(p_principal_amount, p_interest_rate, p_installments_count, p_due_type, p_first_installment_date, p_custom_interval_days);
  end if;

  if p_origin_request_id is not null then
    update loan_requests
      set status = 'aprovada', resulting_contract_id = v_contract_id,
          decided_by = auth.uid(), decided_at = now()
      where id = p_origin_request_id;
  end if;

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body)
  values (
    p_client_id, 'contrato_criado', 'in_app', v_contract_id,
    'Novo contrato criado',
    'Seu contrato #' || v_contract_id || ' no valor de R$ ' || p_principal_amount || ' foi criado.'
  );

  return v_contract_id;
end;
$$;

-- 5.5b Login por CPF: função pública (chamada ANTES do login, então precisa
-- ser security definer) que só resolve CPF -> e-mail, nada mais sensível.
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
create or replace function public_company_info()
returns table (company_name text, company_whatsapp text)
language plpgsql stable
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'FORBIDDEN';
  end if;
  return query select s.company_name, s.company_whatsapp from system_settings s where s.id = true;
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
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  update loan_requests
    set status = 'reprovada', decision_reason = p_reason, decided_by = auth.uid(), decided_at = now()
    where id = p_request_id and status = 'pendente'
    returning client_id into v_client_id;

  if v_client_id is null then
    raise exception 'REQUEST_NOT_FOUND_OR_ALREADY_DECIDED';
  end if;

  insert into notifications_log (recipient_id, event, channel, title, body)
  values (v_client_id, 'solicitacao_reprovada', 'in_app', 'Solicitação reprovada',
          coalesce('Motivo: ' || p_reason, 'Sua solicitação de empréstimo foi reprovada.'));
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
  v_remaining_count integer;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_installment from installments where id = p_installment_id for update;
  if v_installment.status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
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
    has_operational_fee, operational_fee_amount, received_by, notes, received_at
  ) values (
    v_contract.id, p_installment_id, 'quitacao_parcela', p_amount_received,
    v_pay_principal, v_pay_interest + v_pay_late, v_pay_late,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date)
  ) returning id into v_payment_id;

  update installments set
    principal_paid_partial = principal_paid_partial + v_pay_principal,
    interest_paid_partial = interest_paid_partial + v_pay_interest
  where id = p_installment_id;

  if v_remaining_total - p_amount_received <= 0.01 then
    update installments set status = 'paga', paid_at = coalesce(p_received_at, current_date) where id = p_installment_id;

    select count(*) into v_remaining_count from installments
      where contract_id = v_contract.id and status in ('pendente', 'atrasada');

    if v_remaining_count = 0 and not exists (
      select 1 from renewal_cycles where contract_id = v_contract.id and status in ('pendente', 'atrasada')
    ) then
      update loan_contracts set status = 'quitado', updated_at = now() where id = v_contract.id;
    end if;

    insert into notifications_log (recipient_id, event, channel, related_contract_id, related_installment_id, title, body)
    values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id, p_installment_id,
            'Pagamento recebido', 'Recebemos seu pagamento de R$ ' || p_amount_received || '.');
  else
    insert into notifications_log (recipient_id, event, channel, related_contract_id, related_installment_id, title, body)
    values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id, p_installment_id,
            'Pagamento parcial recebido',
            'Recebemos R$ ' || p_amount_received || '. Restam R$ ' || round(v_remaining_total - p_amount_received, 2) || ' desta parcela.');
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
  p_received_at date default current_date
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
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  if p_interest_only_amount < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if p_source_type = 'installment' then
    select i.contract_id, i.principal_share, i.interest_share, i.status
      into v_contract_id, v_principal, v_interest, v_status
      from installments i where i.id = p_source_id for update;
  else
    select rc.contract_id, 0, (rc.full_debt_amount - 0), rc.status
      into v_contract_id, v_principal, v_interest, v_status
      from renewal_cycles rc where rc.id = p_source_id for update;
    -- para ciclos já renovados, o "capital" permanece o mesmo da 1ª parcela original;
    -- full_debt_amount do ciclo anterior já é o total (capital+juros) então usamos ele
    select rc.full_debt_amount into v_full_debt from renewal_cycles rc where rc.id = p_source_id;
    v_principal := 0;
    v_interest := v_full_debt; -- mantém o valor cheio como base do próximo ciclo abaixo
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

  select lc.due_type, lc.client_id, lc.custom_interval_days into v_due_type, v_client_id, v_custom_days
    from loan_contracts lc where lc.id = v_contract_id;

  v_full_debt := coalesce(v_full_debt, v_principal + v_interest);

  v_step := case v_due_type
    when 'mensal' then interval '1 month'
    when 'quinzenal' then interval '15 days'
    when 'semanal' then interval '7 days'
    when 'personalizado' then (coalesce(v_custom_days, 30) || ' days')::interval
  end;
  v_new_due_date := coalesce(p_received_at, current_date) + v_step;

  select coalesce(max(cycle_number), 0) + 1 into v_cycle_number
    from renewal_cycles where contract_id = v_contract_id;

  insert into renewal_cycles (
    contract_id, cycle_number, origin_installment_id, previous_cycle_id,
    interest_only_amount, full_debt_amount, new_due_date, created_by
  ) values (
    v_contract_id, v_cycle_number,
    case when p_source_type = 'installment' then p_source_id else null end,
    case when p_source_type = 'renewal_cycle' then p_source_id else null end,
    p_interest_only_amount, v_full_debt, v_new_due_date, auth.uid()
  ) returning id into v_new_cycle_id;

  if p_source_type = 'installment' then
    update installments set status = 'renovada', renewed_into_cycle_id = v_new_cycle_id where id = p_source_id;
  else
    update renewal_cycles set status = 'renovada' where id = p_source_id;
  end if;

  insert into payments (
    contract_id, renewal_cycle_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at
  ) values (
    v_contract_id, v_new_cycle_id, 'renovacao_juros', p_interest_only_amount + coalesce(p_late_charge_amount, 0),
    0, p_interest_only_amount + coalesce(p_late_charge_amount, 0), coalesce(p_late_charge_amount, 0),
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date)
  ) returning id into v_payment_id;

  update loan_contracts set status = 'em_aberto', updated_at = now()
    where id = v_contract_id and status in ('em_aberto', 'atrasado');

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body)
  values (v_client_id, 'renovacao_registrada', 'in_app', v_contract_id,
          'Renovação registrada', 'Sua dívida foi renovada. Novo vencimento: ' || v_new_due_date);

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
  v_payment_id uuid;
  v_remaining integer;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_cycle from renewal_cycles where id = p_cycle_id for update;
  if v_cycle.status not in ('pendente', 'atrasada') then
    raise exception 'CYCLE_NOT_PAYABLE';
  end if;

  select * into v_contract from loan_contracts where id = v_cycle.contract_id for update;
  v_principal := v_contract.principal_amount;
  v_interest := v_cycle.full_debt_amount - v_principal;

  insert into payments (
    contract_id, renewal_cycle_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at
  ) values (
    v_contract.id, p_cycle_id, 'quitacao_final', p_amount_received,
    v_principal, v_interest + coalesce(p_late_charge_amount, 0), coalesce(p_late_charge_amount, 0),
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date)
  ) returning id into v_payment_id;

  update renewal_cycles set status = 'paga', paid_at = coalesce(p_received_at, current_date) where id = p_cycle_id;

  select count(*) into v_remaining from installments
    where contract_id = v_contract.id and status in ('pendente', 'atrasada');

  if v_remaining = 0 then
    update loan_contracts set status = 'quitado', updated_at = now() where id = v_contract.id;
  end if;

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body)
  values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id,
          'Pagamento recebido', 'Recebemos seu pagamento de R$ ' || p_amount_received || '. Contrato quitado.');

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
begin
  update installments set status = 'atrasada'
    where status = 'pendente' and due_date < current_date;

  update renewal_cycles set status = 'atrasada'
    where status = 'pendente' and new_due_date < current_date;

  update loan_contracts lc set status = 'atrasado', updated_at = now()
    where status = 'em_aberto' and (
      exists (select 1 from installments i where i.contract_id = lc.id and i.status = 'atrasada')
      or exists (select 1 from renewal_cycles rc where rc.contract_id = lc.id and rc.status = 'atrasada')
    );

  update loan_contracts lc set status = 'perda', updated_at = now()
    where status = 'atrasado' and (
      exists (
        select 1 from installments i where i.contract_id = lc.id and i.status = 'atrasada'
          and i.due_date < current_date - (select loss_days_threshold from system_settings)
      )
      or exists (
        select 1 from renewal_cycles rc where rc.contract_id = lc.id and rc.status = 'atrasada'
          and rc.new_due_date < current_date - (select loss_days_threshold from system_settings)
      )
    );

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

  for v_client in select profile_id from clients loop
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
  p_pix_key text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  update profiles set full_name = p_full_name, cpf = p_cpf, phone = p_phone, updated_at = now()
    where id = p_client_id;

  update clients set credit_limit = p_credit_limit,
    client_group = p_client_group, notes = p_notes,
    company = p_company, job_title = p_job_title, salary = p_salary, pix_key = p_pix_key
    where profile_id = p_client_id;
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
  where id = p_contract_id;
end;
$$;

-- Editar/reagendar uma parcela específica (só enquanto não estiver paga)
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
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  update installments set
    due_date = p_due_date,
    principal_share = p_principal_share,
    interest_share = p_interest_share
  where id = p_installment_id and status in ('pendente', 'atrasada');
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
  -- qualquer outro, inclusive reativar/desativar contas.
  if not is_primary_admin() then raise exception 'FORBIDDEN'; end if;
  update profiles set full_name = p_full_name, phone = p_phone, active = p_active, updated_at = now()
    where id = p_gerente_id and role = 'gerente';
end;
$$;

-- 5.12 Aprovar / reprovar o cadastro de um cliente (item obrigatório antes de
-- ele conseguir usar o sistema, além da confirmação de e-mail do Supabase Auth)
create or replace function approve_client(p_client_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  update clients set approval_status = 'aprovado', decided_by = auth.uid(), decided_at = now(), decision_reason = null
    where profile_id = p_client_id;

  insert into notifications_log (recipient_id, event, channel, title, body)
  values (p_client_id, 'solicitacao_aprovada', 'in_app', 'Cadastro aprovado',
          'Sua conta foi aprovada. Você já pode usar o SIGES normalmente.');
end;
$$;

create or replace function reject_client(p_client_id uuid, p_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  update clients set approval_status = 'rejeitado', decided_by = auth.uid(), decided_at = now(), decision_reason = p_reason
    where profile_id = p_client_id;

  insert into notifications_log (recipient_id, event, channel, title, body)
  values (p_client_id, 'solicitacao_reprovada', 'in_app', 'Cadastro não aprovado',
          coalesce('Motivo: ' || p_reason, 'Seu cadastro não foi aprovado.'));
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
begin
  if v_actor_id is not null then
    select full_name, role::text into v_actor_name, v_actor_role from profiles where id = v_actor_id;
  end if;
  insert into audit_log (actor_id, actor_name, actor_role, action, description, metadata)
  values (v_actor_id, coalesce(v_actor_name, 'Anônimo'), v_actor_role, p_action, p_description, coalesce(p_metadata, '{}'::jsonb));
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
begin
  if not is_primary_admin() then
    raise exception 'FORBIDDEN';
  end if;

  delete from payments where true;
  delete from renewal_cycles where true;
  delete from installments where true;
  delete from loan_contracts where true;
  delete from loan_requests where true;
  delete from notifications_log where true;
  delete from push_subscriptions where true;
  delete from clients where true;
  delete from profiles where role = 'cliente';
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

-- profiles
create policy "profiles_select" on profiles for select
  using (id = auth.uid() or is_gerente());
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
  using (profile_id = auth.uid() or is_gerente());
create policy "clients_gerente_write" on clients for insert with check (is_gerente());
create policy "clients_gerente_update" on clients for update using (is_gerente());

-- loan_requests
create policy "requests_select" on loan_requests for select
  using (client_id = auth.uid() or is_gerente());
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
  using (is_gerente());

-- loan_contracts
create policy "contracts_select" on loan_contracts for select
  using (client_id = auth.uid() or is_gerente());
create policy "contracts_gerente_all" on loan_contracts for all
  using (is_gerente()) with check (is_gerente());

-- installments
create policy "installments_select" on installments for select
  using (is_gerente() or exists (
    select 1 from loan_contracts lc where lc.id = installments.contract_id and lc.client_id = auth.uid()
  ));
create policy "installments_gerente_write" on installments for all
  using (is_gerente()) with check (is_gerente());

-- renewal_cycles
create policy "renewal_select" on renewal_cycles for select
  using (is_gerente() or exists (
    select 1 from loan_contracts lc where lc.id = renewal_cycles.contract_id and lc.client_id = auth.uid()
  ));
create policy "renewal_gerente_write" on renewal_cycles for all
  using (is_gerente()) with check (is_gerente());

-- payments
create policy "payments_select" on payments for select
  using (is_gerente() or exists (
    select 1 from loan_contracts lc where lc.id = payments.contract_id and lc.client_id = auth.uid()
  ));
create policy "payments_gerente_write" on payments for all
  using (is_gerente()) with check (is_gerente());

-- notifications_log
create policy "notifications_select" on notifications_log for select
  using (recipient_id = auth.uid() or is_gerente());
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
create policy "settings_select_gerente" on system_settings for select using (is_gerente());
-- is_primary_admin(), não is_gerente(): Configurações é tela exclusiva do
-- Administrador (routes primaryOnly:true no router) — antes um gerente
-- secundário conseguia alterar taxas/thresholds/caixa via REST direto,
-- contornando a restrição que só existia na UI.
create policy "settings_gerente_update" on system_settings for update using (is_primary_admin());

-- planning_debts
-- is_primary_admin(): mesma razão acima — Planejamento também é primaryOnly.
create policy "planning_debts_gerente_all" on planning_debts for all
  using (is_primary_admin()) with check (is_primary_admin());

-- audit_log — só leitura, e só gerente. Escrita é exclusivamente via
-- log_audit_event() (security definer, bypassa RLS), inclusive pra registrar
-- eventos sem sessão (login falho) — por isso não existe policy de insert.
create policy "audit_log_select_gerente" on audit_log for select using (is_gerente());

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

-- ============================================================================
-- FIM DO SCHEMA
-- ============================================================================

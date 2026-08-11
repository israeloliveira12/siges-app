-- Migration 043 — Plano Grátis + Trial por plano, e 4 telas novas da
-- Plataforma SaaS: Assinaturas/Cobranças, Configurações da Plataforma,
-- Comunicados (aviso in-app pras empresas) e Métricas históricas (snapshot
-- diário, alimentado pelo cron já existente).
--
-- IMPORTANTE: rode em DUAS ETAPAS. O PASSO 1 adiciona um valor novo ao enum
-- notification_event ('aviso_plataforma') — o Postgres não deixa usar um
-- valor de enum recém-criado na mesma transação em que foi adicionado
-- (mesmo motivo já documentado na migration_027, seção "perda"). Cole e
-- rode só o PASSO 1 sozinho primeiro; depois cole e rode o PASSO 2 inteiro
-- numa segunda execução.

-- ============================================================================
-- PASSO 1 — rode sozinho primeiro
-- ============================================================================
alter type notification_event add value if not exists 'aviso_plataforma';

-- ============================================================================
-- PASSO 2 — rode depois, numa segunda execução
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Plano Grátis (já funcionava criando um plano com preço R$0 — só faltava
--    a UI não descartar silenciosamente o valor 0) + Trial por plano.
-- ----------------------------------------------------------------------------
alter table plans add column trial_days integer check (trial_days is null or trial_days > 0);
alter table tenants add column trial_ends_at timestamptz;

drop function if exists upsert_plan(uuid, text, text, numeric, boolean, integer, jsonb);
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

-- Atribuir/remover o plano de uma empresa. Se o plano NOVO for diferente do
-- atual e tiver trial_days configurado, o teste começa a contar agora
-- (trial_ends_at = now() + trial_days). Reatribuir o MESMO plano de novo
-- NÃO reinicia um teste já em andamento. Plano sem trial_days, ou "sem
-- plano" (null), zera trial_ends_at.
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

-- Ajuste manual do fim do teste de uma empresa específica (estender/
-- encurtar um caso pontual, ou "converter pra pago" mandando null) sem
-- precisar reatribuir o plano — usado pela tela Empresas.
drop function if exists update_tenant(uuid, text, boolean);
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

drop function if exists list_tenants_with_stats();
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
    (select count(*) from profiles g where g.tenant_id = t.id and g.role = 'gerente'),
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

-- get_platform_dashboard_stats(): exclui empresas em teste ATIVO do MRR/ARR/
-- ticket médio (não são receita real ainda — ver CLAUDE.md), acrescenta
-- trial_ends_at no detalhe por empresa, e 3 contadores novos de trial no
-- summary (usados no card de saúde operacional "Testes").
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
      'trials_expired', (select count(*) from tenants where active and trial_ends_at is not null and trial_ends_at <= now())
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
          (select count(*) from profiles g where g.tenant_id = t.id and g.role = 'gerente') as gerente_count,
          (select count(*) from clients c where c.tenant_id = t.id) as cliente_count,
          (select count(*) from loan_contracts lc where lc.tenant_id = t.id and lc.status in ('em_aberto', 'atrasado')) as contract_count,
          (select coalesce(sum(lc.principal_amount), 0) from loan_contracts lc where lc.tenant_id = t.id and lc.status in ('em_aberto', 'atrasado')) as capital_active,
          (select max(a.created_at) from audit_log a where a.tenant_id = t.id and a.action = 'login_sucesso') as last_login_at,
          (select count(*) from audit_log a where a.tenant_id = t.id and a.action = 'erro_sistema' and a.created_at >= now() - interval '7 days') as errors_recent
        from tenants t
        left join plans p on p.id = t.plan_id
        order by t.created_at desc
      ) row
    )
  ) into v_result;

  return v_result;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2) Assinaturas/Cobranças — registro manual de pagamento por empresa (não
--    existe gateway de pagamento nenhum na plataforma; é só uma agenda de
--    "empresa X pagou o mês Y", pra você acompanhar quem está em dia).
-- ----------------------------------------------------------------------------
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

alter table tenant_payments enable row level security;
create policy "tenant_payments_platform_owner" on tenant_payments for select
  using (is_platform_owner());
-- sem policy de insert/update/delete — sempre via RPC security definer.

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
  if p_status not in ('pendente', 'pago', 'atrasado', 'cancelado') then raise exception 'INVALID_STATUS'; end if;

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

-- ----------------------------------------------------------------------------
-- 3) Configurações da Plataforma — dados globais do SaaS EM SI (diferente
--    de system_settings, que é por-tenant, uma linha por empresa). Singleton
--    de verdade: 1 linha só pra plataforma inteira.
-- ----------------------------------------------------------------------------
create table platform_settings (
  id boolean primary key default true check (id),
  support_email text,
  support_phone text,
  welcome_message text,
  default_trial_days integer check (default_trial_days is null or default_trial_days > 0),
  updated_at timestamptz not null default now()
);
insert into platform_settings (id) values (true);

alter table platform_settings enable row level security;
create policy "platform_settings_select_owner" on platform_settings for select
  using (is_platform_owner());
-- sem policy de insert/update — sempre via RPC.

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

-- ----------------------------------------------------------------------------
-- 4) Comunicados — aviso in-app do Administrador Master pros administradores
--    (gerentes) de uma empresa específica ou de todas. Reaproveita
--    notifications_log/o sino já existente (channel='in_app'), sem
--    e-mail/push — é uma comunicação da plataforma pro cliente-empresa, não
--    um evento financeiro do negócio de cada um.
-- ----------------------------------------------------------------------------
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
      then coalesce((select t.name from tenants t where t.id = min(n.tenant_id)), 'Empresa excluída')
      else 'Todas as empresas'
    end
  from notifications_log n
  where n.event = 'aviso_plataforma'::notification_event
  group by n.title, n.body, n.sent_at
  order by n.sent_at desc
  limit 50;
end;
$$;

-- ----------------------------------------------------------------------------
-- 5) Métricas históricas — snapshot diário (chamado pelo cron já existente,
--    api/cron-daily-check.js), pra alimentar gráficos de evolução mês a mês
--    sem precisar reconstruir um histórico que nunca foi guardado até hoje.
-- ----------------------------------------------------------------------------
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

alter table platform_metrics_snapshots enable row level security;
create policy "platform_metrics_select_owner" on platform_metrics_snapshots for select
  using (is_platform_owner());

-- Callable pelo Administrador Master (botão "Capturar agora" na tela, útil
-- pra não esperar o cron do dia seguinte) OU pelo cron via service_role.
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

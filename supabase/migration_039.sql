-- Migration 039 — SIGES vira plataforma: FASE 5 (planos configuráveis)
--
-- Duas frentes:
-- 1) Fecha 2 requisitos originais do pivô SaaS que ainda não tinham sido
--    implementados: "Planejamento é só meu" e "Configurações não terá zona
--    de risco" pra empresa cliente da plataforma — ambos viram exclusivos
--    do Administrador Master (mesmo tratamento já dado à Auditoria).
-- 2) Sistema de planos: tabela `plans` com limites/recursos configuráveis
--    manualmente (jsonb), atribuídos por empresa. SEM cobrança nenhuma
--    envolvida ainda — só o desenho de limites.
--
-- ZERO MUDANÇA DE COMPORTAMENTO pra qualquer empresa hoje: toda empresa
-- nasce/continua com plan_id = null ("sem plano" = sem limite nenhum,
-- exatamente como já era antes desta migration).

-- ----------------------------------------------------------------------------
-- 1) planning_debts — exclusivo do Administrador Master.
-- ----------------------------------------------------------------------------
drop policy if exists "planning_debts_gerente_all" on planning_debts;
create policy "planning_debts_gerente_all" on planning_debts for all
  using (is_platform_owner() and tenant_id = current_tenant_id()) with check (is_platform_owner());

-- ----------------------------------------------------------------------------
-- 2) wipe_all_business_data() (Zona de risco) — exclusivo do Administrador
--    Master.
-- ----------------------------------------------------------------------------
create or replace function wipe_all_business_data()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  if not is_platform_owner() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

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

-- ----------------------------------------------------------------------------
-- 3) update_planning_cash() / update_planning_ltv() — as 2 colunas de
--    Planejamento que vivem na mesma linha de system_settings que dados de
--    empresa/taxas (editáveis por qualquer admin primário) ganham RPCs
--    estreitas em vez de UPDATE direto na tabela.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 4) plans + tenants.plan_id
-- ----------------------------------------------------------------------------
create table plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  price_monthly numeric(10,2),
  active boolean not null default true,
  sort_order integer not null default 0,
  limits jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table tenants add column plan_id uuid references plans(id) on delete set null;

alter table plans enable row level security;
create policy "plans_select_platform_owner" on plans for select
  using (is_platform_owner());

-- ----------------------------------------------------------------------------
-- 5) handle_new_user() — limite de clientes por plano no cadastro público.
-- ----------------------------------------------------------------------------
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_max_clientes int;
begin
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

-- ----------------------------------------------------------------------------
-- 6) list_tenants_with_stats() ganha plan_id/plan_name — muda o RETURNS
--    TABLE de novo, precisa de DROP antes.
-- ----------------------------------------------------------------------------
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
  plan_name text
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
    pl.name
  from tenants t
  left join profiles p on p.id = t.owner_profile_id
  left join plans pl on pl.id = t.plan_id
  order by t.created_at asc;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7) CRUD de planos + atribuição por empresa + consulta de limites efetivos.
-- ----------------------------------------------------------------------------
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

create or replace function upsert_plan(
  p_id uuid,
  p_name text,
  p_description text,
  p_price_monthly numeric,
  p_active boolean,
  p_sort_order integer,
  p_limits jsonb
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

  if p_id is null then
    insert into plans (name, description, price_monthly, active, sort_order, limits)
    values (trim(p_name), nullif(trim(p_description), ''), p_price_monthly, coalesce(p_active, true), coalesce(p_sort_order, 0), coalesce(p_limits, '{}'::jsonb))
    returning id into v_id;
  else
    update plans set
      name = trim(p_name),
      description = nullif(trim(p_description), ''),
      price_monthly = p_price_monthly,
      active = coalesce(p_active, true),
      sort_order = coalesce(p_sort_order, 0),
      limits = coalesce(p_limits, '{}'::jsonb)
    where id = p_id
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

create or replace function delete_plan(p_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  delete from plans where id = p_id;
end;
$$;

create or replace function assign_tenant_plan(p_tenant_id uuid, p_plan_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  update tenants set plan_id = p_plan_id where id = p_tenant_id;
end;
$$;

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

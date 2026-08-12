-- Migration 047 — Bug real corrigido: o limite de "gerentes" do plano
-- contava o Administrador (is_primary_admin=true) junto com os gerentes
-- secundários, em vez de tratá-lo como sempre 1, fixo, à parte. Resultado
-- prático: um plano com "1 gerente" já nascia sem nenhuma vaga sobrando —
-- o próprio Administrador ocupava a única vaga do limite, e nunca era
-- possível criar um gerente de verdade. Corrigido nas 2 funções que contam
-- gerentes por tenant (tela Empresas e o card "Perto do limite do plano"
-- no painel executivo). A checagem de limite no momento de CRIAR um
-- gerente (api/create-user.js) também foi corrigida, mas isso não precisa
-- de migration — é só lógica do endpoint serverless.

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

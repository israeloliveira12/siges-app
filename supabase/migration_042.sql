-- Migration 042 — Painel executivo da Plataforma SaaS (tela "Início")
--
-- Adiciona tenants.suspended_at (marcado sempre que uma empresa é
-- suspensa, nunca limpo ao reativar — usado pra calcular tempo médio de
-- vida até suspensão) e uma RPC única que devolve todo o painel executivo
-- num jsonb só: assinantes ativos/suspensos/novos, distribuição e receita
-- por plano, MRR/ARR/ticket médio, uso agregado da plataforma inteira
-- (clientes, contratos, capital, gerentes), e o detalhe por empresa usado
-- pra montar rankings e alertas de saúde (perto do limite do plano, sem
-- atividade recente, erros recentes) no frontend.
--
-- ZERO MUDANÇA DE COMPORTAMENTO pra qualquer perfil que não seja o
-- Administrador Master.

alter table tenants add column suspended_at timestamptz;

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
    active = p_active,
    suspended_at = case when p_active then suspended_at else now() end
  where id = p_tenant_id;
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
      'mrr', (select coalesce(sum(p.price_monthly), 0) from tenants t join plans p on p.id = t.plan_id where t.active),
      'avg_ticket', (
        select case when count(*) > 0 then coalesce(sum(p.price_monthly), 0) / count(*) else 0 end
        from tenants t join plans p on p.id = t.plan_id
        where t.active and p.price_monthly is not null
      ),
      'avg_lifetime_days_suspended', (
        select coalesce(avg(extract(epoch from (suspended_at - created_at)) / 86400), 0)
        from tenants where suspended_at is not null
      )
    ),
    'by_plan', (
      select coalesce(jsonb_agg(row), '[]'::jsonb) from (
        select
          coalesce(p.name, 'Sem plano') as plan_name,
          count(t.id) as tenant_count,
          coalesce(sum(p.price_monthly), 0) as mrr_contribution
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
          t.id, t.name, t.active, t.created_at, t.suspended_at,
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

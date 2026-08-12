-- Migration 046 — Cobranças recorrentes de assinatura, sem gateway de
-- pagamento: geração em lote do mês, marcação automática de atraso e
-- contador de inadimplência no painel executivo.
--
-- Contexto: até aqui cada cobrança era 100% manual (criar uma a uma, e
-- lembrar de setar "atrasado" na mão — o que na prática nunca acontecia).
-- Como o VALOR já vive no plano da empresa (plans.price_monthly) e já
-- existe um cron diário rodando, dá pra automatizar as duas pontas sem
-- inventar nenhum conceito novo de "assinatura recorrente" no schema.

-- ----------------------------------------------------------------------------
-- 1) Geração em lote — cria 1 cobrança PENDENTE por empresa ativa com plano
--    pago, usando o preço do plano. Idempotente por mês: uma empresa que já
--    tem cobrança com vencimento no mesmo mês é PULADA (rodar 2x no mesmo mês
--    não duplica nada). Empresa em TESTE ativo também é pulada — ainda não
--    é pagante, mesmo critério já usado no MRR do painel executivo.
--    Devolve quantas foram criadas e quantas foram puladas.
-- ----------------------------------------------------------------------------
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

  -- Conta os pulados ANTES de inserir (depois do insert eles seriam
  -- indistinguíveis dos recém-criados).
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
    -- Empresa em teste ativo ainda não é pagante (mesmo critério do MRR).
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

-- Prévia (sem gravar nada) — usada pelo modal pra mostrar quantas cobranças
-- serão criadas antes do usuário confirmar. Mesmos critérios da função de
-- geração acima; se divergirem no futuro, os dois precisam mudar juntos.
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

-- ----------------------------------------------------------------------------
-- 2) Marcação automática de atraso — chamada pelo cron diário
--    (api/cron-daily-check.js). Sem isso, o status 'atrasado' de
--    tenant_payments só existia se o Administrador Master lembrasse de
--    setar na mão, o que na prática nunca acontecia. Mesmo raciocínio do
--    refresh_overdue_status() que já existe pras parcelas dos clientes.
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 3) Painel executivo — contadores de inadimplência (card novo na Saúde
--    operacional) e o detalhe por empresa pra montar a lista.
-- ----------------------------------------------------------------------------
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
          (select count(*) from profiles g where g.tenant_id = t.id and g.role = 'gerente') as gerente_count,
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

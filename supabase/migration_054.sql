-- ============================================================================
-- migration_054.sql — Análises: ficha completa do cliente + relatórios novos
--
-- Pedido do usuário (2026-11-01): a tela de Score mostra pouco sobre o cliente
-- (falta quantidade e histórico de empréstimos, quanto ele já tomou, quanto deu
-- de lucro, atrasos, risco, pontualidade, acessos) e Relatórios precisa de
-- muito mais análise (renovações, prorrogações, projeção, tendência, risco,
-- Pareto).
--
-- POR QUE TUDO NO BANCO E NADA NO NAVEGADOR
-- O PostgREST corta qualquer listagem em 1.000 linhas por padrão. Somar dinheiro
-- no navegador a partir de uma lista cortada dá um número MENOR que o real, sem
-- erro nenhum na tela — é a classe de bug FIN-01 já registrada neste projeto.
-- Toda soma aqui é feita em SQL, sobre a tabela inteira.
--
-- Nenhuma tabela é alterada: só funções de leitura (stable). Nada muda até as
-- telas chamarem.
-- ============================================================================


-- ============================================================================
-- 1. Ficha analítica de um cliente
-- ============================================================================

create or replace function client_analytics(p_client_id uuid)
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

  with contratos as (
    select * from loan_contracts
     where tenant_id = v_tenant and client_id = p_client_id
  ),
  parcelas as (
    select i.* from installments i
     join contratos c on c.id = i.contract_id
     where i.tenant_id = v_tenant
  ),
  ciclos as (
    select rc.* from renewal_cycles rc
     join contratos c on c.id = rc.contract_id
     where rc.tenant_id = v_tenant
  ),
  pagamentos as (
    select p.* from payments p
     join contratos c on c.id = p.contract_id
     where p.tenant_id = v_tenant
  ),
  -- Parcelas quitadas: separa as pagas em dia das pagas com atraso. Mesma
  -- definição do motor de score (paid_at::date <= due_date), para a ficha não
  -- divergir da nota exibida ao lado dela.
  quitadas as (
    select (paid_at at time zone 'UTC')::date as dia_pago, due_date
      from parcelas where status = 'paga' and paid_at is not null
  )
  select jsonb_build_object(
    'contratos_total',        (select count(*) from contratos),
    'contratos_em_aberto',    (select count(*) from contratos where status in ('em_aberto', 'atrasado')),
    'contratos_quitados',     (select count(*) from contratos where status = 'quitado'),
    'contratos_perda',        (select count(*) from contratos where status = 'perda'),
    'primeiro_contrato',      (select min(contract_date) from contratos),
    'ultimo_contrato',        (select max(contract_date) from contratos),

    -- Quanto o cliente já tomou (capital contratado) e quanto saiu do caixa
    -- (capital + taxa de saída).
    'total_emprestado',       coalesce((select sum(principal_amount) from contratos), 0),
    'total_desembolsado',     coalesce((select sum(total_disbursed_amount) from contratos), 0),
    'ticket_medio',           coalesce((select avg(principal_amount) from contratos), 0),

    -- Quanto ele já devolveu e quanto disso virou lucro.
    'total_recebido',         coalesce((select sum(amount_received) from pagamentos), 0),
    'juros_pagos',            coalesce((select sum(interest_component) from pagamentos), 0),
    'lucro_liquido',          coalesce((select sum(net_profit) from pagamentos), 0),
    'encargos_atraso_pagos',  coalesce((select sum(late_charge_amount) from pagamentos), 0),
    'taxas_cobradas',         coalesce((select sum(operational_fee_amount) from pagamentos where has_operational_fee), 0),

    -- Em aberto hoje: saldo remanescente de parcelas e ciclos (desconta
    -- pagamento parcial já recebido — migration_051).
    'saldo_em_aberto', coalesce((
      select sum(greatest(0, amount_due - principal_paid_partial - interest_paid_partial))
        from parcelas where status in ('pendente', 'atrasada')
    ), 0) + coalesce((
      select sum(greatest(0, full_debt_amount - principal_paid_partial - interest_paid_partial))
        from ciclos where status in ('pendente', 'atrasada')
    ), 0),
    'capital_em_risco', coalesce((
      select sum(greatest(0, principal_share - principal_paid_partial))
        from parcelas where status = 'atrasada'
    ), 0),
    'prejuizo_reconhecido', coalesce((select sum(principal_lost) from parcelas), 0)
                          + coalesce((select sum(principal_lost) from ciclos), 0),

    -- Comportamento de pagamento.
    'parcelas_total',    (select count(*) from parcelas),
    'parcelas_pagas',    (select count(*) from quitadas),
    'parcelas_em_dia',   (select count(*) from quitadas where dia_pago <= due_date),
    'parcelas_atrasadas_pagas', (select count(*) from quitadas where dia_pago > due_date),
    'parcelas_em_aberto',(select count(*) from parcelas where status = 'pendente'),
    'parcelas_vencidas', (select count(*) from parcelas where status = 'atrasada'),
    'parcelas_perda',    (select count(*) from parcelas where status = 'perda'),
    'atraso_medio_dias', coalesce((select avg(dia_pago - due_date) from quitadas where dia_pago > due_date), 0),
    'atraso_maximo_dias',coalesce((select max(dia_pago - due_date) from quitadas), 0),
    -- Dias de atraso do que está vencido AGORA (não histórico).
    'atraso_atual_dias', coalesce((select max(current_date - due_date) from parcelas where status = 'atrasada'), 0),

    -- Renovação x prorrogação. As duas gravam payment_kind 'renovacao_juros'
    -- (migration_052 reaproveitou o tipo de propósito), e o que as separa é
    -- qual coluna o pagamento aponta: ciclo = renovação da dívida inteira;
    -- parcela = prorrogação do cronograma.
    'renovacoes',        (select count(*) from ciclos),
    'prorrogacoes',      (select count(*) from pagamentos where payment_kind = 'renovacao_juros' and installment_id is not null),
    'lucro_renovacoes',  coalesce((select sum(interest_component) from pagamentos where payment_kind = 'renovacao_juros'), 0),

    -- Acessos. ATENÇÃO: audit_log guarda só os 500 eventos mais recentes POR
    -- TENANT (retenção definida em log_audit_event). Isto não é o total
    -- histórico de logins do cliente, e a tela precisa dizer isso.
    'acessos_registrados', (select count(*) from audit_log
                             where tenant_id = v_tenant and actor_id = p_client_id and action = 'login_sucesso'),
    'ultimo_acesso',       (select max(created_at) from audit_log
                             where tenant_id = v_tenant and actor_id = p_client_id and action = 'login_sucesso'),

    'indicados',         (select count(*) from clients where tenant_id = v_tenant and referred_by_client_id = p_client_id)
  ) into v_result;

  return v_result;
end;
$$;


-- ============================================================================
-- 2. Histórico de contratos do cliente (uma linha por contrato, já somado)
-- ============================================================================

create or replace function client_loan_history(p_client_id uuid)
returns table (
  contract_id uuid,
  contract_number integer,
  contract_date date,
  principal_amount numeric,
  interest_rate numeric,
  installments_count integer,
  due_type text,
  status text,
  total_recebido numeric,
  lucro numeric,
  saldo_aberto numeric,
  parcelas_pagas bigint,
  parcelas_atrasadas bigint,
  renovacoes bigint
)
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();

  return query
  select
    c.id, c.contract_number, c.contract_date, c.principal_amount, c.interest_rate,
    c.installments_count, c.due_type::text, c.status::text,
    coalesce((select sum(p.amount_received) from payments p where p.contract_id = c.id), 0),
    coalesce((select sum(p.net_profit) from payments p where p.contract_id = c.id), 0),
    coalesce((select sum(greatest(0, i.amount_due - i.principal_paid_partial - i.interest_paid_partial))
                from installments i where i.contract_id = c.id and i.status in ('pendente', 'atrasada')), 0)
    + coalesce((select sum(greatest(0, rc.full_debt_amount - rc.principal_paid_partial - rc.interest_paid_partial))
                from renewal_cycles rc where rc.contract_id = c.id and rc.status in ('pendente', 'atrasada')), 0),
    (select count(*) from installments i where i.contract_id = c.id and i.status = 'paga'),
    (select count(*) from installments i where i.contract_id = c.id and i.status = 'atrasada'),
    (select count(*) from renewal_cycles rc where rc.contract_id = c.id)
  from loan_contracts c
  where c.tenant_id = v_tenant and c.client_id = p_client_id
  order by c.contract_date desc, c.contract_number desc;
end;
$$;


-- ============================================================================
-- 3. Série mensal de um cliente (recebido x lucro) — alimenta o gráfico da ficha
-- ============================================================================

create or replace function client_payment_series(p_client_id uuid, p_months integer default 12)
returns table (mes date, recebido numeric, lucro numeric)
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_meses integer := least(greatest(coalesce(p_months, 12), 1), 60);
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();

  -- generate_series garante os meses SEM movimento também: sem isso o gráfico
  -- ligaria dois meses distantes como se a linha fosse contínua, escondendo
  -- um período inteiro sem pagamento.
  return query
  select g.mes::date,
         coalesce(sum(p.amount_received), 0),
         coalesce(sum(p.net_profit), 0)
    from generate_series(
           date_trunc('month', current_date) - ((v_meses - 1) || ' months')::interval,
           date_trunc('month', current_date),
           interval '1 month') as g(mes)
    left join payments p
      on p.tenant_id = v_tenant
     and date_trunc('month', p.received_at at time zone 'UTC') = g.mes
     and p.contract_id in (select id from loan_contracts
                            where tenant_id = v_tenant and client_id = p_client_id)
   group by g.mes
   order by g.mes;
end;
$$;


-- ============================================================================
-- 4. Relatório: renovações e prorrogações no período
-- ============================================================================

create or replace function report_renewals(p_start date, p_end date)
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

  -- Renovação (ciclo) x prorrogação (parcela): os dois gravam
  -- payment_kind 'renovacao_juros'; o que separa é a coluna apontada.
  select jsonb_build_object(
    'renovacoes_qtd',   (select count(*) from payments
                          where tenant_id = v_tenant and payment_kind = 'renovacao_juros'
                            and renewal_cycle_id is not null
                            and received_at >= p_start and received_at < p_end),
    'renovacoes_lucro', coalesce((select sum(interest_component) from payments
                          where tenant_id = v_tenant and payment_kind = 'renovacao_juros'
                            and renewal_cycle_id is not null
                            and received_at >= p_start and received_at < p_end), 0),
    'prorrogacoes_qtd', (select count(*) from payments
                          where tenant_id = v_tenant and payment_kind = 'renovacao_juros'
                            and installment_id is not null
                            and received_at >= p_start and received_at < p_end),
    'prorrogacoes_lucro', coalesce((select sum(interest_component) from payments
                          where tenant_id = v_tenant and payment_kind = 'renovacao_juros'
                            and installment_id is not null
                            and received_at >= p_start and received_at < p_end), 0),
    'quitacoes_qtd',    (select count(*) from payments
                          where tenant_id = v_tenant and payment_kind <> 'renovacao_juros'
                            and received_at >= p_start and received_at < p_end),
    'quitacoes_lucro',  coalesce((select sum(interest_component) from payments
                          where tenant_id = v_tenant and payment_kind <> 'renovacao_juros'
                            and received_at >= p_start and received_at < p_end), 0),
    -- Contratos que já renovaram ao menos uma vez, e ciclos ainda abertos.
    'contratos_com_renovacao', (select count(distinct contract_id) from renewal_cycles where tenant_id = v_tenant),
    'ciclos_abertos',   (select count(*) from renewal_cycles
                          where tenant_id = v_tenant and status in ('pendente', 'atrasada'))
  ) into v_result;

  return v_result;
end;
$$;


create or replace function report_renewal_series(p_start date, p_end date, p_bucket text default 'mes')
returns table (periodo date, renovacoes bigint, prorrogacoes bigint, lucro numeric)
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_step interval := case when p_bucket = 'dia' then interval '1 day' else interval '1 month' end;
  v_trunc text := case when p_bucket = 'dia' then 'day' else 'month' end;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();

  return query
  select g.periodo::date,
         count(*) filter (where p.renewal_cycle_id is not null),
         count(*) filter (where p.installment_id is not null),
         coalesce(sum(p.interest_component), 0)
    from generate_series(date_trunc(v_trunc, p_start::timestamptz),
                         date_trunc(v_trunc, (p_end - 1)::timestamptz),
                         v_step) as g(periodo)
    left join payments p
      on p.tenant_id = v_tenant
     and p.payment_kind = 'renovacao_juros'
     and date_trunc(v_trunc, p.received_at at time zone 'UTC') = g.periodo
   group by g.periodo
   order by g.periodo;
end;
$$;


-- ============================================================================
-- 5. Relatório: risco da carteira
-- ============================================================================

create or replace function report_risk()
returns jsonb
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_result jsonb;
  v_carteira numeric;
  v_risco numeric;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();

  -- Carteira ativa = tudo que ainda falta receber (parcelas + ciclos em aberto),
  -- pelo saldo remanescente.
  select coalesce((select sum(greatest(0, amount_due - principal_paid_partial - interest_paid_partial))
                     from installments where tenant_id = v_tenant and status in ('pendente', 'atrasada')), 0)
       + coalesce((select sum(greatest(0, full_debt_amount - principal_paid_partial - interest_paid_partial))
                     from renewal_cycles where tenant_id = v_tenant and status in ('pendente', 'atrasada')), 0)
    into v_carteira;

  select coalesce((select sum(greatest(0, amount_due - principal_paid_partial - interest_paid_partial))
                     from installments where tenant_id = v_tenant and status = 'atrasada'), 0)
       + coalesce((select sum(greatest(0, full_debt_amount - principal_paid_partial - interest_paid_partial))
                     from renewal_cycles where tenant_id = v_tenant and status = 'atrasada'), 0)
    into v_risco;

  select jsonb_build_object(
    'carteira_ativa', v_carteira,
    'em_atraso', v_risco,
    -- Percentual da carteira que está vencida. Divisão protegida: carteira
    -- zerada devolve 0, não erro.
    'percentual_risco', case when v_carteira > 0 then round((v_risco / v_carteira) * 100, 2) else 0 end,
    'prejuizo_reconhecido', coalesce((select sum(principal_lost) from installments where tenant_id = v_tenant), 0)
                          + coalesce((select sum(principal_lost) from renewal_cycles where tenant_id = v_tenant), 0),
    'clientes_em_atraso', (select count(distinct c.client_id)
                             from installments i join loan_contracts c on c.id = i.contract_id
                            where i.tenant_id = v_tenant and i.status = 'atrasada'),
    'clientes_ativos', (select count(distinct c.client_id)
                          from loan_contracts c
                         where c.tenant_id = v_tenant and c.status in ('em_aberto', 'atrasado')),
    -- Faixas de atraso (aging): quanto tempo o dinheiro está parado.
    'aging', (
      select coalesce(jsonb_agg(jsonb_build_object('faixa', faixa, 'valor', valor, 'qtd', qtd) order by ordem), '[]'::jsonb)
        from (
          select ordem, faixa, sum(saldo) as valor, count(*) as qtd
            from (
              select greatest(0, i.amount_due - i.principal_paid_partial - i.interest_paid_partial) as saldo,
                     case
                       when current_date - i.due_date <= 15 then 1
                       when current_date - i.due_date <= 30 then 2
                       when current_date - i.due_date <= 60 then 3
                       else 4
                     end as ordem,
                     case
                       when current_date - i.due_date <= 15 then '1 a 15 dias'
                       when current_date - i.due_date <= 30 then '16 a 30 dias'
                       when current_date - i.due_date <= 60 then '31 a 60 dias'
                       else 'Mais de 60 dias'
                     end as faixa
                from installments i
               where i.tenant_id = v_tenant and i.status = 'atrasada'
            ) t
           group by ordem, faixa
        ) agg
    ),
    -- Distribuição de score da carteira (quantos clientes em cada faixa).
    'score_tiers', (
      select coalesce(jsonb_agg(jsonb_build_object('tier', score_tier, 'qtd', qtd) order by qtd desc), '[]'::jsonb)
        from (select score_tier, count(*) as qtd from clients
               where tenant_id = v_tenant and approval_status = 'aprovado'
               group by score_tier) s
    )
  ) into v_result;

  return v_result;
end;
$$;


-- ============================================================================
-- 6. Relatório: Pareto de lucro por cliente
--    Responde "quais clientes respondem pela maior parte do meu lucro".
-- ============================================================================

create or replace function report_client_pareto(p_start date, p_end date, p_limit integer default 15)
returns table (client_id uuid, client_name text, lucro numeric, recebido numeric, contratos bigint)
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();

  return query
  select c.client_id,
         coalesce(pr.full_name, 'Sem nome'),
         coalesce(sum(p.net_profit), 0),
         coalesce(sum(p.amount_received), 0),
         count(distinct c.id)
    from payments p
    join loan_contracts c on c.id = p.contract_id
    left join profiles pr on pr.id = c.client_id
   where p.tenant_id = v_tenant
     and p.received_at >= p_start and p.received_at < p_end
   group by c.client_id, pr.full_name
   having coalesce(sum(p.net_profit), 0) <> 0
   order by 3 desc
   limit least(greatest(coalesce(p_limit, 15), 1), 100);
end;
$$;


-- ============================================================================
-- 7. Relatório: tendência e projeção de lucro
--    Histórico real + projeção do que já está contratado a receber.
-- ============================================================================

create or replace function report_profit_trend(p_months_back integer default 12, p_months_ahead integer default 6)
returns table (mes date, realizado numeric, previsto numeric, futuro boolean)
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_back integer := least(greatest(coalesce(p_months_back, 12), 1), 48);
  v_ahead integer := least(greatest(coalesce(p_months_ahead, 6), 0), 24);
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();

  return query
  with meses as (
    select generate_series(
             date_trunc('month', current_date) - (v_back || ' months')::interval,
             date_trunc('month', current_date) + (v_ahead || ' months')::interval,
             interval '1 month')::date as mes
  )
  select m.mes,
         -- Realizado: lucro líquido já recebido naquele mês.
         coalesce((select sum(p.net_profit) from payments p
                    where p.tenant_id = v_tenant
                      and date_trunc('month', p.received_at at time zone 'UTC')::date = m.mes), 0),
         -- Previsto: juros ainda a receber de parcelas/ciclos que vencem no mês.
         -- É o que está CONTRATADO, não uma extrapolação estatística — por isso
         -- some nos meses sem vencimento em vez de desenhar uma reta.
         coalesce((select sum(greatest(0, i.interest_share - i.interest_paid_partial))
                     from installments i
                    where i.tenant_id = v_tenant and i.status in ('pendente', 'atrasada')
                      and date_trunc('month', i.due_date)::date = m.mes), 0)
         -- Juros a receber do ciclo. Usa a MESMA decomposição da migration_051
         -- (capital = least(capital do contrato, dívida do ciclo); juros = o
         -- resto), senão um ciclo cuja dívida já é menor que o capital geraria
         -- juros negativos e derrubaria a projeção do mês.
       + coalesce((select sum(greatest(0,
                        (rc.full_debt_amount - least(lc.principal_amount, rc.full_debt_amount))
                        - rc.interest_paid_partial))
                     from renewal_cycles rc
                     join loan_contracts lc on lc.id = rc.contract_id
                    where rc.tenant_id = v_tenant and rc.status in ('pendente', 'atrasada')
                      and date_trunc('month', rc.new_due_date)::date = m.mes), 0),
         m.mes > date_trunc('month', current_date)::date
    from meses m
   order by m.mes;
end;
$$;


-- ============================================================================
-- 8. Relatório: carteira por faixa de score e por grupo de cliente
-- ============================================================================

create or replace function report_portfolio_breakdown()
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
    -- Quanto de capital está exposto em cada faixa de score: concentrar
    -- dinheiro nos piores scores é o risco que não aparece no total.
    'por_score', (
      select coalesce(jsonb_agg(jsonb_build_object('tier', tier, 'valor', valor, 'clientes', clientes) order by valor desc), '[]'::jsonb)
        from (
          select cl.score_tier as tier,
                 sum(greatest(0, i.principal_share - i.principal_paid_partial)) as valor,
                 count(distinct cl.profile_id) as clientes
            from installments i
            join loan_contracts c on c.id = i.contract_id
            join clients cl on cl.profile_id = c.client_id
           where i.tenant_id = v_tenant and i.status in ('pendente', 'atrasada')
           group by cl.score_tier
        ) s
    ),
    'por_grupo', (
      select coalesce(jsonb_agg(jsonb_build_object('grupo', grupo, 'valor', valor, 'clientes', clientes) order by valor desc), '[]'::jsonb)
        from (
          select coalesce(nullif(cl.client_group, ''), 'Sem grupo') as grupo,
                 sum(greatest(0, i.principal_share - i.principal_paid_partial)) as valor,
                 count(distinct cl.profile_id) as clientes
            from installments i
            join loan_contracts c on c.id = i.contract_id
            join clients cl on cl.profile_id = c.client_id
           where i.tenant_id = v_tenant and i.status in ('pendente', 'atrasada')
           group by 1
        ) g
    ),
    'por_prazo', (
      select coalesce(jsonb_agg(jsonb_build_object('prazo', prazo, 'qtd', qtd, 'valor', valor) order by valor desc), '[]'::jsonb)
        from (
          select c.due_type::text as prazo, count(*) as qtd, sum(c.principal_amount) as valor
            from loan_contracts c
           where c.tenant_id = v_tenant and c.status in ('em_aberto', 'atrasado')
           group by c.due_type
        ) p
    )
  ) into v_result;

  return v_result;
end;
$$;


-- ============================================================================
-- Permissões — mesmo padrão das demais RPCs do projeto
-- ============================================================================

revoke all on function client_analytics(uuid) from public, anon;
revoke all on function client_loan_history(uuid) from public, anon;
revoke all on function client_payment_series(uuid, integer) from public, anon;
revoke all on function report_renewals(date, date) from public, anon;
revoke all on function report_renewal_series(date, date, text) from public, anon;
revoke all on function report_risk() from public, anon;
revoke all on function report_client_pareto(date, date, integer) from public, anon;
revoke all on function report_profit_trend(integer, integer) from public, anon;
revoke all on function report_portfolio_breakdown() from public, anon;

grant execute on function client_analytics(uuid) to authenticated;
grant execute on function client_loan_history(uuid) to authenticated;
grant execute on function client_payment_series(uuid, integer) to authenticated;
grant execute on function report_renewals(date, date) to authenticated;
grant execute on function report_renewal_series(date, date, text) to authenticated;
grant execute on function report_risk() to authenticated;
grant execute on function report_client_pareto(date, date, integer) to authenticated;
grant execute on function report_profit_trend(integer, integer) to authenticated;
grant execute on function report_portfolio_breakdown() to authenticated;

-- ============================================================================
-- FIM — migration_054.sql
-- ============================================================================

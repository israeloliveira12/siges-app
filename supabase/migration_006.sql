-- ============================================================================
-- MIGRATION 006 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_005)
--
-- Cobre: prazo "personalizado" (em dias) no lugar de semanal, e solicitação
-- de empréstimo passa a capturar o prazo desejado em vez do nº de parcelas.
-- ============================================================================

-- 1. Novo valor de prazo — "semanal" continua existindo no banco (não dá pra
-- remover um valor de enum, e contratos antigos podem ter usado), mas o
-- formulário não oferece mais essa opção; "personalizado" permite qualquer
-- intervalo em dias (3, 5, 10...).
alter type due_type add value if not exists 'personalizado';

-- 2. Intervalo customizado (só relevante quando due_type = 'personalizado')
alter table loan_contracts add column if not exists custom_interval_days integer;
alter table loan_requests add column if not exists requested_due_type due_type;
alter table loan_requests add column if not exists requested_custom_interval_days integer;

-- 3. Funções que calculam parcelas/renovação precisam entender o novo prazo
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

create or replace function renew_installment(
  p_source_type request_source,
  p_source_id uuid,
  p_interest_only_amount numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_notes text default null
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
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  if p_source_type = 'installment' then
    select i.contract_id, i.principal_share, i.interest_share
      into v_contract_id, v_principal, v_interest
      from installments i where i.id = p_source_id for update;
  else
    select rc.contract_id, 0, (rc.full_debt_amount - 0)
      into v_contract_id, v_principal, v_interest
      from renewal_cycles rc where rc.id = p_source_id for update;
    select rc.full_debt_amount into v_full_debt from renewal_cycles rc where rc.id = p_source_id;
    v_principal := 0;
    v_interest := v_full_debt;
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
  v_new_due_date := current_date + v_step;

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
    principal_component, interest_component,
    has_operational_fee, operational_fee_amount, received_by, notes
  ) values (
    v_contract_id, v_new_cycle_id, 'renovacao_juros', p_interest_only_amount,
    0, p_interest_only_amount,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes
  ) returning id into v_payment_id;

  update loan_contracts set status = 'em_aberto', updated_at = now()
    where id = v_contract_id and status in ('em_aberto', 'atrasado');

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body)
  values (v_client_id, 'renovacao_registrada', 'in_app', v_contract_id,
          'Renovação registrada', 'Sua dívida foi renovada. Novo vencimento: ' || v_new_due_date);

  return v_new_cycle_id;
end;
$$;

-- 4. Login por CPF: função pública (roda antes do login, então precisa ser
-- security definer) que só resolve CPF -> e-mail, nada mais sensível.
create or replace function email_for_cpf(p_cpf text)
returns text
language sql stable
security definer set search_path = public
as $$
  select email from profiles where cpf = p_cpf limit 1;
$$;

-- ============================================================================
-- FIM DA MIGRATION 006
-- ============================================================================

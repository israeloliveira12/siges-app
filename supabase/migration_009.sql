-- ============================================================================
-- MIGRATION 009 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_008)
--
-- Cobre: (1) recalcula o score do cliente automaticamente quando um contrato
-- vira "atrasado"/"perda" no cron diário, mesmo sem nenhum recebimento novo;
-- (2) encargo de atraso (juros + multa) passa a poder ser cobrado também na
-- renovação de uma parcela/ciclo já atrasado, não só na quitação.
-- ============================================================================

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

  for v_client_id in
    select distinct client_id from loan_contracts where status in ('atrasado', 'perda')
  loop
    perform recalculate_client_score(v_client_id);
  end loop;
end;
$$;

create or replace function renew_installment(
  p_source_type request_source,
  p_source_id uuid,
  p_interest_only_amount numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_notes text default null,
  p_late_charge_amount numeric default 0
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
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes
  ) values (
    v_contract_id, v_new_cycle_id, 'renovacao_juros', p_interest_only_amount + coalesce(p_late_charge_amount, 0),
    0, p_interest_only_amount + coalesce(p_late_charge_amount, 0), coalesce(p_late_charge_amount, 0),
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

-- ============================================================================
-- FIM DA MIGRATION 009
-- ============================================================================

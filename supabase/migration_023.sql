-- ============================================================================
-- MIGRATION 023 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_022)
--
-- 1) renew_installment() ganha o parâmetro p_new_due_date (opcional) — deixa
--    o gerente escolher manualmente a data do novo vencimento ao renovar, em
--    vez de sempre usar o cálculo automático (data do recebimento + prazo do
--    contrato). Se não informado, cai no cálculo automático de sempre. Como
--    isso muda a aridade da função, precisa dropar a versão antiga antes.
--
-- 2) Bug de exibição corrigido só no frontend (sem SQL): nas telas do
--    cliente ("Meus Empréstimos"/"Indicações"), ciclos de renovação que já
--    foram renovados de novo mostravam um traço em vez do badge "Renovada",
--    e o valor mostrado era a dívida cheia que rolou pro próximo ciclo em
--    vez do valor de fato pago naquela renovação (só juros). A última linha
--    (quitação final) agora aparece como "Quitação" em vez de "Renovação N".
-- ============================================================================

drop function if exists renew_installment(request_source, uuid, numeric, boolean, numeric, text, numeric, date);

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
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  if p_interest_only_amount < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if p_source_type = 'installment' then
    select i.contract_id,
           greatest(0, i.principal_share - i.principal_paid_partial),
           greatest(0, i.interest_share - i.interest_paid_partial),
           i.status
      into v_contract_id, v_principal, v_interest, v_status
      from installments i where i.id = p_source_id for update;
  else
    select rc.contract_id, 0, (rc.full_debt_amount - 0), rc.status
      into v_contract_id, v_principal, v_interest, v_status
      from renewal_cycles rc where rc.id = p_source_id for update;
    select rc.full_debt_amount into v_full_debt from renewal_cycles rc where rc.id = p_source_id;
    v_principal := 0;
    v_interest := v_full_debt;
  end if;

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
  v_new_due_date := coalesce(p_new_due_date, coalesce(p_received_at, current_date) + v_step);

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

-- ============================================================================
-- FIM DA MIGRATION 023
-- ============================================================================

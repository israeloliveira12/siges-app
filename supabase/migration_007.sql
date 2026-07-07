-- ============================================================================
-- MIGRATION 007 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_006)
--
-- Cobre: encargo de atraso (juros + multa) calculado por dia sobre o saldo da
-- parcela/ciclo em atraso, cobrado como valor extra (lucro puro) no momento do
-- recebimento — não altera o amount_due histórico das parcelas.
-- ============================================================================

alter table payments add column if not exists late_charge_amount numeric(12,2) not null default 0;

create or replace function receive_payment(
  p_installment_id uuid,
  p_amount_received numeric,
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
    has_operational_fee, operational_fee_amount, received_by, notes
  ) values (
    v_contract.id, p_installment_id, 'quitacao_parcela', p_amount_received,
    v_pay_principal, v_pay_interest + v_pay_late, v_pay_late,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes
  ) returning id into v_payment_id;

  update installments set
    principal_paid_partial = principal_paid_partial + v_pay_principal,
    interest_paid_partial = interest_paid_partial + v_pay_interest
  where id = p_installment_id;

  if v_remaining_total - p_amount_received <= 0.01 then
    update installments set status = 'paga', paid_at = now() where id = p_installment_id;

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

create or replace function receive_cycle_payment(
  p_cycle_id uuid,
  p_amount_received numeric,
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
    has_operational_fee, operational_fee_amount, received_by, notes
  ) values (
    v_contract.id, p_cycle_id, 'quitacao_final', p_amount_received,
    v_principal, v_interest + coalesce(p_late_charge_amount, 0), coalesce(p_late_charge_amount, 0),
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes
  ) returning id into v_payment_id;

  update renewal_cycles set status = 'paga', paid_at = now() where id = p_cycle_id;

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

-- ============================================================================
-- FIM DA MIGRATION 007
-- ============================================================================

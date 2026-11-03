-- ============================================================================
-- migration_056.sql — Juros da renovação em PERCENTUAL + base visível na tela
--
-- Pedido do usuário (2026-11-02):
-- 1. O campo "juros sobre o saldo" pedia reais; ele raciocina em percentual.
-- 2. Ao renovar 1.050 com 20%, a tela do contrato mostrava "capital 1.000 /
--    juros 260" — ele não reconhecia nenhum dos seus dois números (1.050 e 210).
--
-- POR QUE OS NÚMEROS DIVERGEM (e por que a contabilidade NÃO muda)
--   dívida 1.300 (1.000 de capital + 300 de juros), cliente paga 250
--   250 abate JUROS primeiro -> sobram 50 de juros + 1.000 de capital = 1.050
--   20% sobre 1.050 = 210  ->  nova dívida 1.260
--   contábil: capital 1.000, juros 260 (os 50 antigos + os 210 novos)
--   leitura do usuário: base 1.050 + 20% (210)
-- As duas somam 1.260. A diferença é onde ficam os 50 de juros não pagos.
-- Decisão do usuário: eles CONTINUAM SENDO LUCRO. Se virassem capital, uma
-- quitação de 1.260 registraria 210 de lucro em vez de 260.
--
-- Por isso `interest_base` é informativa: guarda a base da renovação para a
-- tela mostrar, sem mexer em `principal_base`, que é o que define o lucro.
-- ============================================================================

alter table renewal_cycles
  add column if not exists interest_base numeric(12,2);

comment on column renewal_cycles.interest_base is
  'Valor sobre o qual o juros deste ciclo foi aplicado (saldo no momento da renovação). INFORMATIVO, para a tela mostrar "renovado sobre X + Y%". Não participa do cálculo de capital/juros — isso é principal_base.';

-- A assinatura ganhou p_interest_percent. A versão antiga precisa sair: com as
-- duas no banco, uma chamada sem o parâmetro novo casaria com ambas e o
-- Postgres recusaria por ambiguidade.
drop function if exists receive_and_renew(request_source, uuid, numeric, numeric, date, boolean, numeric, numeric, text, date);

create or replace function receive_and_renew(
  p_source_type request_source,
  p_source_id uuid,
  p_amount_received numeric,
  p_new_interest numeric,
  p_new_due_date date,
  p_interest_percent numeric default null,
  p_has_operational_fee boolean default false,
  p_operational_fee_amount numeric default 0,
  p_late_charge_amount numeric default 0,
  p_notes text default null,
  p_received_at date default current_date
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_contract loan_contracts%rowtype;
  v_inst installments%rowtype;
  v_cycle renewal_cycles%rowtype;
  v_capital_total numeric;
  v_juros_total numeric;
  v_rem_juros numeric;
  v_rem_capital numeric;
  v_rem_total numeric;
  v_pay_juros numeric;
  v_pay_capital numeric;
  v_pay_late numeric;
  v_saldo_capital numeric;
  v_saldo_juros numeric;
  v_saldo numeric;
  v_juros_novos numeric;
  v_interest_base numeric;
  v_novo_total numeric;
  v_cycle_number integer;
  v_new_cycle_id uuid;
  v_step interval;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  perform assert_received_at_valid(p_received_at);
  v_tenant_id := current_tenant_id();

  if coalesce(p_amount_received, 0) <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if coalesce(p_new_interest, 0) < 0 or coalesce(p_late_charge_amount, 0) < 0
     or coalesce(p_interest_percent, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  -- ---- origem: parcela ou ciclo -------------------------------------------
  if p_source_type = 'installment' then
    select * into v_inst from installments
      where id = p_source_id and tenant_id = v_tenant_id for update;
    if v_inst.id is null then raise exception 'NOT_FOUND'; end if;
    if v_inst.status not in ('pendente', 'atrasada') then
      raise exception 'INSTALLMENT_NOT_PAYABLE';
    end if;
    select * into v_contract from loan_contracts where id = v_inst.contract_id for update;
    v_rem_juros   := greatest(0, v_inst.interest_share  - v_inst.interest_paid_partial);
    v_rem_capital := greatest(0, v_inst.principal_share - v_inst.principal_paid_partial);
  else
    select * into v_cycle from renewal_cycles
      where id = p_source_id and tenant_id = v_tenant_id for update;
    if v_cycle.id is null then raise exception 'NOT_FOUND'; end if;
    if v_cycle.status not in ('pendente', 'atrasada') then
      raise exception 'CYCLE_NOT_PAYABLE';
    end if;
    select * into v_contract from loan_contracts where id = v_cycle.contract_id for update;
    v_capital_total := cycle_capital(v_cycle.full_debt_amount, v_cycle.principal_base, v_contract.principal_amount);
    v_juros_total   := v_cycle.full_debt_amount - v_capital_total;
    v_rem_juros     := greatest(0, v_juros_total   - v_cycle.interest_paid_partial);
    v_rem_capital   := greatest(0, v_capital_total - v_cycle.principal_paid_partial);
  end if;

  if not coalesce(v_contract.allows_renewal, false) then
    raise exception 'RENEWAL_NOT_ALLOWED';
  end if;

  v_rem_total := v_rem_juros + v_rem_capital;

  -- Recebido acima do que se deve (+ encargo) é erro de digitação.
  if p_amount_received > v_rem_total + coalesce(p_late_charge_amount, 0) + 0.01 then
    raise exception 'INVALID_AMOUNT';
  end if;

  -- ---- decomposição do que entrou -----------------------------------------
  -- Juros primeiro, depois capital, excedente vira encargo de atraso. Mesma
  -- ordem de receive_payment/receive_cycle_payment: se cada operação abatesse
  -- numa ordem, o lucro do mesmo cliente dependeria de por qual botão o
  -- dinheiro entrou.
  v_pay_juros   := least(p_amount_received, v_rem_juros);
  v_pay_capital := least(p_amount_received - v_pay_juros, v_rem_capital);
  v_pay_late    := p_amount_received - v_pay_juros - v_pay_capital;

  v_saldo_juros   := greatest(0, v_rem_juros   - v_pay_juros);
  v_saldo_capital := greatest(0, v_rem_capital - v_pay_capital);
  v_saldo := v_saldo_juros + v_saldo_capital;

  -- Pagou tudo: não há saldo para rolar, e um ciclo precisa de dívida positiva
  -- (check da tabela). O caminho aqui é o recebimento normal.
  if v_saldo <= 0 then raise exception 'NOTHING_TO_RENEW'; end if;

  -- O percentual incide sobre o SALDO que fica (decisão do usuário,
  -- 2026-11-02): 20% sobre um saldo de 1.050 são 210. A conta é feita AQUI e
  -- não no navegador porque o saldo verdadeiro só é conhecido depois de
  -- decompor o que entrou — a tela trabalha com uma estimativa, e um centavo
  -- de diferença viraria dívida errada.
  v_juros_novos := case
    when p_interest_percent is not null then round(v_saldo * p_interest_percent / 100.0, 2)
    else coalesce(p_new_interest, 0)
  end;
  -- Base sobre a qual o juros foi aplicado. Guardada porque é como o usuário
  -- LÊ a operação ("renovei 1.050 com 20%"), enquanto capital e juros contábeis
  -- continuam sendo 1.000 e 260 — os 50 de juros não pagos que rolaram juntos
  -- seguem sendo lucro, e não podem virar capital.
  v_interest_base := v_saldo;
  v_novo_total := v_saldo + v_juros_novos;

  if p_new_due_date is null then
    v_step := case v_contract.due_type
      when 'mensal' then interval '1 month'
      when 'quinzenal' then interval '15 days'
      when 'semanal' then interval '7 days'
      when 'personalizado' then (coalesce(v_contract.custom_interval_days, 30) || ' days')::interval
    end;
    p_new_due_date := (coalesce(p_received_at, current_date) + v_step)::date;
  end if;
  if p_new_due_date <= coalesce(p_received_at, current_date) then
    raise exception 'NEW_DUE_DATE_NOT_FUTURE';
  end if;

  -- ---- registra o que ENTROU ----------------------------------------------
  -- payment_kind 'quitacao_parcela': é amortização de verdade, dinheiro que
  -- entrou no caixa. Os juros NOVOS (p_new_interest) NÃO viram pagamento aqui —
  -- eles entram na dívida do ciclo e só viram lucro quando forem pagos. Era
  -- exatamente isso que o jeito antigo (dar baixa cheia) quebrava.
  insert into payments (
    contract_id, installment_id, renewal_cycle_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract.id,
    case when p_source_type = 'installment' then p_source_id else null end,
    case when p_source_type = 'renewal_cycle' then p_source_id else null end,
    'quitacao_parcela', p_amount_received,
    v_pay_capital, v_pay_juros + v_pay_late, v_pay_late,
    coalesce(p_has_operational_fee, false), coalesce(p_operational_fee_amount, 0),
    auth.uid(), p_notes, coalesce(p_received_at, current_date), v_tenant_id
  );

  -- ---- rola o saldo --------------------------------------------------------
  select coalesce(max(cycle_number), 0) + 1 into v_cycle_number
    from renewal_cycles where contract_id = v_contract.id;

  insert into renewal_cycles (
    contract_id, cycle_number, origin_installment_id, previous_cycle_id,
    interest_only_amount, full_debt_amount, principal_base, interest_base, new_due_date, created_by, tenant_id
  ) values (
    v_contract.id, v_cycle_number,
    case when p_source_type = 'installment' then p_source_id else null end,
    case when p_source_type = 'renewal_cycle' then p_source_id else null end,
    -- interest_only_amount = o que o cliente pagaria para rolar de novo só os
    -- juros no próximo vencimento.
    v_juros_novos,
    v_novo_total,
    -- A base de capital do novo ciclo é o capital que SOBROU, não o do
    -- contrato: é isso que mantém a decomposição correta daqui para frente.
    v_saldo_capital,
    v_interest_base,
    p_new_due_date, auth.uid(), v_tenant_id
  ) returning id into v_new_cycle_id;

  -- ---- fecha a origem ------------------------------------------------------
  if p_source_type = 'installment' then
    update installments set
      status = 'renovada',
      renewed_into_cycle_id = v_new_cycle_id,
      principal_paid_partial = principal_paid_partial + v_pay_capital,
      interest_paid_partial  = interest_paid_partial  + v_pay_juros
    where id = p_source_id;
  else
    update renewal_cycles set
      status = 'renovada',
      principal_paid_partial = principal_paid_partial + v_pay_capital,
      interest_paid_partial  = interest_paid_partial  + v_pay_juros
    where id = p_source_id;
  end if;

  update loan_contracts set status = 'em_aberto', updated_at = now()
    where id = v_contract.id and status in ('em_aberto', 'atrasado', 'perda');

  perform recompute_contract_status(v_contract.id);

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (v_contract.client_id, 'renovacao_registrada', 'in_app', v_contract.id,
          'Pagamento parcial e renovação',
          'Recebemos ' || fmt_brl(p_amount_received) || ' do contrato #' || v_contract.contract_number ||
          '. O saldo de ' || fmt_brl(v_novo_total) || ' vence em ' ||
          to_char(p_new_due_date, 'DD/MM/YYYY') || '.', v_tenant_id);

  return v_new_cycle_id;
end;
$$;

revoke all on function receive_and_renew(request_source, uuid, numeric, numeric, date, numeric, boolean, numeric, numeric, text, date) from public, anon;
grant execute on function receive_and_renew(request_source, uuid, numeric, numeric, date, numeric, boolean, numeric, numeric, text, date) to authenticated;

-- ============================================================================
-- FIM — migration_056.sql
-- ============================================================================

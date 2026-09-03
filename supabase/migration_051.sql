-- ============================================================================
-- migration_051.sql — Pagamento parcial em ciclo de renovação
--
-- Pedido do usuário: receber um valor menor que o total num ciclo de
-- renovação. Hoje a tela recusa com "Ciclos de renovação não têm controle de
-- pagamento parcial — informe o valor cheio para quitar".
--
-- Essa trava NÃO era arbitrária: `renewal_cycles` nunca teve as colunas
-- principal_paid_partial/interest_paid_partial que `installments` tem, então
-- um valor menor era aceito e o ciclo/contrato eram marcados como QUITADOS do
-- mesmo jeito, inflando o lucro nos relatórios (que gravavam o valor cheio
-- esperado, não o que realmente entrou). A trava foi o remendo correto para
-- aquele bug. Esta migration resolve a causa: dá ao ciclo o mesmo controle de
-- parcial que a parcela já tem.
--
-- SEGURANÇA DA MUDANÇA: as duas colunas nascem com default 0, então todo
-- ciclo existente calcula exatamente como antes — `full_debt_amount - 0 - 0`.
-- Nada no sistema muda de comportamento até alguém de fato registrar um
-- pagamento parcial.
--
-- Decomposição da dívida de um ciclo (usada em tudo abaixo):
--   capital = least(contrato.principal_amount, full_debt_amount)
--   juros   = full_debt_amount - capital
-- O `least` existe porque um ciclo pode nascer com dívida MENOR que o capital
-- do contrato (ao renovar um ciclo já parcialmente pago — ver bloco 5), e sem
-- ele os juros virariam negativos e o pagamento entraria como prejuízo.
-- ============================================================================


-- ============================================================================
-- 1. As colunas
-- ============================================================================

alter table renewal_cycles
  add column if not exists principal_paid_partial numeric(12,2) not null default 0,
  add column if not exists interest_paid_partial  numeric(12,2) not null default 0;

comment on column renewal_cycles.principal_paid_partial is
  'Capital já recebido em pagamento(s) parcial(is) deste ciclo. Espelha installments.principal_paid_partial (migration_051).';
comment on column renewal_cycles.interest_paid_partial is
  'Juros já recebidos em pagamento(s) parcial(is) deste ciclo. Espelha installments.interest_paid_partial (migration_051).';


-- ============================================================================
-- 2. Saldo remanescente de um ciclo — uma função só, reusada por todo lugar
--
-- Existe para que a regra não fique copiada em oito consultas diferentes: se
-- um dia a decomposição mudar, muda aqui.
-- ============================================================================

create or replace function cycle_remaining(p_cycle renewal_cycles)
returns numeric
language sql immutable
as $$
  select greatest(0, p_cycle.full_debt_amount
                     - p_cycle.principal_paid_partial
                     - p_cycle.interest_paid_partial);
$$;


-- ============================================================================
-- 3. receive_cycle_payment() — aceita parcial
--
-- Espelha receive_payment() (o caminho das parcelas), que já resolve isso há
-- muito tempo: paga JUROS primeiro, depois capital, e o que passar do saldo
-- contratual é encargo de atraso. A parcela/ciclo só vira 'paga' quando o
-- restante chega a zero.
-- ============================================================================

create or replace function receive_cycle_payment(
  p_cycle_id uuid,
  p_amount_received numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_notes text default null,
  p_late_charge_amount numeric default 0,
  p_received_at date default current_date
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_cycle renewal_cycles%rowtype;
  v_contract loan_contracts%rowtype;
  v_capital_total numeric;
  v_juros_total numeric;
  v_remaining_interest numeric;
  v_remaining_principal numeric;
  v_remaining_total numeric;
  v_max_allowed numeric;
  v_pay_interest numeric;
  v_pay_principal numeric;
  v_pay_late numeric;
  v_after_interest numeric;
  v_payment_id uuid;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  perform assert_received_at_valid(p_received_at);

  v_tenant_id := current_tenant_id();

  select * into v_cycle from renewal_cycles where id = p_cycle_id and tenant_id = v_tenant_id for update;
  if v_cycle.id is null then
    raise exception 'NOT_FOUND';
  end if;
  if v_cycle.status not in ('pendente', 'atrasada') then
    raise exception 'CYCLE_NOT_PAYABLE';
  end if;

  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  select * into v_contract from loan_contracts where id = v_cycle.contract_id for update;

  -- Decomposição da dívida do ciclo. `least` protege o caso de um ciclo que
  -- nasceu com dívida menor que o capital do contrato (renovação de ciclo
  -- parcialmente pago) — sem ele, v_juros_total ficaria negativo e o
  -- pagamento entraria nos relatórios como prejuízo, silenciosamente.
  v_capital_total := least(coalesce(v_contract.principal_amount, 0), v_cycle.full_debt_amount);
  v_juros_total := v_cycle.full_debt_amount - v_capital_total;

  v_remaining_interest := greatest(0, v_juros_total - v_cycle.interest_paid_partial);
  v_remaining_principal := greatest(0, v_capital_total - v_cycle.principal_paid_partial);
  v_remaining_total := v_remaining_interest + v_remaining_principal;
  -- Encargo de atraso é cobrado POR CIMA do saldo do ciclo e não entra no
  -- controle de parcial — mesma regra de receive_payment().
  v_max_allowed := v_remaining_total + coalesce(p_late_charge_amount, 0);

  if p_amount_received <= 0 or p_amount_received > v_max_allowed + 0.01 then
    raise exception 'INVALID_AMOUNT';
  end if;

  -- Juros primeiro, depois capital, e o excedente é encargo de atraso.
  v_pay_interest := least(p_amount_received, v_remaining_interest);
  v_after_interest := p_amount_received - v_pay_interest;
  v_pay_principal := least(v_after_interest, v_remaining_principal);
  v_pay_late := v_after_interest - v_pay_principal;

  insert into payments (
    contract_id, renewal_cycle_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract.id, p_cycle_id, 'quitacao_final', p_amount_received,
    v_pay_principal, v_pay_interest + v_pay_late, v_pay_late,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date), v_tenant_id
  ) returning id into v_payment_id;

  update renewal_cycles set
    principal_paid_partial = principal_paid_partial + v_pay_principal,
    interest_paid_partial = interest_paid_partial + v_pay_interest
  where id = p_cycle_id;

  if v_remaining_total - p_amount_received <= 0.01 then
    update renewal_cycles set status = 'paga', paid_at = coalesce(p_received_at, current_date) where id = p_cycle_id;
    perform recompute_contract_status(v_contract.id);

    insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
    values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id,
            'Pagamento recebido',
            'Recebemos seu pagamento de ' || fmt_brl(p_amount_received) || '. Contrato #' || v_contract.contract_number || ' quitado.', v_tenant_id);
  else
    insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
    values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id,
            'Pagamento parcial recebido',
            'Recebemos ' || fmt_brl(p_amount_received) || '. Restam ' ||
            fmt_brl(round(v_remaining_total - p_amount_received, 2)) || ' desta renovação.', v_tenant_id);
  end if;

  return v_payment_id;
end;
$$;


-- ============================================================================
-- 4. Saldo devedor do cliente passa a descontar o parcial do ciclo
--
-- Sem isto, o cliente que pagou metade continuaria vendo (e consumindo do
-- limite de crédito) a dívida cheia.
-- ============================================================================

create or replace function client_outstanding_balance(p_client_id uuid)
returns numeric
language plpgsql stable
security definer set search_path = public
as $$
begin
  if not (
    (is_gerente() and exists(select 1 from clients where profile_id = p_client_id and tenant_id = current_tenant_id()))
    or auth.uid() = p_client_id
  ) then
    raise exception 'FORBIDDEN';
  end if;

  return (select coalesce(sum(
    case
      when exists (
        select 1 from renewal_cycles rc
        where rc.contract_id = lc.id and rc.status in ('pendente','atrasada')
      )
      then (
        -- migration_051: desconta o que já foi recebido em parcial.
        select greatest(0, rc.full_debt_amount - rc.principal_paid_partial - rc.interest_paid_partial)
        from renewal_cycles rc
        where rc.contract_id = lc.id and rc.status in ('pendente','atrasada')
        order by rc.cycle_number desc limit 1
      )
      else (
        select coalesce(sum(i.amount_due - i.principal_paid_partial - i.interest_paid_partial), 0) from installments i
        where i.contract_id = lc.id and i.status in ('pendente','atrasada')
      )
    end
  ), 0)
  from loan_contracts lc
  where lc.client_id = p_client_id
    and lc.status in ('em_aberto', 'atrasado'));
end;
$$;

create or replace function client_outstanding_principal(p_client_id uuid)
returns numeric
language plpgsql stable
security definer set search_path = public
as $$
begin
  if not (
    (is_gerente() and exists(select 1 from clients where profile_id = p_client_id and tenant_id = current_tenant_id()))
    or auth.uid() = p_client_id
  ) then
    raise exception 'FORBIDDEN';
  end if;

  return (select coalesce(sum(
    case
      when exists (
        select 1 from renewal_cycles rc
        where rc.contract_id = lc.id and rc.status in ('pendente','atrasada')
      )
      -- Renovação não abate capital, então o capital consumido continua sendo
      -- o principal_amount do contrato — MENOS o que um pagamento parcial já
      -- tenha amortizado (migration_051).
      then greatest(0, lc.principal_amount - coalesce((
        select rc.principal_paid_partial from renewal_cycles rc
        where rc.contract_id = lc.id and rc.status in ('pendente','atrasada')
        order by rc.cycle_number desc limit 1
      ), 0))
      else (
        select coalesce(sum(i.principal_share - i.principal_paid_partial), 0) from installments i
        where i.contract_id = lc.id and i.status in ('pendente','atrasada')
      )
    end
  ), 0)
  from loan_contracts lc
  where lc.client_id = p_client_id
    and lc.status in ('em_aberto', 'atrasado'));
end;
$$;


-- ============================================================================
-- 5. Renovar um ciclo parcialmente pago rola só o SALDO
--
-- Mesma regra que renew_installment() já aplica quando a origem é uma
-- PARCELA: `greatest(0, share - paid_partial)`. Sem isto, renovar um ciclo
-- com R$200 já pagos recriaria a dívida cheia e o valor pago sumiria do
-- saldo do cliente — exatamente o bug que a versão de parcela já corrigiu.
-- ============================================================================

create or replace function renew_installment(
  p_source_type request_source,
  p_source_id uuid,
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
  v_contract_number integer;
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
  v_installments_count integer;
  v_allows_renewal boolean;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  perform assert_received_at_valid(p_received_at);

  v_tenant_id := current_tenant_id();

  if p_interest_only_amount < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if p_source_type = 'installment' then
    select i.contract_id,
           greatest(0, i.principal_share - i.principal_paid_partial),
           greatest(0, i.interest_share - i.interest_paid_partial),
           i.status
      into v_contract_id, v_principal, v_interest, v_status
      from installments i where i.id = p_source_id and i.tenant_id = v_tenant_id for update;
  else
    -- migration_051: o saldo que rola é o REMANESCENTE, não a dívida cheia.
    select rc.contract_id, rc.status,
           greatest(0, rc.full_debt_amount - rc.principal_paid_partial - rc.interest_paid_partial)
      into v_contract_id, v_status, v_full_debt
      from renewal_cycles rc where rc.id = p_source_id and rc.tenant_id = v_tenant_id for update;
    v_principal := 0;
    v_interest := v_full_debt;
  end if;

  if v_contract_id is null then
    raise exception 'NOT_FOUND';
  end if;

  if v_status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  select lc.due_type, lc.client_id, lc.custom_interval_days, lc.installments_count, lc.allows_renewal, lc.contract_number
    into v_due_type, v_client_id, v_custom_days, v_installments_count, v_allows_renewal, v_contract_number
    from loan_contracts lc where lc.id = v_contract_id for update;

  if v_installments_count <> 1 or not coalesce(v_allows_renewal, false) then
    raise exception 'RENEWAL_NOT_ALLOWED';
  end if;

  v_full_debt := coalesce(v_full_debt, v_principal + v_interest);

  -- Um ciclo precisa de dívida positiva (check da tabela). Se o saldo já foi
  -- todo pago, não há o que renovar — quitar é o caminho.
  if v_full_debt <= 0 then
    raise exception 'NOTHING_TO_RENEW';
  end if;

  v_step := case v_due_type
    when 'mensal' then interval '1 month'
    when 'quinzenal' then interval '15 days'
    when 'semanal' then interval '7 days'
    when 'personalizado' then (coalesce(v_custom_days, 30) || ' days')::interval
  end;
  v_new_due_date := coalesce(p_new_due_date, coalesce(p_received_at, current_date) + v_step);

  if v_new_due_date <= coalesce(p_received_at, current_date) then
    raise exception 'NEW_DUE_DATE_NOT_FUTURE';
  end if;

  select coalesce(max(cycle_number), 0) + 1 into v_cycle_number
    from renewal_cycles where contract_id = v_contract_id;

  insert into renewal_cycles (
    contract_id, cycle_number, origin_installment_id, previous_cycle_id,
    interest_only_amount, full_debt_amount, new_due_date, created_by, tenant_id
  ) values (
    v_contract_id, v_cycle_number,
    case when p_source_type = 'installment' then p_source_id else null end,
    case when p_source_type = 'renewal_cycle' then p_source_id else null end,
    p_interest_only_amount, v_full_debt, v_new_due_date, auth.uid(), v_tenant_id
  ) returning id into v_new_cycle_id;

  if p_source_type = 'installment' then
    update installments set status = 'renovada', renewed_into_cycle_id = v_new_cycle_id where id = p_source_id;
  else
    update renewal_cycles set status = 'renovada' where id = p_source_id;
  end if;

  insert into payments (
    contract_id, renewal_cycle_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract_id, v_new_cycle_id, 'renovacao_juros', p_interest_only_amount + coalesce(p_late_charge_amount, 0),
    0, p_interest_only_amount + coalesce(p_late_charge_amount, 0), coalesce(p_late_charge_amount, 0),
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date), v_tenant_id
  ) returning id into v_payment_id;

  update loan_contracts set status = 'em_aberto', updated_at = now()
    where id = v_contract_id and status in ('em_aberto', 'atrasado', 'perda');

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (v_client_id, 'renovacao_registrada', 'in_app', v_contract_id,
          'Renovação registrada',
          'Sua dívida do contrato #' || v_contract_number || ' foi renovada. Novo vencimento: ' ||
          to_char(v_new_due_date, 'DD/MM/YYYY') || '.', v_tenant_id);

  return v_new_cycle_id;
end;
$$;


-- ============================================================================
-- 6. Perda de ciclo desconta o capital já amortizado
--
-- mark_cycle_loss() gravava principal_lost = capital cheio do contrato. Com
-- parcial, parte desse capital já voltou ao caixa e não pode ser abatida do
-- lucro como perdida — mesmo cuidado que mark_installment_loss() já toma com
-- `greatest(0, principal_share - principal_paid_partial)`.
-- ============================================================================

create or replace function mark_cycle_loss(p_cycle_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_cycle renewal_cycles%rowtype;
  v_principal numeric;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  select * into v_cycle from renewal_cycles where id = p_cycle_id and tenant_id = current_tenant_id() for update;
  if v_cycle.id is null then raise exception 'NOT_FOUND'; end if;
  if v_cycle.status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  select principal_amount into v_principal from loan_contracts where id = v_cycle.contract_id;

  update renewal_cycles set
    status = 'perda',
    principal_lost = greatest(0, least(coalesce(v_principal, 0), v_cycle.full_debt_amount) - v_cycle.principal_paid_partial),
    loss_recognized_at = now()
  where id = p_cycle_id;

  perform recompute_contract_status(v_cycle.contract_id);
end;
$$;


-- ============================================================================
-- 7. update_cycle_schedule() — não deixa o total cair abaixo do já pago
--
-- Mesma proteção que update_installment_schedule() tem
-- (AMOUNT_BELOW_ALREADY_PAID): sem isto, editar o total para menos do que já
-- entrou deixaria o saldo negativo.
-- ============================================================================

create or replace function update_cycle_schedule(
  p_cycle_id uuid,
  p_new_due_date date,
  p_full_debt_amount numeric
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_cycle renewal_cycles%rowtype;
  v_principal numeric;
  v_ja_pago numeric;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_cycle from renewal_cycles
    where id = p_cycle_id and tenant_id = current_tenant_id()
    for update;
  if v_cycle.id is null then
    raise exception 'NOT_FOUND';
  end if;

  if p_new_due_date is null then
    raise exception 'INVALID_DATE';
  end if;
  if p_full_debt_amount is null or p_full_debt_amount <= 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  -- migration_051: o novo total não pode ficar abaixo do que já foi recebido.
  v_ja_pago := v_cycle.principal_paid_partial + v_cycle.interest_paid_partial;
  if p_full_debt_amount < v_ja_pago then
    raise exception 'AMOUNT_BELOW_ALREADY_PAID';
  end if;

  -- receive_cycle_payment() decompõe a dívida como capital = least(capital do
  -- contrato, total do ciclo). Com o `least` no lugar, um total abaixo do
  -- capital não gera mais juros negativos — mas continua sendo um sinal de
  -- erro de digitação quando NÃO houve pagamento parcial nenhum.
  select principal_amount into v_principal
    from loan_contracts where id = v_cycle.contract_id;
  if v_ja_pago = 0 and p_full_debt_amount < coalesce(v_principal, 0) then
    raise exception 'AMOUNT_BELOW_PRINCIPAL';
  end if;

  update renewal_cycles set
    new_due_date = p_new_due_date,
    full_debt_amount = p_full_debt_amount,
    status = case
      when status in ('pendente', 'atrasada')
        then (case when p_new_due_date < current_date then 'atrasada' else 'pendente' end)::installment_status
      else status
    end
  where id = p_cycle_id;

  perform recompute_contract_status(v_cycle.contract_id);
end;
$$;


-- ============================================================================
-- 8. Agregados e fila de avisos passam a usar o saldo remanescente
-- ============================================================================

create or replace function dashboard_totals()
returns jsonb
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_today date := current_date;
  v_month_start date := date_trunc('month', current_date)::date;
  v_prev_start date := date_trunc('month', current_date - interval '1 month')::date;
  v_prev_end date;
  v_result jsonb;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();
  v_prev_end := least(
    v_prev_start + (v_today - v_month_start),
    (date_trunc('month', v_prev_start) + interval '1 month')::date - 1
  );

  select jsonb_build_object(
    'recebido_hoje', coalesce((select sum(amount_received) from payments
      where tenant_id = v_tenant and received_at >= v_today and received_at < v_today + 1), 0),
    'recebido_mes', coalesce((select sum(amount_received) from payments
      where tenant_id = v_tenant and received_at >= v_month_start and received_at < v_today + 1), 0),
    'lucro_mes', coalesce((select sum(net_profit) from payments
      where tenant_id = v_tenant and received_at >= v_month_start and received_at < v_today + 1), 0),
    'lucro_prev', coalesce((select sum(net_profit) from payments
      where tenant_id = v_tenant and received_at >= v_prev_start and received_at < v_prev_end + 1), 0),
    'taxa_entrada_mes', coalesce((select sum(operational_fee_amount) from payments
      where tenant_id = v_tenant and has_operational_fee
        and received_at >= v_month_start and received_at < v_today + 1), 0),
    'taxa_saida_mes', coalesce((select sum(operational_fee_amount) from loan_contracts
      where tenant_id = v_tenant and has_operational_fee
        and contract_date >= v_month_start and contract_date <= v_today), 0),
    'taxa_saida_prev', coalesce((select sum(operational_fee_amount) from loan_contracts
      where tenant_id = v_tenant and has_operational_fee
        and contract_date >= v_prev_start and contract_date <= v_prev_end), 0),
    'perda_mes', coalesce((select sum(principal_lost) from installments
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= v_month_start and loss_recognized_at < v_today + 1), 0)
      + coalesce((select sum(principal_lost) from renewal_cycles
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= v_month_start and loss_recognized_at < v_today + 1), 0),
    'perda_prev', coalesce((select sum(principal_lost) from installments
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= v_prev_start and loss_recognized_at < v_prev_end + 1), 0)
      + coalesce((select sum(principal_lost) from renewal_cycles
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= v_prev_start and loss_recognized_at < v_prev_end + 1), 0),
    'contratos_em_aberto', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and status = 'em_aberto'), 0),
    'contratos_atrasado', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and status = 'atrasado'), 0),
    'contratos_quitado', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and status = 'quitado'), 0),
    'contratos_perda', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and status = 'perda'), 0),
    'contratos_novos_mes', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and contract_date >= v_month_start and contract_date <= v_today), 0),
    'capital_na_rua', coalesce((select sum(principal_amount) from loan_contracts
      where tenant_id = v_tenant and status in ('em_aberto', 'atrasado')), 0),
    'a_receber_mes', coalesce((select sum(amount_due - principal_paid_partial - interest_paid_partial)
      from installments
      where tenant_id = v_tenant and status in ('pendente', 'atrasada')
        and due_date >= v_month_start and due_date < v_month_start + interval '1 month'), 0)
      -- migration_051: desconta o parcial do ciclo também.
      + coalesce((select sum(greatest(0, full_debt_amount - principal_paid_partial - interest_paid_partial))
      from renewal_cycles
      where tenant_id = v_tenant and status in ('pendente', 'atrasada')
        and new_due_date >= v_month_start and new_due_date < v_month_start + interval '1 month'), 0),
    'vencidos_count', coalesce((select count(*) from installments
      where tenant_id = v_tenant and status in ('pendente', 'atrasada') and due_date <= v_today), 0)
      + coalesce((select count(*) from renewal_cycles
      where tenant_id = v_tenant and status in ('pendente', 'atrasada') and new_due_date <= v_today), 0),
    'solicitacoes_pendentes', coalesce((select count(*) from loan_requests
      where tenant_id = v_tenant and status = 'pendente'), 0)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function pending_due_notifications(p_limit integer default 500)
returns table (
  kind text,
  ref_id uuid,
  contract_id uuid,
  contract_number integer,
  client_id uuid,
  client_email text,
  event text,
  amount numeric,
  due_date date
)
language plpgsql stable
security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN';
  end if;

  return query
  with base as (
    select 'installment'::text as kind, i.id as ref_id, i.contract_id,
           lc.contract_number, lc.client_id, p.email as client_email,
           case
             when i.due_date < current_date then 'atrasada'
             when i.due_date = current_date then 'vence_hoje'
             else 'vence_amanha'
           end as event,
           (i.amount_due - i.principal_paid_partial - i.interest_paid_partial) as amount,
           i.due_date
    from installments i
    join loan_contracts lc on lc.id = i.contract_id
    join profiles p on p.id = lc.client_id
    join tenants t on t.id = i.tenant_id and t.active
    where i.status in ('pendente', 'atrasada')
      and i.due_date <= current_date + 1

    union all

    select 'cycle'::text, rc.id, rc.contract_id,
           lc.contract_number, lc.client_id, p.email,
           case
             when rc.new_due_date < current_date then 'atrasada'
             when rc.new_due_date = current_date then 'vence_hoje'
             else 'vence_amanha'
           end,
           -- migration_051: avisa o cliente do que ele AINDA deve, não do
           -- valor cheio que ele já pagou em parte.
           greatest(0, rc.full_debt_amount - rc.principal_paid_partial - rc.interest_paid_partial),
           rc.new_due_date
    from renewal_cycles rc
    join loan_contracts lc on lc.id = rc.contract_id
    join profiles p on p.id = lc.client_id
    join tenants t on t.id = rc.tenant_id and t.active
    where rc.status in ('pendente', 'atrasada')
      and rc.new_due_date <= current_date + 1
  )
  select b.kind, b.ref_id, b.contract_id, b.contract_number, b.client_id,
         b.client_email, b.event, b.amount, b.due_date
  from base b
  where not exists (
    select 1 from notifications_log n
    where n.recipient_id = b.client_id
      and n.event::text = b.event
      and n.sent_at >= current_date
      and (
        (b.kind = 'installment' and n.related_installment_id = b.ref_id)
        or (b.kind = 'cycle' and n.related_contract_id = b.contract_id and n.related_installment_id is null)
      )
  )
  order by b.due_date asc
  limit greatest(p_limit, 1);
end;
$$;


-- ============================================================================
-- FIM — migration_051.sql
-- ============================================================================

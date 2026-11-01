-- ============================================================================
-- migration_055.sql — Receber uma parte e renovar o saldo, numa operação só
--
-- Pedido do usuário (2026-11-01): o cliente empresta 600 para pagar 800; no dia
-- ele paga 400 e pede para rolar o que falta para o próximo ciclo, com juros
-- novos sobre o saldo. Hoje o caminho é dar RECEBIDO NO VALOR CHEIO (dinheiro
-- que não entrou) e abrir um empréstimo novo — o que infla o lucro do dia,
-- melhora o score do cliente sem motivo e inventa uma quitação no histórico.
--
-- Aqui a operação passa a ser uma só: recebe o que entrou DE VERDADE (parcial)
-- e rola o saldo num ciclo de renovação. Nada de dinheiro fantasma.
--
-- O QUE ESTA MIGRATION PRECISOU RESOLVER ANTES (principal_base)
-- O ciclo não guardava quanto dele é capital: a decomposição era
-- `capital = least(capital do contrato, dívida do ciclo)`. Isso funciona
-- enquanto a dívida rola inteira, mas quebra depois de uma amortização:
--   contrato 600 de capital, dívida 800 (600 + 200 de juros)
--   cliente paga 400  -> quita os 200 de juros e amortiza 200 de capital
--   saldo 400 (todo capital) + 100 de juros novos = ciclo de 500
--   pela regra antiga: capital = least(600, 500) = 500  ->  juros = ZERO
-- Ou seja: os 100 de lucro sumiriam dos relatórios, o pagamento seguinte
-- abateria capital antes de juros, e mark_cycle_loss registraria 500 de perda
-- em vez de 400. Por isso o ciclo passa a poder declarar a própria base.
--
-- RETROCOMPATÍVEL: a coluna nasce NULL e `cycle_capital()` cai na regra antiga
-- quando ela é nula. Nenhum ciclo existente muda de comportamento.
-- ============================================================================

alter table renewal_cycles
  add column if not exists principal_base numeric(12,2);

comment on column renewal_cycles.principal_base is
  'Quanto da dívida deste ciclo é CAPITAL. NULL = usar a regra antiga (capital do contrato limitado à dívida do ciclo). Preenchido quando o ciclo nasce de uma amortização parcial, onde o capital remanescente é menor que o do contrato.';


-- ============================================================================
-- Regra única de decomposição do ciclo
--
-- Existe como função para a regra morar em UM lugar: ela é usada no
-- recebimento, na perda, na edição, na renovação e na projeção de lucro, e
-- essas cinco discordarem entre si é a forma mais silenciosa de errar dinheiro.
-- Pura aritmética sobre os valores recebidos — não lê tabela, não precisa de
-- guarda de permissão.
-- ============================================================================

create or replace function cycle_capital(
  p_full_debt numeric,
  p_principal_base numeric,
  p_contract_principal numeric
)
returns numeric
language sql
immutable
as $$
  select greatest(0, least(
    coalesce(p_principal_base, coalesce(p_contract_principal, 0)),
    coalesce(p_full_debt, 0)
  ));
$$;

-- ============================================================================
-- Funções que decompõem o ciclo, agora passando por cycle_capital()
-- (extraídas do schema atual e alteradas só no ponto da decomposição)
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
  -- migration_055: principal_base, quando preenchido, diz qual parte do ciclo
  -- e capital. Ciclos antigos tem null e caem na regra de sempre.
  v_capital_total := cycle_capital(v_cycle.full_debt_amount, v_cycle.principal_base, v_contract.principal_amount);
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
    principal_lost = greatest(0, cycle_capital(v_cycle.full_debt_amount, v_cycle.principal_base, v_principal) - v_cycle.principal_paid_partial),
    loss_recognized_at = now()
  where id = p_cycle_id;

  perform recompute_contract_status(v_cycle.contract_id);
end;
$$;

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
  -- migration_055: num ciclo nascido de amortizacao (principal_base definido)
  -- o capital e MENOR que o do contrato, e comparar com o do contrato
  -- recusaria um total legitimo.
  if v_ja_pago = 0 and p_full_debt_amount < coalesce(v_cycle.principal_base, v_principal, 0) then
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
                        (rc.full_debt_amount - cycle_capital(rc.full_debt_amount, rc.principal_base, lc.principal_amount))
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
    -- migration_055: ao renovar um CICLO, o capital remanescente dele
    -- precisa acompanhar para o novo ciclo, senao a cadeia perde a
    -- informacao e volta a decompor pelo capital do contrato.
    select cycle_capital(rc.full_debt_amount, rc.principal_base, lc.principal_amount) - rc.principal_paid_partial
      into v_principal
      from renewal_cycles rc join loan_contracts lc on lc.id = rc.contract_id
     where rc.id = p_source_id;
    v_principal := greatest(0, coalesce(v_principal, 0));
    v_interest := greatest(0, v_full_debt - v_principal);
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
    interest_only_amount, full_debt_amount, new_due_date, principal_base, created_by, tenant_id
  ) values (
    v_contract_id, v_cycle_number,
    case when p_source_type = 'installment' then p_source_id else null end,
    case when p_source_type = 'renewal_cycle' then p_source_id else null end,
    p_interest_only_amount, v_full_debt, v_new_due_date,
    case when p_source_type = 'renewal_cycle' then v_principal else null end,
    auth.uid(), v_tenant_id
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
-- Receber uma parte e renovar o saldo
--
-- Uma transação: ou o recebimento e a renovação acontecem juntos, ou nenhum
-- dos dois. Em duas operações separadas (receber, depois renovar), uma queda
-- no meio deixaria o cliente com o pagamento registrado e a dívida sem rolar.
-- ============================================================================

create or replace function receive_and_renew(
  p_source_type request_source,
  p_source_id uuid,
  p_amount_received numeric,
  p_new_interest numeric,
  p_new_due_date date,
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
  v_novo_total numeric;
  v_cycle_number integer;
  v_new_cycle_id uuid;
  v_step interval;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  perform assert_received_at_valid(p_received_at);
  v_tenant_id := current_tenant_id();

  if coalesce(p_amount_received, 0) <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if coalesce(p_new_interest, 0) < 0 or coalesce(p_late_charge_amount, 0) < 0 then
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

  v_novo_total := v_saldo + coalesce(p_new_interest, 0);

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
    interest_only_amount, full_debt_amount, principal_base, new_due_date, created_by, tenant_id
  ) values (
    v_contract.id, v_cycle_number,
    case when p_source_type = 'installment' then p_source_id else null end,
    case when p_source_type = 'renewal_cycle' then p_source_id else null end,
    -- interest_only_amount = o que o cliente pagaria para rolar de novo só os
    -- juros no próximo vencimento.
    coalesce(p_new_interest, 0),
    v_novo_total,
    -- A base de capital do novo ciclo é o capital que SOBROU, não o do
    -- contrato: é isso que mantém a decomposição correta daqui para frente.
    v_saldo_capital,
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


revoke all on function cycle_capital(numeric, numeric, numeric) from public, anon;
grant execute on function cycle_capital(numeric, numeric, numeric) to authenticated;
revoke all on function receive_and_renew(request_source, uuid, numeric, numeric, date, boolean, numeric, numeric, text, date) from public, anon;
grant execute on function receive_and_renew(request_source, uuid, numeric, numeric, date, boolean, numeric, numeric, text, date) to authenticated;

-- ============================================================================
-- FIM — migration_055.sql
-- ============================================================================

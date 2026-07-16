-- Migration 026: bateria de QA em empréstimos/contratos/renovações/parcelas/
-- lucro/taxas — 11 achados corrigidos (nenhuma mudança de assinatura de
-- função, todos os create or replace substituem a versão anterior direto).

-- QA-1 e QA-2: renew_installment agora valida no SERVIDOR que o contrato é
-- de parcela única com renovação habilitada (antes só a UI escondia o botão
-- — uma chamada direta à RPC conseguia renovar qualquer contrato), e a
-- reabertura do contrato pra 'em_aberto' agora inclui o status 'perda'
-- (antes um contrato em cobrança que recebia uma renovação ficava invisível
-- pro limite de crédito, já que client_outstanding_principal/_balance só
-- somam contratos em_aberto/atrasado).
-- QA-6: valida p_late_charge_amount >= 0 (também aplicado em receive_payment
-- e receive_cycle_payment abaixo).
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
  v_installments_count integer;
  v_allows_renewal boolean;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  if p_interest_only_amount < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if p_source_type = 'installment' then
    -- Descontar o que já foi pago parcialmente (principal_paid_partial/
    -- interest_paid_partial) antes de renovar — mesmo ajuste que
    -- receive_payment já faz corretamente. Sem isso, renovar uma parcela que
    -- tinha recebido pagamento parcial recriava a dívida CHEIA original no
    -- novo ciclo, fazendo o valor já pago "sumir" do saldo devedor do
    -- cliente. greatest(0, ...) é defesa extra contra qualquer estado
    -- inconsistente anterior (parcela editada com valor abaixo do já pago).
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
    -- para ciclos já renovados, o "capital" permanece o mesmo da 1ª parcela original;
    -- full_debt_amount do ciclo anterior já é o total (capital+juros) então usamos ele
    select rc.full_debt_amount into v_full_debt from renewal_cycles rc where rc.id = p_source_id;
    v_principal := 0;
    v_interest := v_full_debt; -- mantém o valor cheio como base do próximo ciclo abaixo
  end if;

  -- defesa contra corrida: duplo-clique ou dois gerentes renovando a mesma
  -- parcela/ciclo quase simultaneamente. O FOR UPDATE acima trava a linha, mas
  -- sem essa checagem a 2ª chamada (liberada após a 1ª commitar) seguia em
  -- frente do mesmo jeito, gerando um segundo renewal_cycles + payments
  -- duplicado pro mesmo evento — mesmo padrão de proteção já usado em
  -- receive_payment/receive_cycle_payment.
  if v_status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  select lc.due_type, lc.client_id, lc.custom_interval_days, lc.installments_count, lc.allows_renewal
    into v_due_type, v_client_id, v_custom_days, v_installments_count, v_allows_renewal
    from loan_contracts lc where lc.id = v_contract_id;

  -- Renovação só é permitida em contratos de parcela única com o flag
  -- habilitado — a RPC nunca validava isso no servidor, só a UI escondia o
  -- botão (openReceberModal só monta a aba "Renovar" quando canRenew=true);
  -- um cliente técnico chamando a RPC direto conseguiria renovar qualquer
  -- contrato multi-parcela, deixando a relação entre as demais parcelas e o
  -- ciclo renovado ambígua (ver decisão documentada em CLAUDE.md).
  if v_installments_count <> 1 or not coalesce(v_allows_renewal, false) then
    raise exception 'RENEWAL_NOT_ALLOWED';
  end if;

  v_full_debt := coalesce(v_full_debt, v_principal + v_interest);

  v_step := case v_due_type
    when 'mensal' then interval '1 month'
    when 'quinzenal' then interval '15 days'
    when 'semanal' then interval '7 days'
    when 'personalizado' then (coalesce(v_custom_days, 30) || ' days')::interval
  end;
  -- p_new_due_date deixa o gerente escolher a data manualmente (tela de
  -- recebimento) — se não vier, cai no cálculo automático de sempre.
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

  -- Inclui 'perda' de propósito: um contrato marcado em cobrança que ainda
  -- assim recebe uma renovação volta a ficar em_aberto — sem isso, ele
  -- continuava invisível pra client_outstanding_principal/_balance (que
  -- filtram só em_aberto/atrasado), subestimando o limite de crédito
  -- consumido pelo cliente mesmo com uma dívida ativa sendo paga de novo.
  update loan_contracts set status = 'em_aberto', updated_at = now()
    where id = v_contract_id and status in ('em_aberto', 'atrasado', 'perda');

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body)
  values (v_client_id, 'renovacao_registrada', 'in_app', v_contract_id,
          'Renovação registrada', 'Sua dívida foi renovada. Novo vencimento: ' || v_new_due_date);

  return v_new_cycle_id;
end;
$$;

-- QA-6: valida p_late_charge_amount >= 0
create or replace function receive_payment(
  p_installment_id uuid,
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

  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
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
    has_operational_fee, operational_fee_amount, received_by, notes, received_at
  ) values (
    v_contract.id, p_installment_id, 'quitacao_parcela', p_amount_received,
    v_pay_principal, v_pay_interest + v_pay_late, v_pay_late,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date)
  ) returning id into v_payment_id;

  update installments set
    principal_paid_partial = principal_paid_partial + v_pay_principal,
    interest_paid_partial = interest_paid_partial + v_pay_interest
  where id = p_installment_id;

  if v_remaining_total - p_amount_received <= 0.01 then
    update installments set status = 'paga', paid_at = coalesce(p_received_at, current_date) where id = p_installment_id;

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

-- QA-6: valida p_late_charge_amount >= 0
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
  v_principal numeric;
  v_interest numeric;
  v_full_amount_due numeric;
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

  -- Ciclo de renovação NÃO tem controle de pagamento parcial (diferente de
  -- installments, que tem principal_paid_partial/interest_paid_partial) —
  -- essa função só existe pra quitação total. Sem essa checagem, um valor
  -- menor que o devido era aceito do mesmo jeito e o ciclo/contrato eram
  -- marcados como quitados mesmo sem o valor real ter entrado, inflando o
  -- lucro registrado nos relatórios (que gravavam o valor CHEIO esperado,
  -- não o que realmente veio em p_amount_received).
  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  v_full_amount_due := v_cycle.full_debt_amount + coalesce(p_late_charge_amount, 0);
  if p_amount_received <= 0 or abs(p_amount_received - v_full_amount_due) > 0.01 then
    raise exception 'INVALID_AMOUNT';
  end if;

  select * into v_contract from loan_contracts where id = v_cycle.contract_id for update;
  v_principal := v_contract.principal_amount;
  v_interest := v_cycle.full_debt_amount - v_principal;

  insert into payments (
    contract_id, renewal_cycle_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at
  ) values (
    v_contract.id, p_cycle_id, 'quitacao_final', p_amount_received,
    v_principal, v_interest + coalesce(p_late_charge_amount, 0), coalesce(p_late_charge_amount, 0),
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date)
  ) returning id into v_payment_id;

  update renewal_cycles set status = 'paga', paid_at = coalesce(p_received_at, current_date) where id = p_cycle_id;

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

-- QA-7: contrato multi-parcela agora volta de 'atrasado' pra 'em_aberto'
-- quando não há mais nenhuma parcela/ciclo atrasado (antes só
-- renew_installment fazia esse retorno, e renovação só existe pra parcela
-- única — um contrato de 3 parcelas que atrasava uma vez ficava com status
-- 'atrasado' PERMANENTE mesmo depois de todas as parcelas voltarem em dia).
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

  update loan_contracts lc set status = 'em_aberto', updated_at = now()
    where status = 'atrasado'
      and not exists (select 1 from installments i where i.contract_id = lc.id and i.status = 'atrasada')
      and not exists (select 1 from renewal_cycles rc where rc.contract_id = lc.id and rc.status = 'atrasada');

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

  -- Recalcula o score de todo cliente com contrato atrasado ou em perda, para
  -- o score refletir o estado atual mesmo sem nenhum recebimento novo (senão
  -- o score de um cliente inadimplente que não interage mais fica parado).
  for v_client_id in
    select distinct client_id from loan_contracts where status in ('atrasado', 'perda')
  loop
    perform recalculate_client_score(v_client_id);
  end loop;
end;
$$;

-- QA-4: trava a linha do cliente ANTES de checar o limite de crédito, tanto
-- na criação de contrato (gerente) quanto na solicitação (cliente) — sem
-- isso, duas criações/solicitações concorrentes podiam, juntas, ultrapassar
-- o limite mesmo cada uma passando na checagem isoladamente (race condition
-- clássica check-then-act).
create or replace function trg_check_credit_limit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform 1 from clients where profile_id = new.client_id for update;
  if not check_credit_limit(new.client_id, new.principal_amount) then
    raise exception 'CREDIT_LIMIT_EXCEEDED';
  end if;
  return new;
end;
$$;

create or replace function trg_check_credit_limit_request()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_limit numeric;
begin
  select credit_limit into v_limit from clients where profile_id = new.client_id for update;
  if (client_outstanding_principal(new.client_id) + new.requested_amount) > coalesce(v_limit, 0) then
    raise exception 'CREDIT_LIMIT_EXCEEDED';
  end if;
  return new;
end;
$$;

-- QA-9: a última parcela absorve o resto do arredondamento (método do maior
-- resto) — antes, round(principal/count,2) fixo em toda parcela podia
-- perder/sobrar centavos que nunca eram atribuídos a nenhuma parcela (ex:
-- R$1.000 ÷ 3 = R$333,33 × 3 = R$999,99, faltando R$0,01 pra bater com
-- principal_amount do contrato).
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
  principal_accum numeric(12,2) := 0;
  interest_accum numeric(12,2) := 0;
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
    if i = p_installments_count then
      principal_share := p_principal - principal_accum;
      interest_share := total_interest - interest_accum;
    else
      principal_share := principal_per;
      interest_share := interest_per;
      principal_accum := principal_accum + principal_per;
      interest_accum := interest_accum + interest_per;
    end if;
    return next;
  end loop;
end;
$$;

-- QA-5 e QA-8: create_loan_contract agora rejeita parcela com capital/juros
-- negativo no override (defesa em profundidade — o wizard já trava isso no
-- JS, mas a RPC é pública) e reconcilia a soma do capital das parcelas
-- geradas/editadas contra o capital do contrato (dentro de uma tolerância de
-- centavos), pra um valor digitado errado no wizard não desalinhar
-- silenciosamente o limite de crédito consumido por esse contrato.
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
  v_principal_sum numeric;
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
      if (v_row->>'principal_share')::numeric < 0 or (v_row->>'interest_share')::numeric < 0 then
        raise exception 'INVALID_AMOUNT';
      end if;
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

  select coalesce(sum(principal_share), 0) into v_principal_sum from installments where contract_id = v_contract_id;
  if abs(v_principal_sum - p_principal_amount) > greatest(0.02 * p_installments_count, 0.02) then
    raise exception 'PRINCIPAL_MISMATCH';
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

-- QA-8: update_installment_schedule ganha a mesma reconciliação de capital
-- (comparando a soma de TODAS as parcelas do contrato, não só a que foi
-- editada, contra o capital contratado).
create or replace function update_installment_schedule(
  p_installment_id uuid,
  p_due_date date,
  p_principal_share numeric,
  p_interest_share numeric
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_installment installments%rowtype;
  v_installments_count integer;
  v_principal_amount numeric;
  v_principal_sum numeric;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  select * into v_installment from installments where id = p_installment_id;
  if v_installment.id is null then raise exception 'NOT_FOUND'; end if;

  if p_principal_share < v_installment.principal_paid_partial
    or p_interest_share < v_installment.interest_paid_partial
  then
    raise exception 'AMOUNT_BELOW_ALREADY_PAID';
  end if;

  update installments set
    due_date = p_due_date,
    principal_share = p_principal_share,
    interest_share = p_interest_share
  where id = p_installment_id;

  select installments_count, principal_amount into v_installments_count, v_principal_amount
    from loan_contracts where id = v_installment.contract_id;
  select coalesce(sum(principal_share), 0) into v_principal_sum
    from installments where contract_id = v_installment.contract_id;
  if abs(v_principal_sum - v_principal_amount) > greatest(0.02 * v_installments_count, 0.02) then
    raise exception 'PRINCIPAL_MISMATCH';
  end if;
end;
$$;

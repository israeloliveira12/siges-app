-- Migration 027: perda de dívida por PARCELA/CICLO específico (não mais o
-- contrato inteiro), subtraída do lucro líquido no mês em que é reconhecida,
-- com botão manual "Marcar como perda" / "Reverter perda" além da perda
-- automática já existente (cron, baseado no prazo configurado). Decisão do
-- usuário, 2026-07-27.
--
-- IMPORTANTE — rode em DUAS ETAPAS SEPARADAS (cole e execute o PASSO 1
-- primeiro, espere terminar, só depois cole e execute o PASSO 2). O Postgres
-- não permite usar um valor de enum recém-criado (ALTER TYPE ... ADD VALUE)
-- na mesma transação/execução em que ele foi adicionado — se colar tudo de
-- uma vez só, o SQL Editor pode retornar erro "unsafe use of new value of
-- enum type".

-- ============================================================================
-- PASSO 1 — rode isto sozinho primeiro
-- ============================================================================

alter type installment_status add value 'perda';

-- ============================================================================
-- PASSO 2 — depois de confirmar que o PASSO 1 rodou sem erro, cole e rode
-- o restante deste arquivo (a partir daqui) numa nova execução.
-- ============================================================================

-- Colunas novas: capital ainda não recuperado no momento em que a parcela/
-- ciclo foi reconhecido como perda, e quando isso aconteceu (nunca due_date/
-- created_at — loss_recognized_at é o que define o MÊS do abate no lucro).
alter table installments add column if not exists principal_lost numeric(12,2) not null default 0;
alter table installments add column if not exists loss_recognized_at timestamptz;
alter table renewal_cycles add column if not exists principal_lost numeric(12,2) not null default 0;
alter table renewal_cycles add column if not exists loss_recognized_at timestamptz;

-- Sincroniza o status do CONTRATO a partir do estado real das suas parcelas/
-- ciclos — reabre quem tem pendência em dia (em_aberto), atrasa quem tem
-- pendência vencida (atrasado), e fecha (quitado ou perda, se alguma
-- parcela/ciclo foi perdido) quem não tem mais nada pendente/atrasado.
-- Função única reusada por refresh_overdue_status() (cron diário),
-- receive_payment/receive_cycle_payment (quitação) e as RPCs de marcar/
-- reverter perda — evita duplicar essa lógica em 5 lugares diferentes.
create or replace function recompute_contract_status(p_contract_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_has_atrasada boolean;
  v_has_open boolean;
  v_has_loss boolean;
  v_new_status contract_status;
begin
  select
    exists(select 1 from installments where contract_id = p_contract_id and status = 'atrasada')
      or exists(select 1 from renewal_cycles where contract_id = p_contract_id and status = 'atrasada'),
    exists(select 1 from installments where contract_id = p_contract_id and status in ('pendente', 'atrasada'))
      or exists(select 1 from renewal_cycles where contract_id = p_contract_id and status in ('pendente', 'atrasada'))
    into v_has_atrasada, v_has_open;

  if v_has_open then
    v_new_status := case when v_has_atrasada then 'atrasado' else 'em_aberto' end;
  else
    select exists(select 1 from installments where contract_id = p_contract_id and status = 'perda')
        or exists(select 1 from renewal_cycles where contract_id = p_contract_id and status = 'perda')
      into v_has_loss;
    v_new_status := case when v_has_loss then 'perda' else 'quitado' end;
  end if;

  update loan_contracts set status = v_new_status, updated_at = now()
    where id = p_contract_id and status <> v_new_status;
end;
$$;

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
  v_max_allowed := v_remaining_total + coalesce(p_late_charge_amount, 0);

  if p_amount_received <= 0 or p_amount_received > v_max_allowed + 0.01 then
    raise exception 'INVALID_AMOUNT';
  end if;

  select * into v_contract from loan_contracts where id = v_installment.contract_id for update;

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
    perform recompute_contract_status(v_contract.id);

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
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_cycle from renewal_cycles where id = p_cycle_id for update;
  if v_cycle.status not in ('pendente', 'atrasada') then
    raise exception 'CYCLE_NOT_PAYABLE';
  end if;

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
  perform recompute_contract_status(v_contract.id);

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body)
  values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id,
          'Pagamento recebido', 'Recebemos seu pagamento de R$ ' || p_amount_received || '. Contrato quitado.');

  return v_payment_id;
end;
$$;

create or replace function refresh_overdue_status()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_client_id uuid;
  v_contract_id uuid;
begin
  update installments set status = 'atrasada'
    where status = 'pendente' and due_date < current_date;

  update renewal_cycles set status = 'atrasada'
    where status = 'pendente' and new_due_date < current_date;

  -- Perda automática — marca a PARCELA/CICLO específico que ultrapassou o
  -- prazo configurado (loss_days_threshold), não mais o contrato inteiro:
  -- outras parcelas do mesmo contrato continuam intocadas (decisão explícita
  -- do usuário, 2026-07-27 — "perda da parcela específica"). O valor
  -- perdido é o capital ainda não recuperado daquela parcela/ciclo. Isso
  -- roda ANTES da sincronização de status do contrato logo abaixo, pra um
  -- contrato cuja única pendência acabou de virar perda não ser promovido
  -- por engano pra 'em_aberto' (não existe mais 'atrasada' nele) em vez de
  -- corretamente fechar como 'perda'.
  update installments set
    status = 'perda',
    principal_lost = greatest(0, principal_share - principal_paid_partial),
    loss_recognized_at = now()
  where status = 'atrasada'
    and due_date < current_date - (select loss_days_threshold from system_settings);

  update renewal_cycles rc set
    status = 'perda',
    principal_lost = coalesce((select lc.principal_amount from loan_contracts lc where lc.id = rc.contract_id), 0),
    loss_recognized_at = now()
  where status = 'atrasada'
    and new_due_date < current_date - (select loss_days_threshold from system_settings);

  -- Sincroniza o status de cada contrato ainda aberto a partir do estado
  -- real das suas parcelas/ciclos (em_aberto/atrasado/quitado/perda) — uma
  -- função só (recompute_contract_status), reusada também pelas RPCs de
  -- recebimento e de marcar/reverter perda, substitui as 3 atualizações que
  -- existiam soltas aqui antes.
  for v_contract_id in select id from loan_contracts where status in ('em_aberto', 'atrasado')
  loop
    perform recompute_contract_status(v_contract_id);
  end loop;

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

-- Marcar/reverter perda manualmente numa parcela ou ciclo específico — mesmo
-- efeito da perda automática do cron acima, só que disparado pelo gerente a
-- qualquer momento (não precisa esperar o prazo configurado). "Reverter" é o
-- caminho de recuperação: se o cliente pagar depois de já reconhecida a
-- perda, o gerente reverte a parcela/ciclo específico (ela volta a aparecer
-- no Cobrar normalmente) e o pagamento entra como lucro no mês em que
-- realmente aconteceu — nunca reabre retroativamente o mês em que a perda
-- já foi contabilizada.
create or replace function mark_installment_loss(p_installment_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_installment installments%rowtype;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  select * into v_installment from installments where id = p_installment_id for update;
  if v_installment.id is null then raise exception 'NOT_FOUND'; end if;
  if v_installment.status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  update installments set
    status = 'perda',
    principal_lost = greatest(0, principal_share - principal_paid_partial),
    loss_recognized_at = now()
  where id = p_installment_id;

  perform recompute_contract_status(v_installment.contract_id);
end;
$$;

create or replace function revert_installment_loss(p_installment_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_installment installments%rowtype;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  select * into v_installment from installments where id = p_installment_id for update;
  if v_installment.id is null then raise exception 'NOT_FOUND'; end if;
  if v_installment.status <> 'perda' then raise exception 'NOT_IN_LOSS'; end if;

  update installments set
    status = case when due_date < current_date then 'atrasada' else 'pendente' end,
    principal_lost = 0,
    loss_recognized_at = null
  where id = p_installment_id;

  perform recompute_contract_status(v_installment.contract_id);
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

  select * into v_cycle from renewal_cycles where id = p_cycle_id for update;
  if v_cycle.id is null then raise exception 'NOT_FOUND'; end if;
  if v_cycle.status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  select principal_amount into v_principal from loan_contracts where id = v_cycle.contract_id;

  update renewal_cycles set
    status = 'perda',
    principal_lost = coalesce(v_principal, 0),
    loss_recognized_at = now()
  where id = p_cycle_id;

  perform recompute_contract_status(v_cycle.contract_id);
end;
$$;

create or replace function revert_cycle_loss(p_cycle_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_cycle renewal_cycles%rowtype;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  select * into v_cycle from renewal_cycles where id = p_cycle_id for update;
  if v_cycle.id is null then raise exception 'NOT_FOUND'; end if;
  if v_cycle.status <> 'perda' then raise exception 'NOT_IN_LOSS'; end if;

  update renewal_cycles set
    status = case when new_due_date < current_date then 'atrasada' else 'pendente' end,
    principal_lost = 0,
    loss_recognized_at = null
  where id = p_cycle_id;

  perform recompute_contract_status(v_cycle.contract_id);
end;
$$;

-- update_installment_schedule ganha: se a parcela editada já estava
-- reconhecida como perda, o valor perdido é recalculado junto com a
-- correção do capital — senão uma edição posterior (ex: corrigir um valor
-- digitado errado) deixaria o abate do lucro registrado num mês antigo
-- desatualizado em relação ao capital real.
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
    interest_share = p_interest_share,
    principal_lost = case when status = 'perda' then greatest(0, p_principal_share - v_installment.principal_paid_partial) else principal_lost end
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

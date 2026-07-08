-- ============================================================================
-- MIGRATION 012 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_011)
--
-- Cobre: limite de crédito considera capital emprestado (não saldo devedor
-- total); remove "Região" (mantém só "Grupo", agora lista fixa); grupo no
-- cadastro público de cliente; data de pagamento editável ao receber; backup
-- automático/manual e exportação de dados.
--
-- IMPORTANTE: update_client_profile, receive_payment, receive_cycle_payment e
-- renew_installment mudam de parâmetros nesta migration — por isso cada uma
-- vem com um "drop function" explícito da assinatura antiga antes do "create
-- or replace" (sem isso, o Postgres cria uma segunda versão da função em vez
-- de substituir, o mesmo bug corrigido na migration_010).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Limite de crédito: capital emprestado, não saldo devedor (item 1)
-- ----------------------------------------------------------------------------
create or replace function client_outstanding_principal(p_client_id uuid)
returns numeric
language plpgsql stable
security definer set search_path = public
as $$
begin
  if not (is_gerente() or auth.uid() = p_client_id) then
    raise exception 'FORBIDDEN';
  end if;

  return (select coalesce(sum(
    case
      when exists (
        select 1 from renewal_cycles rc
        where rc.contract_id = lc.id and rc.status in ('pendente','atrasada')
      )
      then lc.principal_amount
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

create or replace function check_credit_limit(p_client_id uuid, p_new_principal numeric)
returns boolean
language plpgsql stable
security definer set search_path = public
as $$
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;
  return (client_outstanding_principal(p_client_id) + p_new_principal) <=
         (select credit_limit from clients where profile_id = p_client_id);
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. Remove "Região", mantém só "Grupo" + adiciona Grupo ao cadastro público (item 3)
-- ----------------------------------------------------------------------------
alter table clients drop column if exists region;

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role, cpf, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    lower(new.email),
    'cliente',
    new.raw_user_meta_data->>'cpf',
    new.raw_user_meta_data->>'phone'
  )
  on conflict (id) do nothing;

  insert into public.clients (profile_id, company, job_title, salary, pix_key, client_group)
  values (
    new.id,
    new.raw_user_meta_data->>'company',
    new.raw_user_meta_data->>'job_title',
    nullif(new.raw_user_meta_data->>'salary', ''),
    new.raw_user_meta_data->>'pix_key',
    nullif(new.raw_user_meta_data->>'client_group', '')
  )
  on conflict (profile_id) do nothing;

  return new;
end;
$$;

drop function if exists update_client_profile(uuid, text, text, text, numeric, text, text, text, text, text, text, text);

create or replace function update_client_profile(
  p_client_id uuid,
  p_full_name text,
  p_cpf text,
  p_phone text,
  p_credit_limit numeric,
  p_client_group text,
  p_notes text,
  p_company text default null,
  p_job_title text default null,
  p_salary text default null,
  p_pix_key text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  update profiles set full_name = p_full_name, cpf = p_cpf, phone = p_phone, updated_at = now()
    where id = p_client_id;

  update clients set credit_limit = p_credit_limit,
    client_group = p_client_group, notes = p_notes,
    company = p_company, job_title = p_job_title, salary = p_salary, pix_key = p_pix_key
    where profile_id = p_client_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Data de pagamento editável ao receber (item 10)
-- ----------------------------------------------------------------------------
drop function if exists receive_payment(uuid, numeric, boolean, numeric, text, numeric);

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

drop function if exists renew_installment(request_source, uuid, numeric, boolean, numeric, text, numeric);

create or replace function renew_installment(
  p_source_type request_source,
  p_source_id uuid,
  p_interest_only_amount numeric,
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
  v_new_due_date := coalesce(p_received_at, current_date) + v_step;

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

drop function if exists receive_cycle_payment(uuid, numeric, boolean, numeric, text, numeric);

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

-- ----------------------------------------------------------------------------
-- 4. Backup automático (item 12)
-- ----------------------------------------------------------------------------
alter table system_settings add column if not exists backup_auto_enabled boolean not null default false;
alter table system_settings add column if not exists backup_frequency text not null default 'diario';
alter table system_settings add column if not exists backup_custom_days integer;

-- ============================================================================
-- FIM DA MIGRATION 012
-- ============================================================================

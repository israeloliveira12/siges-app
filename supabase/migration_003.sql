-- ============================================================================
-- MIGRATION 003 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_002)
--
-- Cobre: correção do "apagar tudo" (DELETE sem WHERE), número de contrato
-- com 5 dígitos aleatórios, taxa fixa + percentual (entrada/saída), edição
-- e exclusão de contrato, edição/reagendamento de parcela.
-- ============================================================================

-- 1. Corrige wipe_all_business_data() — o Supabase bloqueia DELETE sem WHERE
create or replace function wipe_all_business_data()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_primary_admin() then
    raise exception 'FORBIDDEN';
  end if;

  delete from payments where true;
  delete from renewal_cycles where true;
  delete from installments where true;
  delete from loan_contracts where true;
  delete from loan_requests where true;
  delete from notifications_log where true;
  delete from push_subscriptions where true;
  delete from clients where true;
  delete from profiles where role = 'cliente';
end;
$$;

-- 2. Número do contrato = 5 dígitos aleatórios (em vez de sequencial)
alter table loan_contracts alter column contract_number drop default;
alter table loan_contracts add constraint loan_contracts_contract_number_key unique (contract_number);

create or replace function generate_contract_number()
returns integer
language plpgsql
as $$
declare
  candidate integer;
  already_used boolean;
begin
  loop
    candidate := floor(random() * 90000 + 10000)::integer; -- 10000..99999
    select exists(select 1 from loan_contracts where contract_number = candidate) into already_used;
    exit when not already_used;
  end loop;
  return candidate;
end;
$$;

create or replace function set_contract_number()
returns trigger
language plpgsql
as $$
begin
  if new.contract_number is null then
    new.contract_number := generate_contract_number();
  end if;
  return new;
end;
$$;

create trigger before_insert_contract_number
  before insert on loan_contracts
  for each row execute function set_contract_number();

-- 3. Taxa fixa (R$) somada à taxa percentual, tanto na saída quanto na entrada
alter table system_settings add column if not exists default_exit_fee_fixed numeric(12,2) not null default 0;
alter table system_settings add column if not exists default_entry_fee_fixed numeric(12,2) not null default 0;

-- 4. Editar contrato (campos que não exigem recalcular parcelas já geradas)
create or replace function update_contract(
  p_contract_id uuid,
  p_interest_rate numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_allows_renewal boolean,
  p_late_fee_percent numeric,
  p_late_interest_percent numeric,
  p_observations text
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  update loan_contracts set
    interest_rate = p_interest_rate,
    has_operational_fee = p_has_operational_fee,
    operational_fee_amount = coalesce(p_operational_fee_amount, 0),
    allows_renewal = p_allows_renewal,
    late_fee_percent = coalesce(p_late_fee_percent, 0),
    late_interest_percent = coalesce(p_late_interest_percent, 0),
    observations = p_observations,
    updated_at = now()
  where id = p_contract_id;
end;
$$;

-- 5. Editar/reagendar uma parcela específica (só enquanto não estiver paga)
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
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  update installments set
    due_date = p_due_date,
    principal_share = p_principal_share,
    interest_share = p_interest_share
  where id = p_installment_id and status in ('pendente', 'atrasada');
end;
$$;

-- 6. Excluir um contrato inteiro (e todo o histórico ligado a ele)
create or replace function delete_contract(p_contract_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  delete from payments where contract_id = p_contract_id;
  delete from renewal_cycles where contract_id = p_contract_id;
  delete from installments where contract_id = p_contract_id;
  update loan_requests set resulting_contract_id = null where resulting_contract_id = p_contract_id;
  delete from loan_contracts where id = p_contract_id;
end;
$$;

-- ============================================================================
-- FIM DA MIGRATION 003
-- ============================================================================

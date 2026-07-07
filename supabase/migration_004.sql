-- ============================================================================
-- MIGRATION 004 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_003)
--
-- Cobre: admin aparecendo como cliente (bug de trigger), pagamento parcial
-- de parcela (rastreado sem fechar a parcela), e ajuste do limite de crédito
-- para considerar pagamentos parciais.
-- ============================================================================

-- 1. Limpa a linha de "clients" que foi criada indevidamente para contas que
-- hoje são gerente/administrador (o trigger de cadastro sempre cria uma linha
-- de cliente por padrão; isso é corrigido daqui pra frente pelo trigger abaixo).
delete from clients where profile_id in (select id from profiles where role = 'gerente');

-- 2. A partir de agora, sempre que uma conta for promovida de cliente pra
-- gerente, a linha de clients correspondente é removida automaticamente.
create or replace function trg_cleanup_client_on_promotion()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.role = 'gerente' and old.role = 'cliente' then
    delete from clients where profile_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists after_profile_role_promoted on profiles;
create trigger after_profile_role_promoted
  after update of role on profiles
  for each row execute function trg_cleanup_client_on_promotion();

-- 3. Pagamento parcial de parcela: rastreia quanto já foi pago de capital e
-- de juros de cada parcela, sem precisar fechar a parcela até o restante ser
-- quitado (o restante é o que passa a "vencer" caso fique em atraso).
alter table installments add column if not exists principal_paid_partial numeric(12,2) not null default 0;
alter table installments add column if not exists interest_paid_partial numeric(12,2) not null default 0;

create or replace function receive_payment(
  p_installment_id uuid,
  p_amount_received numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_notes text default null
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
  v_pay_interest numeric;
  v_pay_principal numeric;
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

  if p_amount_received <= 0 or p_amount_received > v_remaining_total + 0.01 then
    raise exception 'INVALID_AMOUNT';
  end if;

  select * into v_contract from loan_contracts where id = v_installment.contract_id for update;

  -- paga juros primeiro, depois capital (padrão comum de amortização)
  v_pay_interest := least(p_amount_received, v_remaining_interest);
  v_pay_principal := p_amount_received - v_pay_interest;

  insert into payments (
    contract_id, installment_id, payment_kind, amount_received,
    principal_component, interest_component,
    has_operational_fee, operational_fee_amount, received_by, notes
  ) values (
    v_contract.id, p_installment_id, 'quitacao_parcela', p_amount_received,
    v_pay_principal, v_pay_interest,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes
  ) returning id into v_payment_id;

  update installments set
    principal_paid_partial = principal_paid_partial + v_pay_principal,
    interest_paid_partial = interest_paid_partial + v_pay_interest
  where id = p_installment_id;

  if v_remaining_total - p_amount_received <= 0.01 then
    -- quitação total (cobre o que faltava, com tolerância de arredondamento)
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
    -- pagamento parcial: a parcela continua em aberto pelo valor restante
    insert into notifications_log (recipient_id, event, channel, related_contract_id, related_installment_id, title, body)
    values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id, p_installment_id,
            'Pagamento parcial recebido',
            'Recebemos R$ ' || p_amount_received || '. Restam R$ ' || round(v_remaining_total - p_amount_received, 2) || ' desta parcela.');
  end if;

  return v_payment_id;
end;
$$;

-- 4. Limite de crédito precisa considerar o valor JÁ pago parcialmente
-- (só o restante conta como dívida em aberto)
create or replace function client_outstanding_balance(p_client_id uuid)
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
      then (
        select rc.full_debt_amount from renewal_cycles rc
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

-- ============================================================================
-- FIM DA MIGRATION 004
-- ============================================================================

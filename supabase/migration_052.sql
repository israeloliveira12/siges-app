-- ============================================================================
-- migration_052.sql — Prorrogação de parcelas com pagamento de juros
--
-- Pedido do usuário (2026-10-13): num contrato de 3x de R$ 300 (R$ 200 de
-- capital + R$ 100 de juros), o cliente pede para "renovar" uma parcela. Ele
-- paga os R$ 100 de juros e o sistema empurra ESSA parcela e TODAS as
-- seguintes em aberto por um período. Renovar a 1ª joga as três para frente;
-- renovar a 2ª joga a 2ª e a 3ª.
--
-- POR QUE NÃO É O MODELO DE CICLO (renewal_cycles)
-- O ciclo colapsa a dívida num saldo rolante único: a parcela vira 'renovada'
-- e deixa de existir como obrigação. Por isso renew_installment() exige
-- installments_count = 1 — com 3 parcelas, um ciclo conviveria com as parcelas
-- 2 e 3, e a tela de detalhe (que faz `cycles.find(status <> 'renovada')`, sem
-- amarrar o ciclo à parcela de origem) renderizaria a linha errada.
--
-- Aqui a dívida NÃO colapsa: a parcela continua devendo os R$ 300, só vence
-- depois. O cliente comprou mais um período. Nenhum valor muda — só datas —
-- e nenhuma entidade nova é criada. Por isso o raio de impacto é pequeno:
-- renewal_cycles não é tocado, e contrato de 1x segue no modelo de ciclo.
--
-- `payment_kind` reaproveita 'renovacao_juros' de propósito: o rótulo da tela
-- já é "Renovação (juros)", que descreve exatamente a operação, e um valor
-- novo de enum não pode ser usado na mesma transação em que é criado — o SQL
-- Editor do Supabase roda o script inteiro numa transação só.
-- ============================================================================

create or replace function postpone_installments_with_interest(
  p_installment_id uuid,
  p_interest_amount numeric,
  p_new_due_date date default null,
  p_has_operational_fee boolean default false,
  p_operational_fee_amount numeric default 0,
  p_late_charge_amount numeric default 0,
  p_notes text default null,
  p_received_at date default current_date
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_inst installments%rowtype;
  v_contract_id uuid;
  v_contract_number integer;
  v_client_id uuid;
  v_due_type due_type;
  v_custom_days integer;
  v_installments_count integer;
  v_allows_renewal boolean;
  v_step interval;
  v_new_due_date date;
  v_next_new_date date;
  v_total_received numeric;
  v_moved integer;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  perform assert_received_at_valid(p_received_at);

  v_tenant_id := current_tenant_id();

  if coalesce(p_interest_amount, 0) < 0 or coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  v_total_received := coalesce(p_interest_amount, 0) + coalesce(p_late_charge_amount, 0);
  -- payments.amount_received tem check (> 0): prorrogar de graça não gera
  -- registro de pagamento, e sem registro a operação sumiria do histórico.
  -- Quem só quer mudar a data sem cobrar nada usa "editar/adiar parcela".
  if v_total_received <= 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  select * into v_inst
    from installments
   where id = p_installment_id and tenant_id = v_tenant_id
     for update;
  if v_inst.id is null then
    raise exception 'NOT_FOUND';
  end if;
  if v_inst.status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  select lc.id, lc.contract_number, lc.client_id, lc.due_type, lc.custom_interval_days,
         lc.installments_count, lc.allows_renewal
    into v_contract_id, v_contract_number, v_client_id, v_due_type, v_custom_days,
         v_installments_count, v_allows_renewal
    from loan_contracts lc
   where lc.id = v_inst.contract_id
     for update;

  if not coalesce(v_allows_renewal, false) then
    raise exception 'RENEWAL_NOT_ALLOWED';
  end if;

  -- Decisão do usuário (2026-10-13): contrato de 1 parcela continua no modelo
  -- de ciclo (renew_installment). Dois mecanismos parecidos no mesmo contrato
  -- confundiriam a tela — e para 1x o ciclo é o comportamento correto, já que
  -- ali a dívida realmente rola por inteiro.
  if coalesce(v_installments_count, 0) <= 1 then
    raise exception 'USE_RENEWAL_CYCLE';
  end if;

  -- Decisão do usuário (2026-10-13): não deixa prorrogar a parcela 2 enquanto
  -- a 1 está vencida. Sem isso o cliente compraria prazo para o futuro
  -- deixando um atraso real para trás — e o contrato voltaria a 'atrasado'
  -- logo depois de uma operação que parece tê-lo regularizado.
  if exists (
    select 1 from installments i
     where i.contract_id = v_contract_id
       and i.tenant_id = v_tenant_id
       and i.sequence_number < v_inst.sequence_number
       and i.status in ('pendente', 'atrasada')
       and i.due_date < current_date
  ) then
    raise exception 'EARLIER_INSTALLMENT_OVERDUE';
  end if;

  v_step := case v_due_type
    when 'mensal' then interval '1 month'
    when 'quinzenal' then interval '15 days'
    when 'semanal' then interval '7 days'
    when 'personalizado' then (coalesce(v_custom_days, 30) || ' days')::interval
  end;

  -- Cada parcela anda UM PERÍODO a partir da data dela (não um número fixo de
  -- dias contado a partir da primeira): somar dias corridos desalinharia o
  -- calendário mensal — uma parcela em 15/jan viraria 15/fev (31 dias), e a
  -- seguinte, em 15/fev, cairia em 18/mar em vez de 15/mar.
  v_new_due_date := coalesce(p_new_due_date, (v_inst.due_date + v_step)::date);

  if v_new_due_date <= v_inst.due_date then
    raise exception 'NEW_DUE_DATE_NOT_FUTURE';
  end if;
  if v_new_due_date <= coalesce(p_received_at, current_date) then
    raise exception 'NEW_DUE_DATE_NOT_FUTURE';
  end if;

  -- Guarda de ordenação: uma data escolhida à mão para esta parcela não pode
  -- alcançar a nova data da parcela seguinte, senão o cronograma inverte
  -- (parcela 2 vencendo antes da 1) e a lista do contrato fica ilegível.
  select min((i.due_date + v_step)::date) into v_next_new_date
    from installments i
   where i.contract_id = v_contract_id
     and i.tenant_id = v_tenant_id
     and i.sequence_number > v_inst.sequence_number
     and i.status in ('pendente', 'atrasada');
  if v_next_new_date is not null and v_new_due_date >= v_next_new_date then
    raise exception 'DUE_DATE_ORDER_CONFLICT';
  end if;

  -- A cascata é obrigatória, não opcional: mover só a parcela escolhida num
  -- contrato mensal a jogaria exatamente em cima da parcela seguinte.
  -- Só pendente/atrasada andam — 'paga', 'renovada', 'cancelada' e 'perda'
  -- são terminais e representam fatos já consumados.
  with alvo as (
    select i.id,
           case when i.id = p_installment_id
                then v_new_due_date
                else (i.due_date + v_step)::date
           end as nova_data
      from installments i
     where i.contract_id = v_contract_id
       and i.tenant_id = v_tenant_id
       and i.sequence_number >= v_inst.sequence_number
       and i.status in ('pendente', 'atrasada')
  )
  update installments i
     set due_date = alvo.nova_data,
         -- Mesmo recálculo bidirecional da migration_050: empurrar uma parcela
         -- atrasada para o futuro precisa TIRÁ-LA do atraso (o cron só faz
         -- pendente -> atrasada, nunca o inverso).
         status = (case when alvo.nova_data < current_date then 'atrasada' else 'pendente' end)::installment_status
    from alvo
   where i.id = alvo.id;

  get diagnostics v_moved = row_count;

  -- O pagamento aponta para a parcela de origem (installment_id), nunca para
  -- um ciclo. principal_component = 0 porque nada foi amortizado: o cliente
  -- comprou prazo, a dívida continua inteira. net_profit é coluna gerada
  -- (interest_component - operational_fee_amount), então o lucro entra nos
  -- relatórios sozinho, sem tocar em nenhuma agregação.
  insert into payments (
    contract_id, installment_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract_id, p_installment_id, 'renovacao_juros', v_total_received,
    0, v_total_received, coalesce(p_late_charge_amount, 0),
    coalesce(p_has_operational_fee, false), coalesce(p_operational_fee_amount, 0),
    auth.uid(), p_notes, coalesce(p_received_at, current_date), v_tenant_id
  );

  perform recompute_contract_status(v_contract_id);

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (v_client_id, 'renovacao_registrada', 'in_app', v_contract_id,
          'Parcela prorrogada',
          'A parcela ' || v_inst.sequence_number || ' do contrato #' || v_contract_number ||
          ' foi prorrogada. Novo vencimento: ' || to_char(v_new_due_date, 'DD/MM/YYYY') || '.',
          v_tenant_id);

  return v_moved;
end;
$$;

revoke all on function postpone_installments_with_interest(uuid, numeric, date, boolean, numeric, numeric, text, date) from public, anon;
grant execute on function postpone_installments_with_interest(uuid, numeric, date, boolean, numeric, numeric, text, date) to authenticated;

-- ============================================================================
-- FIM — migration_052.sql
-- ============================================================================

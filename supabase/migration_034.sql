-- Migration 034 — SIGES vira plataforma: FASE 1c (isolamento de ESCRITA)
--
-- A fase de maior risco técnico do projeto inteiro. Cataloguei TODAS as
-- funções security definer que fazem insert/update/delete em tabela com
-- tenant_id, e corrigi as 23 que precisavam. Toda função security definer
-- BYPASSA RLS por completo (roda como dona da tabela) — as políticas
-- corrigidas nas Fases 1a/1b não protegem nada aqui dentro; cada função
-- precisa validar tenant por conta própria.
--
-- ACHADO MAIS GRAVE: wipe_all_business_data() apagava a tabela inteira
-- ("where true"), de TODOS os tenants da plataforma — o admin primário de
-- qualquer empresa cliente do SaaS conseguia apagar os dados de TODAS as
-- outras empresas de uma vez. Corrigido junto nesta migration.
--
-- Também descobri e corrigi (fora do SQL, arquivos api/*.js separados,
-- não incluídos aqui): create-user.js não passava tenant_id pro novo
-- usuário; delete-client.js, reset-client-password.js e
-- update-user-email.js não verificavam se o alvo pertencia ao tenant de
-- quem chama (sequestro de conta entre empresas); notify-event.js
-- notificava gerente/cliente de qualquer tenant. Ver commit para os
-- arquivos JS correspondentes.
--
-- ZERO MUDANÇA DE COMPORTAMENTO HOJE — mesmo raciocínio das fases
-- anteriores: só existe 1 tenant, então toda comparação de tenant_id já
-- bate sempre. O efeito só existe no dia em que existir um Tenant #2.
--
-- Todas usam `create or replace function` com a MESMA assinatura de
-- sempre (nenhum parâmetro/tipo mudou em nenhuma das 23) — não precisa de
-- `drop function` antes de nenhuma.

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  -- Fase 1c (SaaS multi-empresa): resolve o tenant a partir de raw_user_
  -- meta_data (campo 'tenant_id', string de uuid) quando presente — é assim
  -- que o futuro fluxo de link de convite (Fase 4) vai indicar a que empresa
  -- o novo cadastro pertence. Hoje NENHUM fluxo de cadastro ainda envia esse
  -- campo, então sempre cai no fallback (default_tenant_id(), seu tenant) —
  -- zero mudança de comportamento agora, e já fica pronto pro dia em que a
  -- Fase 4 passar a enviar o valor de verdade.
  v_tenant_id := coalesce(
    nullif(new.raw_user_meta_data->>'tenant_id', '')::uuid,
    default_tenant_id()
  );

  insert into public.profiles (id, full_name, email, role, cpf, phone, tenant_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    lower(new.email),
    'cliente',
    new.raw_user_meta_data->>'cpf',
    new.raw_user_meta_data->>'phone',
    v_tenant_id
  )
  on conflict (id) do nothing;

  insert into public.clients (profile_id, company, job_title, salary, pix_key, client_group, tenant_id)
  values (
    new.id,
    new.raw_user_meta_data->>'company',
    new.raw_user_meta_data->>'job_title',
    nullif(new.raw_user_meta_data->>'salary', ''),
    new.raw_user_meta_data->>'pix_key',
    nullif(new.raw_user_meta_data->>'client_group', ''),
    v_tenant_id
  )
  on conflict (profile_id) do nothing;

  return new;
end;
$$;

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
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN: apenas gerentes podem criar contratos';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c: cliente precisa pertencer ao mesmo tenant de quem cria o
  -- contrato — sem isso, uma chamada direta à RPC (fora do fluxo normal do
  -- app, que já só deixa escolher clientes do próprio tenant) conseguia
  -- criar um contrato em nome de cliente de OUTRO tenant.
  if not exists (select 1 from clients where profile_id = p_client_id and tenant_id = v_tenant_id) then
    raise exception 'FORBIDDEN: cliente não pertence ao seu tenant';
  end if;

  insert into loan_contracts (
    client_id, created_by, origin_request_id, tenant_id,
    principal_amount, interest_rate, installments_count, due_type, custom_interval_days,
    has_operational_fee, operational_fee_amount,
    contract_date, first_installment_date,
    allows_renewal, late_fee_percent, late_interest_percent, observations
  ) values (
    p_client_id, auth.uid(), p_origin_request_id, v_tenant_id,
    p_principal_amount, p_interest_rate, p_installments_count, p_due_type, p_custom_interval_days,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0),
    p_contract_date, p_first_installment_date,
    p_allows_renewal, coalesce(p_late_fee_percent, 0), coalesce(p_late_interest_percent, 0), p_observations
  ) returning id into v_contract_id;

  if p_installments_override is not null then
    for v_row in select * from jsonb_array_elements(p_installments_override) loop
      -- Defesa em profundidade: o wizard já trava capital/juros negativos no
      -- JS, mas a RPC é pública (security definer) e não deveria confiar só
      -- na UI pra isso — parcela com juros negativo apareceria como lucro
      -- negativo mais tarde, sem nenhum aviso.
      if (v_row->>'principal_share')::numeric < 0 or (v_row->>'interest_share')::numeric < 0 then
        raise exception 'INVALID_AMOUNT';
      end if;
      insert into installments (contract_id, sequence_number, due_date, principal_share, interest_share, tenant_id)
      values (
        v_contract_id,
        (v_row->>'sequence_number')::integer,
        (v_row->>'due_date')::date,
        (v_row->>'principal_share')::numeric,
        (v_row->>'interest_share')::numeric,
        v_tenant_id
      );
    end loop;
  else
    insert into installments (contract_id, sequence_number, due_date, principal_share, interest_share, tenant_id)
    select v_contract_id, sequence_number, due_date, principal_share, interest_share, v_tenant_id
    from calc_installments_preview(p_principal_amount, p_interest_rate, p_installments_count, p_due_type, p_first_installment_date, p_custom_interval_days);
  end if;

  -- Reconciliação: a soma do capital das parcelas geradas/editadas precisa
  -- bater com o capital do contrato (dentro de uma tolerância de centavos
  -- de arredondamento) — sem isso, um valor digitado errado no wizard (ou
  -- um override malformado) desalinha o capital total sem nenhum aviso,
  -- inflando/reduzindo artificialmente o limite de crédito consumido por
  -- esse contrato (client_outstanding_principal soma as parcelas em aberto).
  select coalesce(sum(principal_share), 0) into v_principal_sum from installments where contract_id = v_contract_id;
  if abs(v_principal_sum - p_principal_amount) > greatest(0.02 * p_installments_count, 0.02) then
    raise exception 'PRINCIPAL_MISMATCH';
  end if;

  if p_origin_request_id is not null then
    update loan_requests
      set status = 'aprovada', resulting_contract_id = v_contract_id,
          decided_by = auth.uid(), decided_at = now()
      where id = p_origin_request_id and tenant_id = v_tenant_id;
  end if;

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (
    p_client_id, 'contrato_criado', 'in_app', v_contract_id,
    'Novo contrato criado',
    'Seu contrato #' || v_contract_id || ' no valor de R$ ' || p_principal_amount || ' foi criado.',
    v_tenant_id
  );

  return v_contract_id;
end;
$$;

create or replace function reject_request(p_request_id uuid, p_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_client_id uuid;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c: filtro de tenant_id abaixo garante que um gerente só reprova
  -- solicitação do próprio tenant — REQUEST_NOT_FOUND_OR_ALREADY_DECIDED
  -- também cobre "existe mas é de outro tenant", sem revelar a diferença.
  update loan_requests
    set status = 'reprovada', decision_reason = p_reason, decided_by = auth.uid(), decided_at = now()
    where id = p_request_id and status = 'pendente' and tenant_id = v_tenant_id
    returning client_id into v_client_id;

  if v_client_id is null then
    raise exception 'REQUEST_NOT_FOUND_OR_ALREADY_DECIDED';
  end if;

  insert into notifications_log (recipient_id, event, channel, title, body, tenant_id)
  values (v_client_id, 'solicitacao_reprovada', 'in_app', 'Solicitação reprovada',
          coalesce('Motivo: ' || p_reason, 'Sua solicitação de empréstimo foi reprovada.'), v_tenant_id);
end;
$$;

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
  -- Fase 1c: só existia checagem nenhuma antes — qualquer cliente autenticado
  -- podia chamar essa RPC direto. Não vaza/corrompe dado real (recalcula a
  -- partir do estado verdadeiro das parcelas, não aceita valor arbitrário),
  -- mas não deveria ser chamável por conta de cliente. Precisa aceitar
  -- service_role porque também é chamada de dentro de refresh_overdue_status
  -- (cron diário, sem sessão de usuário).
  if not is_gerente() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN';
  end if;

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
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c: sem o filtro de tenant_id abaixo, um gerente de outra empresa
  -- podia informar o id de uma parcela de QUALQUER tenant e registrar um
  -- pagamento contra ela — grava dinheiro no lugar errado, o tipo de bug
  -- mais grave desta fase inteira. v_installment.id is null cobre "não
  -- existe" e "existe mas é de outro tenant" com a mesma mensagem, sem
  -- revelar a diferença.
  select * into v_installment from installments where id = p_installment_id and tenant_id = v_tenant_id for update;
  if v_installment.id is null then
    raise exception 'NOT_FOUND';
  end if;
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
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract.id, p_installment_id, 'quitacao_parcela', p_amount_received,
    v_pay_principal, v_pay_interest + v_pay_late, v_pay_late,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date), v_tenant_id
  ) returning id into v_payment_id;

  update installments set
    principal_paid_partial = principal_paid_partial + v_pay_principal,
    interest_paid_partial = interest_paid_partial + v_pay_interest
  where id = p_installment_id;

  if v_remaining_total - p_amount_received <= 0.01 then
    update installments set status = 'paga', paid_at = coalesce(p_received_at, current_date) where id = p_installment_id;
    perform recompute_contract_status(v_contract.id);

    insert into notifications_log (recipient_id, event, channel, related_contract_id, related_installment_id, title, body, tenant_id)
    values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id, p_installment_id,
            'Pagamento recebido', 'Recebemos seu pagamento de R$ ' || p_amount_received || '.', v_tenant_id);
  else
    insert into notifications_log (recipient_id, event, channel, related_contract_id, related_installment_id, title, body, tenant_id)
    values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id, p_installment_id,
            'Pagamento parcial recebido',
            'Recebemos R$ ' || p_amount_received || '. Restam R$ ' || round(v_remaining_total - p_amount_received, 2) || ' desta parcela.', v_tenant_id);
  end if;

  return v_payment_id;
end;
$$;

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
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

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
    -- Fase 1c: filtro de tenant_id evita renovar parcela de outro tenant.
    select i.contract_id,
           greatest(0, i.principal_share - i.principal_paid_partial),
           greatest(0, i.interest_share - i.interest_paid_partial),
           i.status
      into v_contract_id, v_principal, v_interest, v_status
      from installments i where i.id = p_source_id and i.tenant_id = v_tenant_id for update;
  else
    select rc.contract_id, 0, (rc.full_debt_amount - 0), rc.status
      into v_contract_id, v_principal, v_interest, v_status
      from renewal_cycles rc where rc.id = p_source_id and rc.tenant_id = v_tenant_id for update;
    -- para ciclos já renovados, o "capital" permanece o mesmo da 1ª parcela original;
    -- full_debt_amount do ciclo anterior já é o total (capital+juros) então usamos ele
    select rc.full_debt_amount into v_full_debt from renewal_cycles rc where rc.id = p_source_id and rc.tenant_id = v_tenant_id;
    v_principal := 0;
    v_interest := v_full_debt; -- mantém o valor cheio como base do próximo ciclo abaixo
  end if;

  if v_contract_id is null then
    raise exception 'NOT_FOUND';
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

  -- Inclui 'perda' de propósito: um contrato marcado em cobrança que ainda
  -- assim recebe uma renovação volta a ficar em_aberto — sem isso, ele
  -- continuava invisível pra client_outstanding_principal/_balance (que
  -- filtram só em_aberto/atrasado), subestimando o limite de crédito
  -- consumido pelo cliente mesmo com uma dívida ativa sendo paga de novo.
  update loan_contracts set status = 'em_aberto', updated_at = now()
    where id = v_contract_id and status in ('em_aberto', 'atrasado', 'perda');

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (v_client_id, 'renovacao_registrada', 'in_app', v_contract_id,
          'Renovação registrada', 'Sua dívida foi renovada. Novo vencimento: ' || v_new_due_date, v_tenant_id);

  return v_new_cycle_id;
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
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c: mesmo raciocínio de receive_payment() — sem o filtro de
  -- tenant_id, um gerente de outra empresa conseguia quitar um ciclo de
  -- renovação de QUALQUER tenant.
  select * into v_cycle from renewal_cycles where id = p_cycle_id and tenant_id = v_tenant_id for update;
  if v_cycle.id is null then
    raise exception 'NOT_FOUND';
  end if;
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
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract.id, p_cycle_id, 'quitacao_final', p_amount_received,
    v_principal, v_interest + coalesce(p_late_charge_amount, 0), coalesce(p_late_charge_amount, 0),
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date), v_tenant_id
  ) returning id into v_payment_id;

  update renewal_cycles set status = 'paga', paid_at = coalesce(p_received_at, current_date) where id = p_cycle_id;
  perform recompute_contract_status(v_contract.id);

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id,
          'Pagamento recebido', 'Recebemos seu pagamento de R$ ' || p_amount_received || '. Contrato quitado.', v_tenant_id);

  return v_payment_id;
end;
$$;

create or replace function mark_installment_loss(p_installment_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_installment installments%rowtype;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  select * into v_installment from installments where id = p_installment_id and tenant_id = current_tenant_id() for update;
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

  select * into v_installment from installments where id = p_installment_id and tenant_id = current_tenant_id() for update;
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

  select * into v_cycle from renewal_cycles where id = p_cycle_id and tenant_id = current_tenant_id() for update;
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

  select * into v_cycle from renewal_cycles where id = p_cycle_id and tenant_id = current_tenant_id() for update;
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

create or replace function recalculate_client_score(p_client_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_total int; v_on_time int; v_early int; v_avg_delay numeric;
  v_quitados int; v_recovery boolean; v_renewals_on_time int; v_has_perda boolean;
  v_any_renewal_paid boolean; v_graduated boolean;
  v_overdue_now boolean; v_delay_penalty numeric; v_overdue_penalty numeric; v_perda_penalty numeric;
  v_qualidade numeric; v_volume numeric; v_maturidade numeric; v_score numeric;
begin
  -- service_role: chamada interna via refresh_overdue_status() no cron diário
  -- (api/cron-daily-check.js), sem sessão de usuário (auth.uid() nulo). Sem
  -- essa checagem, QUALQUER cliente autenticado podia chamar esta RPC direto
  -- e forçar o recálculo do score de qualquer outro cliente à vontade.
  if not is_gerente() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN';
  end if;

  -- Fase 1c: gerente só recalcula cliente do PRÓPRIO tenant — chamada via
  -- service_role (cron, iterando clientes de TODOS os tenants) não tem
  -- sessão de usuário pra comparar contra, e deve continuar irrestrita.
  if is_gerente() and not exists (select 1 from clients where profile_id = p_client_id and tenant_id = current_tenant_id()) then
    raise exception 'FORBIDDEN';
  end if;

  select count(*) filter (where i.status = 'paga'),
         count(*) filter (where i.status = 'paga' and i.paid_at::date <= i.due_date),
         count(*) filter (where i.status = 'paga' and i.paid_at::date < i.due_date)
    into v_total, v_on_time, v_early
    from installments i join loan_contracts lc on lc.id = i.contract_id
    where lc.client_id = p_client_id and i.due_date > current_date - interval '365 days';

  select coalesce(avg(i.paid_at::date - i.due_date), 0) into v_avg_delay
    from installments i join loan_contracts lc on lc.id = i.contract_id
    where lc.client_id = p_client_id and i.status = 'paga' and i.paid_at::date > i.due_date;

  -- Contratos quitados com sucesso: bônus (item novo, aprovado pelo usuário)
  select count(*) into v_quitados from loan_contracts
    where client_id = p_client_id and status = 'quitado';

  -- Recuperação: pagou uma parcela atrasada (mesmo que com atraso) nos
  -- últimos 90 dias — sinaliza reação positiva após um período de atraso.
  select exists(
    select 1 from installments i join loan_contracts lc on lc.id = i.contract_id
    where lc.client_id = p_client_id and i.status = 'paga'
      and i.paid_at::date > i.due_date and i.paid_at > now() - interval '90 days'
  ) into v_recovery;

  -- Renovações pagas em dia: agora somam pontos (antes subtraíam — corrigido
  -- porque renovar em dia é comportamento recorrente saudável, não um sinal
  -- de risco).
  select count(*) into v_renewals_on_time from renewal_cycles rc
    join loan_contracts lc on lc.id = rc.contract_id
    where lc.client_id = p_client_id and rc.status = 'paga' and rc.paid_at::date <= rc.new_due_date;

  -- "Graduação": qualquer renovação paga (em dia ou não) já conta pro marco
  -- de primeira renovação — o bônus de PONTOS por renovar em dia é outra
  -- conta (v_renewals_on_time acima).
  select exists(
    select 1 from renewal_cycles rc join loan_contracts lc on lc.id = rc.contract_id
    where lc.client_id = p_client_id and rc.status = 'paga'
  ) into v_any_renewal_paid;

  select exists(
    select 1 from loan_contracts where client_id = p_client_id and status = 'perda'
  ) into v_has_perda;

  -- Atraso ATUAL (parcela/ciclo vencido e ainda não pago) — mesmo padrão
  -- "due_date < hoje ao vivo" usado no resto do sistema (não confia só na
  -- coluna status, que só é atualizada 1x/dia pelo cron).
  select exists(
    select 1 from installments i join loan_contracts lc on lc.id = i.contract_id
    where lc.client_id = p_client_id and i.status in ('pendente', 'atrasada') and i.due_date < current_date
    union all
    select 1 from renewal_cycles rc join loan_contracts lc on lc.id = rc.contract_id
    where lc.client_id = p_client_id and rc.status in ('pendente', 'atrasada') and rc.new_due_date < current_date
  ) into v_overdue_now;

  -- Cliente novo começa e permanece com score 50 até quitar o primeiro
  -- contrato ou fazer a primeira renovação — só a partir desse marco
  -- ("graduação") os BÔNUS de comportamento passam a mexer no score. Mas
  -- perda e atraso (histórico ou atual) são sinais de risco que sempre
  -- valem, graduado ou não — não podem ficar escondidos atrás da graduação.
  v_graduated := (v_quitados > 0) or v_any_renewal_paid;

  v_delay_penalty := least(20, greatest(0, v_avg_delay * 2));
  v_overdue_penalty := case when v_overdue_now then 15 else 0 end;
  v_perda_penalty := case when v_has_perda then 30 else 0 end;

  if not v_graduated then
    v_score := 50 - v_delay_penalty - v_overdue_penalty - v_perda_penalty;
  else
    -- Reprovações de solicitação NÃO entram mais como critério (decisão
    -- explícita do usuário — nunca deve ser usado pra avaliar o cliente).
    --
    -- Regra revisada em 2026-07-10 (aprovada pelo usuário): chegar a 100 não
    -- pode ser fácil, e cada ponto acima de 80 deve custar progressivamente
    -- mais. Separamos QUALIDADE (consistência de pagamento, 0 a 1) de
    -- MATURIDADE (volume de histórico acumulado, 0 a 1, com retornos
    -- decrescentes via 1 - e^(-volume/8)) — o bônus é o produto dos dois, não
    -- a soma. Isso faz um único contrato quitado adiantado valer só ~7 pts
    -- de bônus (score ~77), enquanto encostar em 100 exige dezenas de
    -- eventos positivos sustentados (parcelas pagas, contratos quitados,
    -- renovações em dia) — impossível de forçar rápido, porque cada evento
    -- extra rende cada vez menos.
    v_qualidade := least(1,
      0.6 * coalesce(v_on_time::numeric / nullif(v_total, 0), 0.5) +
      0.4 * coalesce(v_early::numeric / nullif(v_total, 0), 0.3)
    );
    v_volume := v_total + v_quitados + v_renewals_on_time;
    v_maturidade := 1 - exp(-v_volume / 8.0);

    v_score := 70
      + 30 * v_qualidade * v_maturidade
      + (case when v_recovery then 2 else 0 end)
      - v_delay_penalty - v_overdue_penalty - v_perda_penalty;
  end if;

  v_score := least(100, greatest(0, round(v_score)));

  update clients set
    score = v_score,
    score_tier = case
      when v_score >= 85 then 'Ouro'
      when v_score >= 70 then 'Bom'
      when v_score >= 50 then 'Atenção'
      else 'Alto risco'
    end,
    score_updated_at = now()
  where profile_id = p_client_id;
end;
$$;

create or replace function recalculate_all_scores()
returns void
language plpgsql
security definer set search_path = public
as $$
declare v_client record;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  -- Fase 1c: sem o filtro de tenant_id, "Recalcular todos" (botão manual e
  -- disparo automático no login) recalculava o score de TODOS os clientes
  -- da PLATAFORMA inteira, não só do próprio tenant.
  for v_client in select profile_id from clients where tenant_id = current_tenant_id() loop
    perform recalculate_client_score(v_client.profile_id);
  end loop;
end;
$$;

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
  p_pix_key text default null,
  p_referred_by_client_id uuid default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_referrals_enabled boolean;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c: sem esta checagem, um gerente conseguia editar nome/CPF/
  -- telefone/limite de crédito de cliente de QUALQUER tenant da plataforma.
  if not exists (select 1 from clients where profile_id = p_client_id and tenant_id = v_tenant_id) then
    raise exception 'FORBIDDEN';
  end if;

  -- Recurso "Indicações" é exclusivo do Tenant #1 (ver tenants.referrals_
  -- enabled) — trava o valor em NULL sempre que o tenant não tem o recurso
  -- ligado, não importa o que o front-end mandar em p_referred_by_client_id.
  select referrals_enabled into v_referrals_enabled from tenants where id = v_tenant_id;

  update profiles set full_name = p_full_name, cpf = p_cpf, phone = p_phone, updated_at = now()
    where id = p_client_id;

  update clients set credit_limit = p_credit_limit,
    client_group = p_client_group, notes = p_notes,
    company = p_company, job_title = p_job_title, salary = p_salary, pix_key = p_pix_key,
    referred_by_client_id = case when coalesce(v_referrals_enabled, false) then p_referred_by_client_id else null end
    where profile_id = p_client_id;
end;
$$;

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
  -- Fase 1c: sem o filtro de tenant_id, um gerente editava contrato de
  -- qualquer tenant informando o id direto.
  where id = p_contract_id and tenant_id = current_tenant_id();
end;
$$;

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

  -- Fase 1c: sem o filtro de tenant_id, um gerente editava/reagendava
  -- parcela de qualquer tenant informando o id direto.
  select * into v_installment from installments where id = p_installment_id and tenant_id = current_tenant_id();
  if v_installment.id is null then raise exception 'NOT_FOUND'; end if;

  -- Não deixa o novo valor ficar abaixo do que já foi pago (parcial ou
  -- integralmente) — sem essa checagem, o saldo restante (amount_due -
  -- paid_partial) ficava negativo, e "Pago parcial: resta R$-X" aparecia
  -- nas telas do cliente.
  if p_principal_share < v_installment.principal_paid_partial
    or p_interest_share < v_installment.interest_paid_partial
  then
    raise exception 'AMOUNT_BELOW_ALREADY_PAID';
  end if;

  update installments set
    due_date = p_due_date,
    principal_share = p_principal_share,
    interest_share = p_interest_share,
    -- Se a parcela já foi reconhecida como perda, o valor perdido precisa
    -- acompanhar a correção do capital — senão uma edição posterior (ex:
    -- corrigir um valor digitado errado) deixaria o abate do lucro
    -- registrado num mês antigo desatualizado em relação ao capital real.
    principal_lost = case when status = 'perda' then greatest(0, p_principal_share - v_installment.principal_paid_partial) else principal_lost end
  where id = p_installment_id;

  -- Reconciliação: mesmo raciocínio de create_loan_contract — a soma do
  -- capital de todas as parcelas do contrato precisa continuar batendo com
  -- o capital contratado, dentro de uma tolerância de centavos de
  -- arredondamento. Sem isso, um typo no valor da parcela (ex: 5000 em vez
  -- de 500) muda silenciosamente o capital total do contrato, distorcendo
  -- o limite de crédito consumido (client_outstanding_principal) sem
  -- nenhum aviso pro admin.
  select installments_count, principal_amount into v_installments_count, v_principal_amount
    from loan_contracts where id = v_installment.contract_id;
  select coalesce(sum(principal_share), 0) into v_principal_sum
    from installments where contract_id = v_installment.contract_id;
  if abs(v_principal_sum - v_principal_amount) > greatest(0.02 * v_installments_count, 0.02) then
    raise exception 'PRINCIPAL_MISMATCH';
  end if;
end;
$$;

create or replace function update_payment_fee(
  p_payment_id uuid,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  -- Fase 1c: sem o filtro de tenant_id, um gerente editava a taxa de um
  -- pagamento de qualquer tenant informando o id direto.
  if not exists (select 1 from payments where id = p_payment_id and tenant_id = current_tenant_id()) then raise exception 'NOT_FOUND'; end if;

  update payments set
    has_operational_fee = p_has_operational_fee,
    operational_fee_amount = coalesce(p_operational_fee_amount, 0)
  where id = p_payment_id and tenant_id = current_tenant_id();
end;
$$;

create or replace function delete_contract(p_contract_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  -- Fase 1c: confirma que o contrato pertence ao próprio tenant ANTES de
  -- excluir qualquer coisa — sem isso, um gerente conseguia apagar contrato
  -- (e todo o histórico ligado) de QUALQUER tenant informando o id direto.
  if not exists (select 1 from loan_contracts where id = p_contract_id and tenant_id = current_tenant_id()) then
    raise exception 'NOT_FOUND';
  end if;
  delete from payments where contract_id = p_contract_id;
  delete from renewal_cycles where contract_id = p_contract_id;
  delete from installments where contract_id = p_contract_id;
  update loan_requests set resulting_contract_id = null where resulting_contract_id = p_contract_id;
  delete from loan_contracts where id = p_contract_id;
end;
$$;

create or replace function update_gerente_profile(
  p_gerente_id uuid,
  p_full_name text,
  p_phone text,
  p_active boolean
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  -- Só o admin primário edita conta de gerente (2026-07-11, decisão
  -- explícita do usuário) — antes qualquer gerente conseguia editar
  -- qualquer outro, inclusive reativar/desativar contas. Fase 1c: filtro de
  -- tenant_id evita que o admin primário de um tenant edite gerente de
  -- OUTRO tenant.
  if not is_primary_admin() then raise exception 'FORBIDDEN'; end if;
  update profiles set full_name = p_full_name, phone = p_phone, active = p_active, updated_at = now()
    where id = p_gerente_id and role = 'gerente' and tenant_id = current_tenant_id();
end;
$$;

create or replace function approve_client(p_client_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant_id := current_tenant_id();
  -- Fase 1c: sem o filtro de tenant_id, um gerente aprovava cadastro de
  -- cliente de QUALQUER tenant informando o id direto.
  update clients set approval_status = 'aprovado', decided_by = auth.uid(), decided_at = now(), decision_reason = null
    where profile_id = p_client_id and tenant_id = v_tenant_id;

  insert into notifications_log (recipient_id, event, channel, title, body, tenant_id)
  values (p_client_id, 'solicitacao_aprovada', 'in_app', 'Cadastro aprovado',
          'Sua conta foi aprovada. Você já pode usar o SIGES normalmente.', v_tenant_id);
end;
$$;

create or replace function reject_client(p_client_id uuid, p_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant_id := current_tenant_id();
  update clients set approval_status = 'rejeitado', decided_by = auth.uid(), decided_at = now(), decision_reason = p_reason
    where profile_id = p_client_id and tenant_id = v_tenant_id;

  insert into notifications_log (recipient_id, event, channel, title, body, tenant_id)
  values (p_client_id, 'solicitacao_reprovada', 'in_app', 'Cadastro não aprovado',
          coalesce('Motivo: ' || p_reason, 'Seu cadastro não foi aprovado.'), v_tenant_id);
end;
$$;

create or replace function log_audit_event(
  p_action text,
  p_description text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_actor_role text;
  v_tenant_id uuid;
begin
  if v_actor_id is not null then
    select full_name, role::text, tenant_id into v_actor_name, v_actor_role, v_tenant_id from profiles where id = v_actor_id;
  end if;
  -- tenant_id fica NULL quando não há sessão (ex: tentativa de login falha,
  -- onde v_actor_id já é null e não há profile pra resolver tenant nenhum) —
  -- mesmo design nullable de audit_log já decidido na Fase 1a.
  insert into audit_log (actor_id, actor_name, actor_role, action, description, metadata, tenant_id)
  values (v_actor_id, coalesce(v_actor_name, 'Anônimo'), v_actor_role, p_action, p_description, coalesce(p_metadata, '{}'::jsonb), v_tenant_id);

  -- Retenção: mantém só os 500 eventos mais recentes (pedido do usuário,
  -- 2026-07-30) — poda a cada insert, direto aqui, em vez de depender de um
  -- cron separado (a tabela nunca cresce ilimitada, mesmo que o cron diário
  -- falhe ou não rode). Volume de inserts é baixo (uma ação por vez), então
  -- o custo desse DELETE extra a cada chamada é desprezível.
  -- Fase 1c: poda por TENANT (não mais pela tabela inteira) — sem isso, um
  -- tenant com muita atividade podia empurrar pra fora o histórico de OUTRO
  -- tenant, incluindo o do dono da plataforma. `is not distinct from` trata
  -- NULL corretamente (eventos sem tenant são podados entre si, à parte).
  delete from audit_log where tenant_id is not distinct from v_tenant_id and id in (
    select id from audit_log where tenant_id is not distinct from v_tenant_id order by created_at desc offset 500
  );
end;
$$;

create or replace function wipe_all_business_data()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  if not is_primary_admin() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c — ACHADO MAIS GRAVE de toda a auditoria: cada "where true" abaixo
  -- apagava a tabela INTEIRA, de TODOS os tenants da plataforma. O admin
  -- primário de qualquer empresa cliente do SaaS conseguia, sem querer ou
  -- não, apagar os dados de TODAS as outras empresas de uma vez. Agora cada
  -- delete é escopado ao próprio tenant.
  delete from payments where tenant_id = v_tenant_id;
  delete from renewal_cycles where tenant_id = v_tenant_id;
  delete from installments where tenant_id = v_tenant_id;
  delete from loan_contracts where tenant_id = v_tenant_id;
  delete from loan_requests where tenant_id = v_tenant_id;
  delete from notifications_log where tenant_id = v_tenant_id;
  delete from push_subscriptions where tenant_id = v_tenant_id;
  delete from clients where tenant_id = v_tenant_id;
  delete from profiles where role = 'cliente' and tenant_id = v_tenant_id;
end;
$$;


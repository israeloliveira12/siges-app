-- ============================================================================
-- MIGRATION 019 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_018)
--
-- Rodada de correções de bugs reais + QA crítico completo do sistema:
--
-- 1) Exclusão de cliente falhava para praticamente qualquer cliente real —
--    bloqueada por duas FKs sem ON DELETE: notifications_log.recipient_id
--    (qualquer cliente que já recebeu 1 notificação, o que inclui a própria
--    notificação de aprovação de cadastro) e loan_requests.client_id
--    (qualquer cliente que já solicitou um empréstimo). Ambas viram CASCADE.
--
-- 2) Solicitação de empréstimo (loan_requests) acima do limite de crédito não
--    tinha NENHUMA validação no servidor (só um aviso no JS que nem impedia o
--    envio) — trigger novo trg_check_credit_limit_request bloqueia de verdade.
--
-- 3) [QA crítico] Gerente desativado conseguia se REATIVAR sozinho via PATCH
--    direto em profiles (a trigger de anti-escalação de privilégio não
--    cobria a coluna `active`) — agora cobre.
--
-- 4) [QA crítico] api/delete-client.js não validava que o alvo era realmente
--    um CLIENTE — um gerente secundário podia apagar a conta de QUALQUER
--    usuário (inclusive o Administrador primário) passando o profile_id dele
--    como client_id. Fix é só no arquivo .js (getTargetProfile), sem SQL.
--
-- 5) [QA crítico] renew_installment não revalidava o status da parcela/ciclo
--    depois do FOR UPDATE — duplo-clique ou dois gerentes renovando a mesma
--    parcela quase ao mesmo tempo gerava DOIS renewal_cycles + payments
--    duplicados, inflando silenciosamente carteira ativa/recebíveis/lucro em
--    todo o sistema. Agora rejeita com INSTALLMENT_NOT_PAYABLE, mesmo padrão
--    já usado em receive_payment/receive_cycle_payment. Também passou a
--    validar p_interest_only_amount >= 0 (defesa em profundidade).
--
-- 6) [QA alto] recalculate_client_score()/recalculate_all_scores() não
--    checavam is_gerente() — qualquer cliente autenticado podia forçar
--    recálculo de score (próprio ou de terceiros) via RPC direta.
--
-- 7) [QA alto] system_settings (update) e planning_debts (RLS geral) usavam
--    is_gerente() em vez de is_primary_admin() — um gerente secundário podia
--    alterar taxas/thresholds/caixa/planejamento via REST direto, mesmo
--    essas telas sendo exclusivas do Administrador só na UI.
-- ============================================================================

-- --- (1) ---

alter table notifications_log drop constraint notifications_log_recipient_id_fkey;
alter table notifications_log
  add constraint notifications_log_recipient_id_fkey
  foreign key (recipient_id) references profiles(id) on delete cascade;

alter table loan_requests drop constraint loan_requests_client_id_fkey;
alter table loan_requests
  add constraint loan_requests_client_id_fkey
  foreign key (client_id) references clients(profile_id) on delete cascade;

-- --- (2) ---

create or replace function trg_check_credit_limit_request()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_limit numeric;
begin
  select credit_limit into v_limit from clients where profile_id = new.client_id;
  if (client_outstanding_principal(new.client_id) + new.requested_amount) > coalesce(v_limit, 0) then
    raise exception 'CREDIT_LIMIT_EXCEEDED';
  end if;
  return new;
end;
$$;

drop trigger if exists before_insert_loan_request on loan_requests;
create trigger before_insert_loan_request
  before insert on loan_requests
  for each row execute function trg_check_credit_limit_request();

-- --- (3) ---

create or replace function prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if (new.role is distinct from old.role
      or new.is_primary_admin is distinct from old.is_primary_admin
      or new.active is distinct from old.active)
     and not is_primary_admin()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: só o administrador primário pode alterar papel/privilégio/status de uma conta';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_profile_privilege_escalation on profiles;
create trigger trg_prevent_profile_privilege_escalation
  before update of role, is_primary_admin, active on profiles
  for each row execute function prevent_profile_privilege_escalation();

-- --- (4) sem SQL: ver api/delete-client.js ---

-- --- (5) ---

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
  v_status installment_status;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  if p_interest_only_amount < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if p_source_type = 'installment' then
    select i.contract_id, i.principal_share, i.interest_share, i.status
      into v_contract_id, v_principal, v_interest, v_status
      from installments i where i.id = p_source_id for update;
  else
    select rc.contract_id, 0, (rc.full_debt_amount - 0), rc.status
      into v_contract_id, v_principal, v_interest, v_status
      from renewal_cycles rc where rc.id = p_source_id for update;
    select rc.full_debt_amount into v_full_debt from renewal_cycles rc where rc.id = p_source_id;
    v_principal := 0;
    v_interest := v_full_debt;
  end if;

  if v_status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
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

-- --- (6) ---

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

  for v_client in select profile_id from clients loop
    perform recalculate_client_score(v_client.profile_id);
  end loop;
end;
$$;

-- --- (7) ---

drop policy if exists "settings_gerente_update" on system_settings;
create policy "settings_gerente_update" on system_settings for update using (is_primary_admin());

drop policy if exists "planning_debts_gerente_all" on planning_debts;
create policy "planning_debts_gerente_all" on planning_debts for all
  using (is_primary_admin()) with check (is_primary_admin());

-- ============================================================================
-- FIM DA MIGRATION 019
-- ============================================================================

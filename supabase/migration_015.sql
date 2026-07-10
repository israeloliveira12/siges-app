-- ============================================================================
-- MIGRATION 015 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_014)
--
-- Cobre: corrige o score de crédito pra nunca aparecer nas duas listas do
-- ranking ao mesmo tempo. Regra: cliente novo começa e permanece com score
-- 50 até quitar o primeiro contrato ou fazer a primeira renovação — só a
-- partir desse marco ("graduação") os BÔNUS de comportamento passam a subir
-- o score, começando de 70. Mas perda e atraso (histórico OU atual) são
-- sinais de risco que sempre penalizam o score, graduado ou não — não ficam
-- escondidos atrás da graduação. Listas do ranking viram uma partição
-- estrita por score (>=70 = melhores, <70 = piores), então não há mais como
-- o mesmo cliente cair nas duas.
--
-- IMPORTANTE: recalculate_client_score(uuid) mantém o mesmo nome e parâmetro
-- — não precisa de "drop function" antes do "create or replace".
-- ============================================================================

alter table clients alter column score_tier set default 'Atenção';

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
  v_raw numeric; v_score numeric;
begin
  select count(*) filter (where i.status = 'paga'),
         count(*) filter (where i.status = 'paga' and i.paid_at::date <= i.due_date),
         count(*) filter (where i.status = 'paga' and i.paid_at::date < i.due_date)
    into v_total, v_on_time, v_early
    from installments i join loan_contracts lc on lc.id = i.contract_id
    where lc.client_id = p_client_id and i.due_date > current_date - interval '365 days';

  select coalesce(avg(i.paid_at::date - i.due_date), 0) into v_avg_delay
    from installments i join loan_contracts lc on lc.id = i.contract_id
    where lc.client_id = p_client_id and i.status = 'paga' and i.paid_at::date > i.due_date;

  select count(*) into v_quitados from loan_contracts
    where client_id = p_client_id and status = 'quitado';

  select exists(
    select 1 from installments i join loan_contracts lc on lc.id = i.contract_id
    where lc.client_id = p_client_id and i.status = 'paga'
      and i.paid_at::date > i.due_date and i.paid_at > now() - interval '90 days'
  ) into v_recovery;

  select count(*) into v_renewals_on_time from renewal_cycles rc
    join loan_contracts lc on lc.id = rc.contract_id
    where lc.client_id = p_client_id and rc.status = 'paga' and rc.paid_at::date <= rc.new_due_date;

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
    v_raw :=
      40 * coalesce(v_on_time::numeric / nullif(v_total, 0), 0.5) +
      20 * coalesce(v_early::numeric / nullif(v_total, 0), 0.3) +
      (20 - v_delay_penalty) +
      least(10, v_quitados * 2) +
      (case when v_recovery then 5 else 0 end) +
      least(5, v_renewals_on_time * 1) -
      v_overdue_penalty - v_perda_penalty;

    -- v_raw sem nenhum evento extra vale 46 (20+6+20) — deslocamos +24 pra
    -- recentralizar em 70 no momento da graduação, preservando os mesmos
    -- incrementos/penalidades de comportamento daí pra frente.
    v_score := v_raw + 24;
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

select recalculate_all_scores();

-- ============================================================================
-- FIM DA MIGRATION 015
-- ============================================================================

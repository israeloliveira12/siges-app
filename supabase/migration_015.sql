-- ============================================================================
-- MIGRATION 015 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_014)
--
-- Cobre: corrige o score de crédito pra nunca aparecer nas duas listas do
-- ranking ao mesmo tempo. Regra nova: cliente novo começa e permanece com
-- score 50 até quitar o primeiro contrato ou fazer a primeira renovação —
-- só a partir desse marco ("graduação") o comportamento financeiro real
-- passa a subir/descer o score, começando de 70. Listas do ranking viram
-- uma partição estrita por score (>=70 = melhores, <70 = piores), então não
-- há mais como o mesmo cliente cair nas duas.
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
  v_any_renewal_paid boolean; v_graduated boolean; v_raw numeric; v_score numeric;
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

  -- Cliente novo começa e permanece com score 50 até quitar o primeiro
  -- contrato ou fazer a primeira renovação — só a partir desse marco
  -- ("graduação") o comportamento financeiro passa a mexer no score.
  v_graduated := (v_quitados > 0) or v_any_renewal_paid;

  if not v_graduated then
    v_score := 50;
  else
    v_raw :=
      40 * coalesce(v_on_time::numeric / nullif(v_total, 0), 0.5) +
      20 * coalesce(v_early::numeric / nullif(v_total, 0), 0.3) +
      greatest(0, 20 - v_avg_delay * 2) +
      least(10, v_quitados * 2) +
      (case when v_recovery then 5 else 0 end) +
      least(5, v_renewals_on_time * 1) +
      (case when v_has_perda then -30 else 0 end);

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

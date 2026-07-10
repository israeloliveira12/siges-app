-- ============================================================================
-- MIGRATION 014 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_013)
--
-- Cobre: nova regra de score de crédito (aprovada pelo usuário, com um ajuste
-- pedido por ele): renovações pagas em dia passam a SOMAR pontos (antes
-- subtraíam), contratos quitados e recuperação de atraso viram critérios
-- novos, contrato em perda vira penalidade forte e única — e reprovações de
-- solicitação de empréstimo DEIXAM de ser critério de pontuação (removidas
-- por completo, sem substituto).
--
-- IMPORTANTE: recalculate_client_score(uuid) mantém o mesmo nome e o mesmo
-- parâmetro (p_client_id uuid) — não precisa de "drop function" antes do
-- "create or replace" (a assinatura não mudou, só o corpo da função).
--
-- Como a fórmula muda, os scores existentes ficam desatualizados até o
-- próximo evento de cada cliente — por isso a migration já roda
-- recalculate_all_scores() no final, recalculando todo mundo na hora.
-- ============================================================================

create or replace function recalculate_client_score(p_client_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_total int; v_on_time int; v_early int; v_avg_delay numeric;
  v_quitados int; v_recovery boolean; v_renewals_on_time int; v_has_perda boolean;
  v_score numeric;
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

  select exists(
    select 1 from loan_contracts where client_id = p_client_id and status = 'perda'
  ) into v_has_perda;

  -- Reprovações de solicitação NÃO entram mais como critério (decisão
  -- explícita do usuário — nunca deve ser usado pra avaliar o cliente).
  v_score :=
    40 * coalesce(v_on_time::numeric / nullif(v_total, 0), 0.5) +
    20 * coalesce(v_early::numeric / nullif(v_total, 0), 0.3) +
    greatest(0, 20 - v_avg_delay * 2) +
    least(10, v_quitados * 2) +
    (case when v_recovery then 5 else 0 end) +
    least(5, v_renewals_on_time * 1) +
    (case when v_has_perda then -30 else 0 end);

  v_score := least(100, greatest(0, round(v_score)));

  update clients set
    score = v_score,
    score_tier = case
      when v_score >= 80 then 'Ouro'
      when v_score >= 65 then 'Bom'
      when v_score >= 45 then 'Atenção'
      else 'Alto risco'
    end,
    score_updated_at = now()
  where profile_id = p_client_id;
end;
$$;

select recalculate_all_scores();

-- ============================================================================
-- FIM DA MIGRATION 014
-- ============================================================================

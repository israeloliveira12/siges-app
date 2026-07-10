-- ============================================================================
-- MIGRATION 016 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_015)
--
-- Cobre: torna o score de crédito bem mais rígido pra chegar em 90/95/100.
-- Bug corrigido: um único contrato de parcela única quitado adiantado batia
-- ~100 pontos direto (a fórmula anterior somava % em dia + % adiantado sem
-- nenhum fator de volume/histórico). Nova regra (aprovada pelo usuário):
-- depois da graduação, o bônus de comportamento é o PRODUTO de qualidade
-- (consistência de pagamento) × maturidade (volume de histórico, com
-- retornos decrescentes via 1 - e^(-volume/8)), não mais a soma direta.
-- Efeito: 70-80 continua alcançável com 1-2 contratos bons, mas 90+ exige
-- dezenas de eventos positivos sustentados — impossível de forçar rápido.
--
-- IMPORTANTE: recalculate_client_score(uuid) mantém o mesmo nome e parâmetro
-- — não precisa de "drop function" antes do "create or replace".
--
-- Esta migration já recalcula o score de TODOS os clientes existentes ao
-- final (recalculate_all_scores()), então nenhum passo manual extra é
-- necessário além de rodar este arquivo.
-- ============================================================================

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

-- Recalcula o score de todos os clientes existentes com a nova regra.
select recalculate_all_scores();

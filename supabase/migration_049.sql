-- ============================================================================
-- migration_049.sql — Editar/reagendar ciclo de renovação
--
-- Até aqui só a PARCELA tinha como ser reagendada (update_installment_schedule).
-- O ciclo de renovação nunca teve equivalente — decisão anterior registrada em
-- comentário no próprio gerente-contratos-lista.js ("ciclo de renovação, que
-- nunca teve um botão de editar"). Na prática isso significava que, chegando o
-- dia do vencimento de uma renovação, o administrador tinha só três saídas:
-- renovar de novo (exige o cliente pagar juros), quitar (exige o valor cheio),
-- ou deixar vencer e acumular encargo. Não havia como simplesmente adiar.
--
-- Esta migration cria a simetria que faltava.
-- ============================================================================


-- ============================================================================
-- 1. update_cycle_schedule() — espelho de update_installment_schedule()
--
-- Deixa o administrador mover o vencimento do ciclo e, se tiver negociado um
-- acréscimo pelos dias extras, ajustar o valor total junto. Deixar o valor
-- como veio = adiamento puro (cortesia, sem cobrar nada a mais).
-- ============================================================================

create or replace function update_cycle_schedule(
  p_cycle_id uuid,
  p_new_due_date date,
  p_full_debt_amount numeric
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_cycle renewal_cycles%rowtype;
  v_principal numeric;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  -- Mesmo filtro de tenant de todas as RPCs de escrita (Fase 1c): sem ele um
  -- gerente reagendaria o ciclo de qualquer empresa informando o id direto.
  -- `for update` trava a linha — sem isso, dois administradores adiando o
  -- mesmo ciclo ao mesmo tempo poderiam sobrescrever um ao outro.
  select * into v_cycle from renewal_cycles
    where id = p_cycle_id and tenant_id = current_tenant_id()
    for update;
  if v_cycle.id is null then
    raise exception 'NOT_FOUND';
  end if;

  if p_new_due_date is null then
    raise exception 'INVALID_DATE';
  end if;
  if p_full_debt_amount is null or p_full_debt_amount <= 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  -- receive_cycle_payment() calcula os juros do recebimento como
  -- (full_debt_amount - loan_contracts.principal_amount). Se o total do ciclo
  -- cair abaixo do capital do contrato, esse cálculo vira NEGATIVO e a
  -- quitação entraria nos relatórios como prejuízo, sem aviso nenhum — o
  -- mesmo tipo de erro silencioso que AMOUNT_BELOW_ALREADY_PAID evita do lado
  -- da parcela.
  select principal_amount into v_principal
    from loan_contracts where id = v_cycle.contract_id;
  if p_full_debt_amount < coalesce(v_principal, 0) then
    raise exception 'AMOUNT_BELOW_PRINCIPAL';
  end if;

  update renewal_cycles set
    new_due_date = p_new_due_date,
    full_debt_amount = p_full_debt_amount,
    -- Adiar um ciclo ATRASADO para uma data futura tem que tirá-lo do atraso —
    -- é exatamente o objetivo da operação. Sem isto ele continuaria contando
    -- como inadimplente em Cobrar, no Dashboard e no score do cliente, mesmo
    -- com o vencimento já remarcado. O inverso também vale (remarcar para uma
    -- data já passada devolve o ciclo para 'atrasada').
    --
    -- Só mexe em pendente/atrasada: 'paga', 'renovada' e 'perda' são estados
    -- terminais e a edição neles é correção de registro histórico, não
    -- reagendamento. `principal_lost` também não é tocado — mark_cycle_loss()
    -- grava ali o CAPITAL do contrato, não o total do ciclo, então mudar
    -- full_debt_amount não altera o valor da perda já contabilizada.
    status = case
      when status in ('pendente', 'atrasada')
        then (case when p_new_due_date < current_date then 'atrasada' else 'pendente' end)::installment_status
      else status
    end
  where id = p_cycle_id;

  -- O status do CONTRATO deriva do estado das parcelas/ciclos: tirar o único
  -- ciclo em atraso precisa refletir em loan_contracts.status ('atrasado' ->
  -- 'em_aberto'), senão o contrato continua marcado como atrasado numa tela e
  -- em dia na outra.
  perform recompute_contract_status(v_cycle.contract_id);
end;
$$;


-- ============================================================================
-- FIM — migration_049.sql
-- ============================================================================

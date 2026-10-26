-- ============================================================================
-- migration_053.sql — Reajuste em lote de dívidas planejadas que se repetem
--
-- Pedido do usuário (2026-10-25): dívidas como "Salário" se repetem por vários
-- meses, mas o valor muda a cada mês. Para dar um aumento de R$ 12 no salário,
-- o sistema precisa somar R$ 12 em TODOS os salários previstos — mesmo que cada
-- um tenha um valor diferente (3.000 vira 3.012, 3.100 vira 3.112, ...).
--
-- POR QUE UMA RPC E NÃO UPDATE PELO NAVEGADOR
-- O PostgREST não aceita expressão em UPDATE (não existe "amount = amount + 12"
-- pela API); o navegador teria que mandar um UPDATE por linha, e uma queda no
-- meio deixaria metade dos salários reajustados e metade não — sem ninguém
-- perceber. Aqui é uma única transação: ou todos mudam ou nenhum.
--
-- POR QUE RECEBE OS IDs E NÃO O NOME DA DÍVIDA
-- A tela mostra uma prévia (cada mês, valor atual -> novo). Se o servidor
-- reinterpretasse "o mesmo nome" por conta própria, qualquer diferença de
-- normalização entre JavaScript e Postgres (maiúsculas acentuadas, espaços)
-- faria o banco alterar linhas diferentes das que a pessoa viu e confirmou.
-- Recebendo os IDs, o que foi visto é exatamente o que muda.
--
-- Nenhuma tabela é alterada: só uma função nova. Sem efeito nenhum até a tela
-- chamá-la.
-- ============================================================================

create or replace function adjust_planning_debts(
  p_ids uuid[],
  p_mode text,
  p_value numeric
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_expected integer;
  v_below_zero integer;
  v_updated integer;
begin
  -- Mesma regra da tabela: a policy de planning_debts exige is_platform_owner().
  -- SECURITY DEFINER ignora RLS, então a checagem precisa estar aqui dentro.
  if not is_platform_owner() then
    raise exception 'FORBIDDEN';
  end if;

  v_tenant_id := current_tenant_id();

  if p_mode is null or p_mode not in ('add', 'percent') then
    raise exception 'INVALID_MODE';
  end if;

  -- Reajuste de zero não faz nada; é sempre engano (campo vazio, por exemplo).
  if p_value is null or p_value = 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if p_ids is null or coalesce(array_length(p_ids, 1), 0) = 0 then
    raise exception 'NOT_FOUND';
  end if;

  select count(distinct t.id) into v_expected from unnest(p_ids) as t(id);

  -- Valor novo, arredondado a centavos exatamente como será gravado. Calcular o
  -- teste e a gravação pela mesma expressão evita a divergência de 1 centavo
  -- entre "passou na checagem" e "o que foi salvo".
  --   add     : amount + p_value
  --   percent : amount * (1 + p_value/100)   (p_value negativo = redução)
  select count(*) into v_below_zero
    from planning_debts d
   where d.id = any(p_ids)
     and d.tenant_id = v_tenant_id
     and round(
           case when p_mode = 'add'
                then d.amount + p_value
                else d.amount * (100 + p_value) / 100
           end, 2) <= 0;

  -- A tabela tem check (amount > 0). Recusar aqui devolve um erro que a tela
  -- sabe explicar, em vez de uma violação de constraint crua — e, como é tudo
  -- ou nada, um único valor inválido cancela o reajuste inteiro.
  if v_below_zero > 0 then
    raise exception 'AMOUNT_BELOW_ZERO';
  end if;

  update planning_debts d
     set amount = round(
           case when p_mode = 'add'
                then d.amount + p_value
                else d.amount * (100 + p_value) / 100
           end, 2)
   where d.id = any(p_ids)
     and d.tenant_id = v_tenant_id;

  get diagnostics v_updated = row_count;

  -- Algum ID não existe ou é de outra empresa: aborta tudo (a exceção desfaz o
  -- UPDATE acima). Sem isto, um id inválido reajustaria só parte do que a
  -- pessoa viu na prévia, em silêncio.
  if v_updated <> v_expected then
    raise exception 'NOT_FOUND';
  end if;

  return v_updated;
end;
$$;

revoke all on function adjust_planning_debts(uuid[], text, numeric) from public, anon;
grant execute on function adjust_planning_debts(uuid[], text, numeric) to authenticated;

-- ============================================================================
-- FIM — migration_053.sql
-- ============================================================================

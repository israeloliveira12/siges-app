-- Migration 025: nova função pra editar a taxa operacional de ENTRADA de um
-- pagamento já recebido — pedido do usuário: não havia como corrigir a taxa
-- cobrada em cima de uma parcela já paga. Diferente de update_contract (que
-- edita a taxa de SAÍDA, cobrada uma vez por contrato, em loan_contracts),
-- essa taxa é cobrada por PAGAMENTO e fica em payments.operational_fee_amount.
-- net_profit (coluna gerada = interest_component - operational_fee_amount)
-- recalcula sozinho ao mudar esse valor, então relatórios/lucro líquido já
-- refletem o ajuste sem precisar tocar em mais nenhum lugar.

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
  if not exists (select 1 from payments where id = p_payment_id) then raise exception 'NOT_FOUND'; end if;

  update payments set
    has_operational_fee = p_has_operational_fee,
    operational_fee_amount = coalesce(p_operational_fee_amount, 0)
  where id = p_payment_id;
end;
$$;

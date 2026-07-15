-- Migration 024: permite editar/reagendar uma parcela em QUALQUER status
-- (inclusive já paga/renovada, ou de contrato já finalizado/quitado) — antes
-- a RPC só atualizava linhas com status in ('pendente', 'atrasada'), então o
-- UPDATE silenciosamente não fazia nada para parcelas já pagas/renovadas,
-- mesmo que o botão de editar aparecesse no admin. A proteção contra reduzir
-- o valor abaixo do que já foi efetivamente recebido (AMOUNT_BELOW_ALREADY_PAID)
-- continua valendo sempre. Assinatura da função não muda (mesmos parâmetros),
-- então create or replace substitui a versão antiga sem precisar de drop.

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
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  select * into v_installment from installments where id = p_installment_id;
  if v_installment.id is null then raise exception 'NOT_FOUND'; end if;

  if p_principal_share < v_installment.principal_paid_partial
    or p_interest_share < v_installment.interest_paid_partial
  then
    raise exception 'AMOUNT_BELOW_ALREADY_PAID';
  end if;

  update installments set
    due_date = p_due_date,
    principal_share = p_principal_share,
    interest_share = p_interest_share
  where id = p_installment_id;
end;
$$;

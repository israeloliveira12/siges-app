-- Migration 040 — Bug real: solicitação de empréstimo de cliente de empresa
-- assinante caía na caixa "Solicitações" do Administrador Master
--
-- Causa: `cliente-solicitar.js` nunca envia `tenant_id` no insert em
-- `loan_requests` — a coluna sempre caía no DEFAULT (`default_tenant_id()`,
-- que resolve pro Tenant #1, o seu próprio negócio). Todo cliente de
-- QUALQUER empresa assinante que solicitava um empréstimo tinha a
-- solicitação parar sempre na caixa do Administrador Master, nunca na da
-- própria empresa dele.
--
-- Corrigido forçando `tenant_id = current_tenant_id()` (o tenant de quem
-- está inserindo, resolvido no servidor) dentro do trigger BEFORE INSERT
-- que já existia em loan_requests — nunca confiando em nada que o cliente
-- mandou (ou deixou de mandar) no corpo da requisição.

create or replace function trg_check_credit_limit_request()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_limit numeric;
begin
  new.tenant_id := current_tenant_id();

  select credit_limit into v_limit from clients where profile_id = new.client_id for update;
  if (client_outstanding_principal(new.client_id) + new.requested_amount) > coalesce(v_limit, 0) then
    raise exception 'CREDIT_LIMIT_EXCEEDED';
  end if;
  return new;
end;
$$;

-- Repara qualquer solicitação já existente que tenha caído no tenant
-- errado por causa do bug acima — realinha pro tenant real do cliente dono
-- da solicitação. Não afeta nenhuma linha que já estava correta.
update loan_requests lr
set tenant_id = p.tenant_id
from profiles p
where p.id = lr.client_id
  and lr.tenant_id <> p.tenant_id;

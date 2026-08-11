-- Migration 041 — Bug real: system_settings sem PK por tenant (bloqueava
-- Configurações de qualquer empresa assinante nova) + exclusão de empresa
-- pelo Administrador Master
--
-- Achado testando o fluxo completo de uma 2ª empresa em produção
-- (2026-08-10): a PK original de system_settings era só `id` (boolean,
-- sempre true) — sobrevivia do tempo de "singleton global", antes do pivô
-- SaaS. Isso nunca foi corrigido quando tenant_id foi adicionada, então o
-- banco só permitia UMA linha em toda a tabela — nenhuma empresa criada
-- depois da Fase 0 conseguia ter a própria linha de configurações. A tela
-- Configurações de QUALQUER empresa assinante nova ficava permanentemente
-- quebrada ("Não foi possível carregar as configurações agora").

-- ----------------------------------------------------------------------------
-- 1) system_settings — tenant_id vira a PK de verdade.
-- ----------------------------------------------------------------------------
alter table system_settings drop constraint system_settings_pkey;
alter table system_settings add primary key (tenant_id);

-- Cria a linha que falta pra toda empresa já existente sem uma.
insert into system_settings (tenant_id, company_name)
select t.id, t.name from tenants t
where not exists (select 1 from system_settings s where s.tenant_id = t.id);

-- Garante que toda empresa NOVA (qualquer caminho de criação) já nasce com
-- a própria linha de configurações.
create or replace function trg_create_default_settings_for_tenant()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into system_settings (tenant_id, company_name)
  values (new.id, new.name)
  on conflict (tenant_id) do nothing;
  return new;
end;
$$;

drop trigger if exists after_tenant_created on tenants;
create trigger after_tenant_created
  after insert on tenants
  for each row execute function trg_create_default_settings_for_tenant();

-- ----------------------------------------------------------------------------
-- 2) Excluir empresa — Administrador Master, empresa já suspensa, nunca a
--    própria. Devolve os profile_id (gerentes + clientes) do tenant pra
--    api/delete-tenant.js apagar via Admin API antes de apagar a linha de
--    tenants em si.
-- ----------------------------------------------------------------------------
create or replace function prepare_tenant_deletion(p_tenant_id uuid)
returns setof uuid
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  if p_tenant_id = current_tenant_id() then raise exception 'CANNOT_DELETE_OWN_TENANT'; end if;
  if not exists (select 1 from tenants where id = p_tenant_id) then raise exception 'NOT_FOUND'; end if;
  if (select active from tenants where id = p_tenant_id) then raise exception 'TENANT_MUST_BE_SUSPENDED'; end if;

  delete from payments where tenant_id = p_tenant_id;
  delete from renewal_cycles where tenant_id = p_tenant_id;
  delete from installments where tenant_id = p_tenant_id;
  delete from loan_contracts where tenant_id = p_tenant_id;
  delete from loan_requests where tenant_id = p_tenant_id;
  delete from notifications_log where tenant_id = p_tenant_id;
  delete from push_subscriptions where tenant_id = p_tenant_id;
  delete from planning_debts where tenant_id = p_tenant_id;
  delete from system_settings where tenant_id = p_tenant_id;
  delete from clients where tenant_id = p_tenant_id;
  update audit_log set tenant_id = null where tenant_id = p_tenant_id;

  return query select id from profiles where tenant_id = p_tenant_id;
end;
$$;

-- Migration 035 — SIGES vira plataforma: FASE 2 (seletor de modo)
--
-- Adiciona profiles.platform_owner — só você tem essa flag. É o que decide
-- se o seletor "Empréstimos / Plataforma SaaS" aparece no topbar. Diferente
-- de is_primary_admin (exclusivo por tenant — cada tenant pode ter o seu),
-- platform_owner é global à plataforma inteira: só existe UMA pessoa com
-- essa flag, você.
--
-- Trava de segurança: mesmo o admin primário do PRÓPRIO tenant não pode se
-- auto-promover a dono da plataforma via REST direto (isso concederia
-- acesso cross-tenant) — só service_role (uso interno) pode alterar essa
-- coluna. Reaproveita o trigger prevent_profile_privilege_escalation() que
-- já existia pra role/is_primary_admin/active, com uma regra própria e mais
-- rígida pra platform_owner.
--
-- ZERO MUDANÇA DE COMPORTAMENTO pra ninguém além de você: a coluna nasce
-- FALSE pra todo mundo, e só a linha sua recebe TRUE nesta migration.

alter table profiles add column platform_owner boolean not null default false;

update profiles set platform_owner = true
  where id = (select owner_profile_id from tenants order by created_at asc limit 1);

create or replace function prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if (new.role is distinct from old.role
      or new.is_primary_admin is distinct from old.is_primary_admin
      or new.active is distinct from old.active)
     and not is_primary_admin()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: só o administrador primário pode alterar papel/privilégio/status de uma conta';
  end if;

  -- platform_owner é mais rígido que os 3 campos acima: nem is_primary_
  -- admin() basta aqui — só service_role (uso interno/scripts
  -- administrativos), nunca uma sessão de usuário comum.
  if new.platform_owner is distinct from old.platform_owner
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: platform_owner só pode ser alterado internamente';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_profile_privilege_escalation on profiles;
create trigger trg_prevent_profile_privilege_escalation
  before update of role, is_primary_admin, active, platform_owner on profiles
  for each row execute function prevent_profile_privilege_escalation();

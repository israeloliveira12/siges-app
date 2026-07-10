-- ============================================================================
-- MIGRATION 018 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_017)
--
-- Cobre: só o admin primário ("Administrador" na UI) pode criar, editar ou
-- desativar contas de gerente daqui pra frente. Os demais gerentes continuam
-- vendo a lista em "Administradores", mas sem os botões de criar/editar.
--
-- Mudanças:
-- 1) update_gerente_profile agora exige is_primary_admin() (antes bastava
--    ser qualquer gerente ativo).
-- 2) Remove a policy "profiles_gerente_all" — dava a QUALQUER gerente,
--    mesmo secundário, permissão de escrever direto na tabela profiles via
--    REST, contornando os controles das RPCs. Nenhuma escrita legítima
--    dependia dela (todas passam por função security definer, que bypassa
--    RLS por ser dona da tabela).
-- 3) Nova trava (trigger) que impede qualquer UPDATE de `role` ou
--    `is_primary_admin` em profiles, exceto quando quem chama é o admin
--    primário OU a própria API interna (service_role, usada só pelas
--    serverless functions de /api ao criar/promover conta).
--
-- IMPORTANTE: update_gerente_profile mantém nome e mesmos 4 parâmetros —
-- não precisa de "drop function" antes do "create or replace".
-- ============================================================================

create or replace function update_gerente_profile(
  p_gerente_id uuid,
  p_full_name text,
  p_phone text,
  p_active boolean
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_primary_admin() then raise exception 'FORBIDDEN'; end if;
  update profiles set full_name = p_full_name, phone = p_phone, active = p_active, updated_at = now()
    where id = p_gerente_id and role = 'gerente';
end;
$$;

drop policy if exists "profiles_gerente_all" on profiles;

create or replace function prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if (new.role is distinct from old.role or new.is_primary_admin is distinct from old.is_primary_admin)
     and not is_primary_admin()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: só o administrador primário pode alterar papel/privilégio de uma conta';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_profile_privilege_escalation on profiles;
create trigger trg_prevent_profile_privilege_escalation
  before update of role, is_primary_admin on profiles
  for each row execute function prevent_profile_privilege_escalation();

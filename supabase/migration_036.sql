-- Migration 036 — SIGES vira plataforma: FASE 3 (gestão manual de tenants)
--
-- Adiciona a capacidade do Administrador Master (você) criar/editar/suspender
-- empresas clientes da plataforma, sem nenhuma cobrança envolvida ainda
-- (isso é Fase 5). Também fecha uma decisão pendente desde a Fase 1b: a tela
-- Auditoria nunca deve ser vista por usuário do SaaS, só por você.
--
-- ZERO MUDANÇA DE COMPORTAMENTO pra qualquer empresa que não seja a sua —
-- as novas funções só fazem algo quando quem chama é platform_owner.

-- ----------------------------------------------------------------------------
-- 1) is_platform_owner() — helper de RLS, mesmo padrão de is_gerente()/
--    is_primary_admin() já existentes.
-- ----------------------------------------------------------------------------
create or replace function is_platform_owner()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and platform_owner and active
  );
$$;

-- ----------------------------------------------------------------------------
-- 2) tenants — Administrador Master passa a ver TODAS as empresas (tela
--    "Empresas"), não só a própria.
-- ----------------------------------------------------------------------------
drop policy if exists "tenants_select" on tenants;
create policy "tenants_select" on tenants for select
  using (is_platform_owner() or (is_gerente() and id = current_tenant_id()));

-- ----------------------------------------------------------------------------
-- 3) audit_log — Auditoria vira exclusiva do Administrador Master (decisão
--    explícita do fundador, 2026-08-09: "não pode ser vista pelos usuários
--    do saas, apenas por mim"). Antes, qualquer gerente via a auditoria do
--    PRÓPRIO tenant; agora só platform_owner, com visão de TODOS os tenants.
-- ----------------------------------------------------------------------------
drop policy if exists "audit_log_select_gerente" on audit_log;
create policy "audit_log_select_platform_owner" on audit_log for select
  using (is_platform_owner());

-- ----------------------------------------------------------------------------
-- 4) Lista de empresas + estatísticas (tela "Empresas").
-- ----------------------------------------------------------------------------
create or replace function list_tenants_with_stats()
returns table (
  id uuid,
  name text,
  active boolean,
  referrals_enabled boolean,
  created_at timestamptz,
  owner_profile_id uuid,
  admin_name text,
  admin_email text,
  gerente_count bigint,
  cliente_count bigint,
  contract_count bigint
)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  return query
  select
    t.id, t.name, t.active, t.referrals_enabled, t.created_at, t.owner_profile_id,
    p.full_name, p.email,
    (select count(*) from profiles g where g.tenant_id = t.id and g.role = 'gerente'),
    (select count(*) from clients c where c.tenant_id = t.id),
    (select count(*) from loan_contracts lc where lc.tenant_id = t.id)
  from tenants t
  left join profiles p on p.id = t.owner_profile_id
  order by t.created_at asc;
end;
$$;

-- ----------------------------------------------------------------------------
-- 5) Renomear / (des)ativar uma empresa. Trava: nunca deixa o Administrador
--    Master desativar o PRÓPRIO tenant (se travasse a própria conta,
--    ninguém mais poderia reverter).
-- ----------------------------------------------------------------------------
create or replace function update_tenant(p_tenant_id uuid, p_name text, p_active boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  if p_tenant_id = current_tenant_id() and not p_active then
    raise exception 'CANNOT_DEACTIVATE_OWN_TENANT';
  end if;
  update tenants set
    name = coalesce(nullif(trim(p_name), ''), name),
    active = p_active
  where id = p_tenant_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6) Gate de login: bloqueia acesso de qualquer usuário (gerente OU
--    cliente) de uma empresa suspensa. Callable por qualquer autenticado —
--    só revela um boolean sobre o próprio tenant.
-- ----------------------------------------------------------------------------
create or replace function is_my_tenant_active()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select coalesce((select active from tenants where id = current_tenant_id()), true);
$$;

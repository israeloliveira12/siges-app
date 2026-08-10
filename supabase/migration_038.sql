-- Migration 038 — SIGES vira plataforma: FASE 4 (link de convite)
--
-- Cada empresa cliente da plataforma passa a ter um link de convite próprio
-- (`?convite=<token>`) pra seus clientes se cadastrarem já vinculados a ELA,
-- em vez de caírem por padrão no seu próprio tenant (Tenant #1). O token é
-- opaco e rotacionável — nunca o id real do tenant — pra poder ser
-- regenerado sem afetar a identidade interna da empresa.
--
-- ZERO MUDANÇA DE COMPORTAMENTO pra cadastros existentes/sem link: sem
-- `?convite=` na URL, tudo continua exatamente como sempre foi.

-- ----------------------------------------------------------------------------
-- 1) tenants.invite_token — cada empresa já existente recebe um token
--    aleatório automaticamente (default é avaliado por linha, não é um
--    valor fixo repetido).
-- ----------------------------------------------------------------------------
alter table tenants add column invite_token text not null unique
  default replace(gen_random_uuid()::text, '-', '');

-- ----------------------------------------------------------------------------
-- 2) handle_new_user() — passa a também resolver o tenant via invite_token
--    (cadastro público com link de convite), mantendo os dois caminhos que
--    já existiam (tenant_id direto — só fluxos servidor-a-servidor — e o
--    fallback pro próprio tenant de sempre).
-- ----------------------------------------------------------------------------
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant_id uuid;
begin
  -- Fase 1c (SaaS multi-empresa): 'tenant_id' em raw_user_meta_data resolve
  -- direto o tenant — usado só pelos fluxos SERVIDOR-A-SERVIDOR de criação
  -- de conta (api/create-user.js, api/create-tenant.js — service_role,
  -- tenant_id vem de um profile já autenticado no servidor, nunca do corpo
  -- da requisição HTTP). 'invite_token' (Fase 4) é o caminho pro cadastro
  -- PÚBLICO (login.js, cliente se autocadastrando com `?convite=<token>` na
  -- URL) — resolve_invite_token() já validou o token antes de mostrar o
  -- formulário, mas o valor final é sempre resolvido aqui de novo, no
  -- servidor, nunca confiando cegamente no que o navegador mandou. Sem
  -- nenhum dos dois campos (cadastro público comum, sem link de convite),
  -- cai no fallback de sempre — seu próprio tenant.
  v_tenant_id := coalesce(
    nullif(new.raw_user_meta_data->>'tenant_id', '')::uuid,
    (select id from tenants where invite_token = new.raw_user_meta_data->>'invite_token' and active),
    default_tenant_id()
  );

  insert into public.profiles (id, full_name, email, role, cpf, phone, tenant_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    lower(new.email),
    'cliente',
    new.raw_user_meta_data->>'cpf',
    new.raw_user_meta_data->>'phone',
    v_tenant_id
  )
  on conflict (id) do nothing;

  insert into public.clients (profile_id, company, job_title, salary, pix_key, client_group, tenant_id)
  values (
    new.id,
    new.raw_user_meta_data->>'company',
    new.raw_user_meta_data->>'job_title',
    nullif(new.raw_user_meta_data->>'salary', ''),
    new.raw_user_meta_data->>'pix_key',
    nullif(new.raw_user_meta_data->>'client_group', ''),
    v_tenant_id
  )
  on conflict (profile_id) do nothing;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3) list_tenants_with_stats() ganha a coluna invite_token — muda o
--    RETURNS TABLE, então precisa de DROP antes (CREATE OR REPLACE não
--    troca o tipo de retorno de uma função existente, só o corpo).
-- ----------------------------------------------------------------------------
drop function if exists list_tenants_with_stats();
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
  contract_count bigint,
  invite_token text
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
    (select count(*) from loan_contracts lc where lc.tenant_id = t.id),
    t.invite_token
  from tenants t
  left join profiles p on p.id = t.owner_profile_id
  order by t.created_at asc;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4) get_my_tenant_invite_info() — consultado pela tela Configurações.
-- ----------------------------------------------------------------------------
create or replace function get_my_tenant_invite_info()
returns table (invite_token text, company_name text)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not is_primary_admin() then raise exception 'FORBIDDEN'; end if;
  return query select t.invite_token, t.name from tenants t where t.id = current_tenant_id();
end;
$$;

-- ----------------------------------------------------------------------------
-- 5) regenerate_tenant_invite_token() — admin primário regenera o próprio
--    link; Administrador Master pode regenerar o de qualquer empresa
--    (suporte), passando p_tenant_id.
-- ----------------------------------------------------------------------------
create or replace function regenerate_tenant_invite_token(p_tenant_id uuid default null)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  v_target uuid;
  v_new_token text;
begin
  v_target := coalesce(p_tenant_id, current_tenant_id());
  if not (is_platform_owner() or (is_primary_admin() and v_target = current_tenant_id())) then
    raise exception 'FORBIDDEN';
  end if;
  v_new_token := replace(gen_random_uuid()::text, '-', '');
  update tenants set invite_token = v_new_token where id = v_target;
  return v_new_token;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6) resolve_invite_token() — pública (anon), chamada pela tela de cadastro
--    ANTES de qualquer sessão existir.
-- ----------------------------------------------------------------------------
create or replace function resolve_invite_token(p_token text)
returns table (company_name text)
language sql
stable
security definer set search_path = public
as $$
  select name from tenants where invite_token = p_token and active;
$$;

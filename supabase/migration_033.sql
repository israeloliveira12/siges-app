-- Migration 033 — "Indicações" vira recurso exclusivo do Tenant #1 (você)
--
-- Decisão do fundador (2026-08-09): a feature de indicação de cliente
-- (cliente indica outro cliente, acompanha a dívida de quem indicou) só faz
-- sentido pro seu negócio de crédito — nenhuma empresa cliente do SaaS deve
-- ter essa opção, nem no cadastro/edição de cliente (campo "Indicado por"),
-- nem como menu ("Indicações") pros clientes dela.
--
-- Modelagem: `tenants.referrals_enabled`, boolean, default FALSE pra
-- qualquer tenant novo — só o Tenant #1 (você) recebe TRUE nesta migration.
-- Isso não é o mesmo mecanismo do futuro sistema de limites/recursos por
-- PLANO (Fase 5) — aquele é sobre diferenciar clientes pagantes entre si
-- (Basic/Essential/Premium); este é sobre "isso nunca existe fora do seu
-- próprio tenant", incondicional a qualquer plano.
--
-- ZERO MUDANÇA DE COMPORTAMENTO HOJE pra você — seu tenant já fica com
-- referrals_enabled=true, então toda função abaixo continua se comportando
-- exatamente como antes pro seu uso.
--
-- Nota: a tela "Indicado por" (gerente-clientes.js) e o item de menu
-- "Indicações" (cliente-indicacoes.js) continuam existindo no front-end por
-- enquanto — como só existe 1 tenant (o seu, com o recurso ligado), não há
-- nada visível pra esconder ainda. Esconder essas telas condicionalmente
-- pra outros tenants é trabalho de tela (Fase 2+, quando existir um 2º
-- tenant de verdade pra testar contra) — aqui só o backend já fica travado.

alter table tenants add column referrals_enabled boolean not null default false;
update tenants set referrals_enabled = true where id = default_tenant_id();

-- ============================================================================
-- Funções de LEITURA — todas passam a checar referrals_enabled do tenant de
-- quem chama, além do isolamento por tenant já feito na Fase 1b.
-- ============================================================================

create or replace function has_referrals()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select coalesce((select referrals_enabled from tenants where id = current_tenant_id()), false)
    and exists(select 1 from clients where referred_by_client_id = auth.uid() and tenant_id = current_tenant_id());
$$;

create or replace function is_referrer_of(p_client_id uuid)
returns boolean
language sql stable
security definer set search_path = public
as $$
  select coalesce((select referrals_enabled from tenants where id = current_tenant_id()), false)
    and exists(
      select 1 from clients
      where profile_id = p_client_id
        and referred_by_client_id = auth.uid()
        and tenant_id = current_tenant_id()
    );
$$;

create or replace function list_my_referred_clients()
returns table (client_id uuid, full_name text)
language sql stable
security definer set search_path = public
as $$
  select c.profile_id, p.full_name
  from clients c
  join profiles p on p.id = c.profile_id
  where c.referred_by_client_id = auth.uid()
    and c.tenant_id = current_tenant_id()
    and coalesce((select referrals_enabled from tenants where id = current_tenant_id()), false)
  order by p.full_name;
$$;

create or replace function search_clients_for_referral(p_query text, p_exclude_client_id uuid default null)
returns table (profile_id uuid, full_name text, cpf text)
language plpgsql stable
security definer set search_path = public
as $$
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  if not coalesce((select referrals_enabled from tenants where id = current_tenant_id()), false) then
    return; -- lista vazia — recurso desligado pra este tenant, sem erro
  end if;

  return query
    select p.id, p.full_name, p.cpf
    from profiles p
    join clients c on c.profile_id = p.id
    where p.role = 'cliente'
      and c.tenant_id = current_tenant_id()
      and (p_exclude_client_id is null or p.id <> p_exclude_client_id)
      and p.full_name ilike '%' || trim(p_query) || '%'
    order by p.full_name
    limit 8;
end;
$$;

-- ============================================================================
-- Função de ESCRITA — única que grava referred_by_client_id em todo o
-- schema (confirmado por grep). Corrigida agora, fora da ordem normal da
-- Fase 1c (que ainda vai revisar todas as funções de escrita uma a uma),
-- porque o fundador pediu ênfase explícita em "nenhum usuário poderá ter
-- isso" — trava o valor em NULL sempre que o tenant não tem o recurso
-- ligado, não importa o que o front-end mandar.
-- ============================================================================
create or replace function update_client_profile(
  p_client_id uuid,
  p_full_name text,
  p_cpf text,
  p_phone text,
  p_credit_limit numeric,
  p_client_group text,
  p_notes text,
  p_company text default null,
  p_job_title text default null,
  p_salary text default null,
  p_pix_key text default null,
  p_referred_by_client_id uuid default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_referrals_enabled boolean;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  select referrals_enabled into v_referrals_enabled from tenants where id = current_tenant_id();

  update profiles set full_name = p_full_name, cpf = p_cpf, phone = p_phone, updated_at = now()
    where id = p_client_id;

  update clients set credit_limit = p_credit_limit,
    client_group = p_client_group, notes = p_notes,
    company = p_company, job_title = p_job_title, salary = p_salary, pix_key = p_pix_key,
    referred_by_client_id = case when coalesce(v_referrals_enabled, false) then p_referred_by_client_id else null end
    where profile_id = p_client_id;
end;
$$;

-- Migration 032 — SIGES vira plataforma: FASE 1b (isolamento de LEITURA em
-- funções security definer)
--
-- A Fase 1a fechou a leitura via RLS direto em tabela. Mas várias funções
-- `security definer` fazem leitura por conta própria (bypassam RLS por
-- definição) e não checavam tenant nenhum — um gerente de outra empresa
-- podia, em teoria, informar o profile_id de um cliente alheio e receber
-- saldo devedor, ou buscar nome/CPF de clientes de qualquer tenant da
-- plataforma pela busca de indicação. Esta migration fecha essas 6 funções.
--
-- NÃO MUDA NENHUM COMPORTAMENTO HOJE (mesmo raciocínio da Fase 1a: só existe
-- 1 tenant, então toda comparação de tenant_id já bate sempre).
--
-- Todas usam `create or replace function` com a MESMA assinatura de sempre
-- (nenhum parâmetro/tipo mudou) — não precisa de `drop function` antes.

-- ============================================================================
-- 1. client_outstanding_balance — gerente só consulta cliente do próprio
--    tenant; cliente continua podendo consultar o próprio saldo.
-- ============================================================================
create or replace function client_outstanding_balance(p_client_id uuid)
returns numeric
language plpgsql stable
security definer set search_path = public
as $$
begin
  if not (
    (is_gerente() and exists(select 1 from clients where profile_id = p_client_id and tenant_id = current_tenant_id()))
    or auth.uid() = p_client_id
  ) then
    raise exception 'FORBIDDEN';
  end if;

  return (select coalesce(sum(
    case
      when exists (
        select 1 from renewal_cycles rc
        where rc.contract_id = lc.id and rc.status in ('pendente','atrasada')
      )
      then (
        select rc.full_debt_amount from renewal_cycles rc
        where rc.contract_id = lc.id and rc.status in ('pendente','atrasada')
        order by rc.cycle_number desc limit 1
      )
      else (
        select coalesce(sum(i.amount_due - i.principal_paid_partial - i.interest_paid_partial), 0) from installments i
        where i.contract_id = lc.id and i.status in ('pendente','atrasada')
      )
    end
  ), 0)
  from loan_contracts lc
  where lc.client_id = p_client_id
    and lc.status in ('em_aberto', 'atrasado'));
end;
$$;

-- ============================================================================
-- 2. client_outstanding_principal — mesmo tratamento.
-- ============================================================================
create or replace function client_outstanding_principal(p_client_id uuid)
returns numeric
language plpgsql stable
security definer set search_path = public
as $$
begin
  if not (
    (is_gerente() and exists(select 1 from clients where profile_id = p_client_id and tenant_id = current_tenant_id()))
    or auth.uid() = p_client_id
  ) then
    raise exception 'FORBIDDEN';
  end if;

  return (select coalesce(sum(
    case
      when exists (
        select 1 from renewal_cycles rc
        where rc.contract_id = lc.id and rc.status in ('pendente','atrasada')
      )
      then lc.principal_amount
      else (
        select coalesce(sum(i.principal_share - i.principal_paid_partial), 0) from installments i
        where i.contract_id = lc.id and i.status in ('pendente','atrasada')
      )
    end
  ), 0)
  from loan_contracts lc
  where lc.client_id = p_client_id
    and lc.status in ('em_aberto', 'atrasado'));
end;
$$;

-- check_credit_limit() NÃO precisou mudar: já chama client_outstanding_
-- principal() acima, que agora lança FORBIDDEN sozinha se p_client_id for de
-- outro tenant — a proteção chega "de graça", antes de qualquer leitura de
-- credit_limit.

-- ============================================================================
-- 3. public_company_info — troca "where id = true" por
--    "where tenant_id = current_tenant_id()". Hoje dá no mesmo resultado (só
--    existe 1 linha em system_settings), mas já deixa certo pro dia em que
--    essa tabela passar a ter 1 linha por tenant.
-- ============================================================================
create or replace function public_company_info()
returns table (company_name text, company_whatsapp text)
language plpgsql stable
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'FORBIDDEN';
  end if;
  return query select s.company_name, s.company_whatsapp from system_settings s where s.tenant_id = current_tenant_id();
end;
$$;

-- ============================================================================
-- 4. is_referrer_of — exige que o cliente indicado esteja no mesmo tenant de
--    quem chama (defesa em profundidade).
-- ============================================================================
create or replace function is_referrer_of(p_client_id uuid)
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists(
    select 1 from clients
    where profile_id = p_client_id
      and referred_by_client_id = auth.uid()
      and tenant_id = current_tenant_id()
  );
$$;

-- ============================================================================
-- 5. has_referrals
-- ============================================================================
create or replace function has_referrals()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists(select 1 from clients where referred_by_client_id = auth.uid() and tenant_id = current_tenant_id());
$$;

-- ============================================================================
-- 6. list_my_referred_clients
-- ============================================================================
create or replace function list_my_referred_clients()
returns table (client_id uuid, full_name text)
language sql stable
security definer set search_path = public
as $$
  select c.profile_id, p.full_name
  from clients c
  join profiles p on p.id = c.profile_id
  where c.referred_by_client_id = auth.uid() and c.tenant_id = current_tenant_id()
  order by p.full_name;
$$;

-- ============================================================================
-- 7. search_clients_for_referral — a mais séria das 6: sem o filtro abaixo,
--    um gerente de outra empresa conseguia ver nome+CPF de clientes de
--    QUALQUER tenant da plataforma digitando qualquer coisa nesse campo.
-- ============================================================================
create or replace function search_clients_for_referral(p_query text, p_exclude_client_id uuid default null)
returns table (profile_id uuid, full_name text, cpf text)
language plpgsql stable
security definer set search_path = public
as $$
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
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

-- email_for_cpf() NÃO muda — precisa continuar global de propósito (CPF é
-- único em toda a plataforma, e login ainda não tem sessão/tenant no
-- momento em que essa função é chamada). Ver comentário em schema.sql.

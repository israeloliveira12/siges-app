-- ============================================================================
-- MIGRATION 021 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_020)
--
-- Feature "Indicações": clientes podem indicar outros clientes no cadastro
-- (campo "Indicado por", preenchido buscando o nome de quem indicou em tempo
-- real, com autocomplete). Quem indicou ganha acesso a um menu novo
-- ("Indicações") mostrando os empréstimos e o andamento da dívida de quem ele
-- indicou.
--
-- Decisões de design (aprovadas pelo usuário antes de implementar):
-- 1) Coluna nova nullable em clients — não afeta nenhum cliente existente.
-- 2) O indicador NUNCA lê a tabela `clients`/`profiles` inteira de quem ele
--    indicou (tem CPF, telefone, endereço, renda, chave Pix) — só o nome via
--    a RPC curada list_my_referred_clients(). O detalhe de dívida (contratos/
--    parcelas/renovações) é dado puramente financeiro, sem PII, então a RLS
--    dessas 3 tabelas é estendida com is_referrer_of() do mesmo jeito que já
--    funciona pra client_id = auth.uid().
-- 3) Sem extrato em PDF do indicado, sem "quem indicou quem" na lista
--    principal de Clientes do admin — escopo confirmado com o usuário.
-- ============================================================================

-- --- (1) coluna + integridade ---

alter table clients add column referred_by_client_id uuid references clients(profile_id) on delete set null;
alter table clients add constraint clients_no_self_referral check (referred_by_client_id is distinct from profile_id);
create index idx_clients_referred_by on clients(referred_by_client_id);

-- --- (2) funções de apoio ---

-- Usada dentro de RLS (loan_contracts/installments/renewal_cycles) e não é
-- chamada direto pelo frontend.
create or replace function is_referrer_of(p_client_id uuid)
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists(select 1 from clients where profile_id = p_client_id and referred_by_client_id = auth.uid());
$$;

-- Gate leve do menu "Indicações" — chamada 1x no login do cliente.
create or replace function has_referrals()
returns boolean
language sql stable
security definer set search_path = public
as $$
  select exists(select 1 from clients where referred_by_client_id = auth.uid());
$$;

-- Lista curada (só profile_id + nome) de quem o cliente logado indicou — usada
-- pela tela Indicações pra saber DE QUEM buscar contratos/parcelas. Bypassa
-- RLS de clients/profiles por ser security definer, mas só devolve 2 campos
-- não-sensíveis, nunca CPF/telefone/endereço/renda/pix do indicado.
create or replace function list_my_referred_clients()
returns table (client_id uuid, full_name text)
language sql stable
security definer set search_path = public
as $$
  select c.profile_id, p.full_name
  from clients c
  join profiles p on p.id = c.profile_id
  where c.referred_by_client_id = auth.uid()
  order by p.full_name;
$$;

-- Autocomplete do campo "Indicado por": busca clientes por nome (parcial,
-- case-insensitive) enquanto o gerente digita. Só gerente chama (vaza nomes/
-- CPF de outros clientes). p_exclude_client_id evita que o próprio cliente em
-- edição apareça como opção de indicador (defesa em profundidade — o mesmo
-- já é bloqueado pelo check clients_no_self_referral no banco).
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
      and (p_exclude_client_id is null or p.id <> p_exclude_client_id)
      and p.full_name ilike '%' || trim(p_query) || '%'
    order by p.full_name
    limit 8;
end;
$$;

-- --- (3) RLS: indicador pode ler contratos/parcelas/renovações de quem ele indicou ---

drop policy if exists "contracts_select" on loan_contracts;
create policy "contracts_select" on loan_contracts for select
  using (client_id = auth.uid() or is_gerente() or is_referrer_of(client_id));

drop policy if exists "installments_select" on installments;
create policy "installments_select" on installments for select
  using (is_gerente() or exists (
    select 1 from loan_contracts lc where lc.id = installments.contract_id
      and (lc.client_id = auth.uid() or is_referrer_of(lc.client_id))
  ));

drop policy if exists "renewal_select" on renewal_cycles;
create policy "renewal_select" on renewal_cycles for select
  using (is_gerente() or exists (
    select 1 from loan_contracts lc where lc.id = renewal_cycles.contract_id
      and (lc.client_id = auth.uid() or is_referrer_of(lc.client_id))
  ));

-- --- (4) update_client_profile ganha o campo novo (arity mudou -> precisa dropar a versão antiga) ---

drop function if exists update_client_profile(uuid, text, text, text, numeric, text, text, text, text, text, text);

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
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  update profiles set full_name = p_full_name, cpf = p_cpf, phone = p_phone, updated_at = now()
    where id = p_client_id;

  update clients set credit_limit = p_credit_limit,
    client_group = p_client_group, notes = p_notes,
    company = p_company, job_title = p_job_title, salary = p_salary, pix_key = p_pix_key,
    referred_by_client_id = p_referred_by_client_id
    where profile_id = p_client_id;
end;
$$;

-- ============================================================================
-- FIM DA MIGRATION 021
-- ============================================================================

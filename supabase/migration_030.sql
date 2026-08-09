-- Migration 030 — SIGES vira plataforma: FASE 0 (fundação de dados)
--
-- Esta migration NÃO muda nenhum comportamento visível do app. Ela só
-- prepara o banco para multi-empresa (multi-tenant):
--   1. Cria a tabela `tenants` (uma linha por empresa cliente da plataforma).
--   2. Cria o Tenant #1 = a sua financeira atual, lendo o nome direto de
--      system_settings.company_name (não hardcoded) e o dono a partir do
--      admin primário já existente.
--   3. Adiciona `tenant_id` (NOT NULL, com valor padrão) em toda tabela que
--      guarda dado de negócio, e preenche essa coluna em 100% das linhas
--      já existentes com o Tenant #1.
--
-- Por que "NOT NULL com valor padrão" e não travar `tenant_id` como
-- obrigatório sem default: o app de produção, hoje, não sabe que essa
-- coluna existe — se ela fosse obrigatória SEM valor padrão, o próximo
-- cadastro de cliente/contrato/pagamento feito pelo app quebraria na hora
-- com "null value in column tenant_id violates not-null constraint". A
-- função default_tenant_id() abaixo resolve isso: enquanto o app não for
-- atualizado (Fase 1), qualquer linha nova cai automaticamente no Tenant #1,
-- exatamente como se essa coluna não existisse do ponto de vista do usuário.
--
-- ATENÇÃO PARA A FASE 1: default_tenant_id() é andaime temporário. Ela
-- SEMPRE aponta pro Tenant #1 — no dia em que existir um Tenant #2, qualquer
-- código que ainda dependa desse default (em vez de informar o tenant_id
-- certo explicitamente) vai silenciosamente colocar dado da empresa errada
-- dentro do Tenant #1. A Fase 1 precisa: (a) atualizar toda RPC de escrita
-- para setar tenant_id explicitamente a partir do usuário autenticado, e
-- (b) só então remover esse default (ou trocá-lo por uma função que lança
-- erro se chamada, como um alarme de "esqueceram de setar o tenant_id").

-- ============================================================================
-- 1. Tabela tenants
-- ============================================================================
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_profile_id uuid references profiles(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table tenants enable row level security;

-- Política mínima e segura pro ambiente de 1 tenant só: qualquer gerente
-- ativo pode ler a lista de tenants (hoje só existe o próprio) — mesmo
-- critério "gerente vê tudo" que já vale pra cada tabela do sistema, então
-- não é uma restrição NOVA, é só fechar a tabela nova pro anon/PostgREST
-- por padrão (sem isso, uma tabela sem RLS fica lida por qualquer chave
-- anônima). Nenhuma política de INSERT/UPDATE/DELETE ainda — criar/editar
-- tenant só vai existir a partir da Fase 3, via RPC security definer.
create policy "tenants_select" on tenants for select using (is_gerente());

-- ============================================================================
-- 2. Função-andaime: resolve o Tenant #1 (única linha que existe até a Fase 1
--    reescrever as RPCs de escrita pra setar tenant_id explicitamente).
-- ============================================================================
create or replace function default_tenant_id()
returns uuid
language sql
stable
security definer set search_path = public
as $$
  select id from tenants order by created_at asc limit 1;
$$;

-- ============================================================================
-- 3. Cria o Tenant #1 a partir dos dados reais já existentes — nunca
--    hardcoded, pra bater exatamente com o nome que você já configurou e
--    com quem já é o admin primário.
-- ============================================================================
insert into tenants (name, owner_profile_id)
select
  coalesce(nullif(trim(s.company_name), ''), 'Minha Empresa'),
  (select id from profiles where role = 'gerente' and is_primary_admin and active order by created_at asc limit 1)
from system_settings s
limit 1;

-- ============================================================================
-- 4. Adiciona tenant_id em toda tabela de negócio, com backfill explícito
--    (não depende do mecanismo de "fast default" do Postgres — cada UPDATE
--    abaixo é redundante de propósito, pra garantir 100% das linhas
--    preenchidas independente de versão/comportamento do Postgres).
-- ============================================================================

alter table profiles add column tenant_id uuid references tenants(id) default default_tenant_id();
update profiles set tenant_id = default_tenant_id() where tenant_id is null;
alter table profiles alter column tenant_id set not null;
create index profiles_tenant_id_idx on profiles(tenant_id);

alter table clients add column tenant_id uuid references tenants(id) default default_tenant_id();
update clients set tenant_id = default_tenant_id() where tenant_id is null;
alter table clients alter column tenant_id set not null;
create index clients_tenant_id_idx on clients(tenant_id);

alter table loan_requests add column tenant_id uuid references tenants(id) default default_tenant_id();
update loan_requests set tenant_id = default_tenant_id() where tenant_id is null;
alter table loan_requests alter column tenant_id set not null;
create index loan_requests_tenant_id_idx on loan_requests(tenant_id);

alter table loan_contracts add column tenant_id uuid references tenants(id) default default_tenant_id();
update loan_contracts set tenant_id = default_tenant_id() where tenant_id is null;
alter table loan_contracts alter column tenant_id set not null;
create index loan_contracts_tenant_id_idx on loan_contracts(tenant_id);

alter table installments add column tenant_id uuid references tenants(id) default default_tenant_id();
update installments set tenant_id = default_tenant_id() where tenant_id is null;
alter table installments alter column tenant_id set not null;
create index installments_tenant_id_idx on installments(tenant_id);

alter table renewal_cycles add column tenant_id uuid references tenants(id) default default_tenant_id();
update renewal_cycles set tenant_id = default_tenant_id() where tenant_id is null;
alter table renewal_cycles alter column tenant_id set not null;
create index renewal_cycles_tenant_id_idx on renewal_cycles(tenant_id);

alter table payments add column tenant_id uuid references tenants(id) default default_tenant_id();
update payments set tenant_id = default_tenant_id() where tenant_id is null;
alter table payments alter column tenant_id set not null;
create index payments_tenant_id_idx on payments(tenant_id);

alter table notifications_log add column tenant_id uuid references tenants(id) default default_tenant_id();
update notifications_log set tenant_id = default_tenant_id() where tenant_id is null;
alter table notifications_log alter column tenant_id set not null;
create index notifications_log_tenant_id_idx on notifications_log(tenant_id);

alter table push_subscriptions add column tenant_id uuid references tenants(id) default default_tenant_id();
update push_subscriptions set tenant_id = default_tenant_id() where tenant_id is null;
alter table push_subscriptions alter column tenant_id set not null;
create index push_subscriptions_tenant_id_idx on push_subscriptions(tenant_id);

-- system_settings é hoje uma tabela "singleton" (id boolean, 1 linha só).
-- Ela SÓ ganha tenant_id nesta fase (pra já existir e já estar preenchido);
-- a estrutura de chave (permitir 1 linha DE CONFIGURAÇÃO por tenant, não 1
-- linha pro sistema inteiro) é uma mudança de comportamento real e fica
-- explicitamente pra Fase 1, junto da reescrita de RLS.
alter table system_settings add column tenant_id uuid references tenants(id) default default_tenant_id();
update system_settings set tenant_id = default_tenant_id() where tenant_id is null;
alter table system_settings alter column tenant_id set not null;
create index system_settings_tenant_id_idx on system_settings(tenant_id);

alter table planning_debts add column tenant_id uuid references tenants(id) default default_tenant_id();
update planning_debts set tenant_id = default_tenant_id() where tenant_id is null;
alter table planning_debts alter column tenant_id set not null;
create index planning_debts_tenant_id_idx on planning_debts(tenant_id);

-- audit_log fica NULLABLE de propósito (diferente de todas as outras) —
-- login falho grava evento sem sessão (auth.uid() é null), então nem
-- sempre dá pra saber o tenant no momento do evento. Continua útil pra
-- filtrar por tenant quando o ator é conhecido.
alter table audit_log add column tenant_id uuid references tenants(id);
update audit_log set tenant_id = default_tenant_id() where tenant_id is null;
create index audit_log_tenant_id_idx on audit_log(tenant_id);

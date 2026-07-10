-- ============================================================================
-- MIGRATION 013 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_012)
--
-- Cobre: remove a "Tabela VIP" (loan_rate_reference), que virou referência
-- morta na UI; cria a base da nova tela "Planejamento" (caixa atual, LTV% e
-- dívidas mensais nomeadas para os próximos 12 meses).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Remove a Tabela VIP (loan_rate_reference) — item 2
-- ----------------------------------------------------------------------------
drop policy if exists "rate_ref_select_authenticated" on loan_rate_reference;
drop policy if exists "rate_ref_gerente_write" on loan_rate_reference;
drop table if exists loan_rate_reference;

-- ----------------------------------------------------------------------------
-- 2. Planejamento — caixa atual e LTV% (system_settings) — item 10
-- ----------------------------------------------------------------------------
alter table system_settings add column if not exists planning_current_cash numeric(12,2) not null default 0;
alter table system_settings add column if not exists planning_ltv_percent numeric(6,3) not null default 0;

-- ----------------------------------------------------------------------------
-- 3. Planejamento — dívidas mensais nomeadas (próximos 12 meses) — item 10
-- ----------------------------------------------------------------------------
create table if not exists planning_debts (
  id uuid primary key default gen_random_uuid(),
  month date not null,              -- sempre o dia 1 do mês (ex: 2026-08-01)
  name text not null,
  amount numeric(12,2) not null check (amount > 0),
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now()
);

alter table planning_debts enable row level security;

create policy "planning_debts_gerente_all" on planning_debts for all
  using (is_gerente()) with check (is_gerente());

-- ============================================================================
-- FIM DA MIGRATION 013
-- ============================================================================

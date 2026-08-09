-- Migration 031 — SIGES vira plataforma: FASE 1a (isolamento de LEITURA)
--
-- Fecha o vazamento entre empresas para toda operação de LEITURA (select) e
-- de "alvo" de update/delete (a parte "quais linhas eu posso ver/mexer",
-- diferente de "que valores eu posso gravar", que é a Fase 1c).
--
-- NÃO MUDA NENHUM COMPORTAMENTO HOJE: como só existe 1 tenant (criado na
-- Fase 0) e todo gerente/cliente/linha já pertence a ele, toda comparação
-- `tenant_id = current_tenant_id()` abaixo é sempre verdadeira agora — o
-- efeito só aparece no dia em que existir um segundo tenant.
--
-- Nota técnica importante: várias tabelas têm política `for all` (cobre
-- select+insert+update+delete numa política só). Postgres combina TODAS as
-- políticas permissivas aplicáveis a um comando com OU — então corrigir só
-- a política dedicada "_select" e deixar a "for all" intocada não fecharia
-- nada (a "for all" continuaria liberando select sem filtro). Por isso esta
-- migration corrige a cláusula USING de toda política (a parte que decide
-- "essa linha existe pra mim"), inclusive das "for all" — mas mantém a
-- cláusula WITH CHECK (a parte "posso gravar isso") exatamente como está,
-- porque essa é sobre ESCREVER dado novo, reservada pra Fase 1c.

-- ============================================================================
-- 1. Helper: tenant do usuário autenticado
-- ============================================================================
create or replace function current_tenant_id()
returns uuid
language sql
stable
security definer set search_path = public
as $$
  select tenant_id from profiles where id = auth.uid();
$$;

-- ============================================================================
-- 2. profiles
-- ============================================================================
drop policy if exists "profiles_select" on profiles;
create policy "profiles_select" on profiles for select
  using (id = auth.uid() or (is_gerente() and tenant_id = current_tenant_id()));

-- ============================================================================
-- 3. clients
-- ============================================================================
drop policy if exists "clients_select" on clients;
create policy "clients_select" on clients for select
  using (profile_id = auth.uid() or (is_gerente() and tenant_id = current_tenant_id()));

drop policy if exists "clients_gerente_update" on clients;
create policy "clients_gerente_update" on clients for update
  using (is_gerente() and tenant_id = current_tenant_id());

-- ============================================================================
-- 4. loan_requests
-- ============================================================================
drop policy if exists "requests_select" on loan_requests;
create policy "requests_select" on loan_requests for select
  using (client_id = auth.uid() or (is_gerente() and tenant_id = current_tenant_id()));

drop policy if exists "requests_update_gerente" on loan_requests;
create policy "requests_update_gerente" on loan_requests for update
  using (is_gerente() and tenant_id = current_tenant_id());

-- ============================================================================
-- 5. loan_contracts
-- ============================================================================
drop policy if exists "contracts_select" on loan_contracts;
create policy "contracts_select" on loan_contracts for select
  using (client_id = auth.uid() or (is_gerente() and tenant_id = current_tenant_id()) or is_referrer_of(client_id));

drop policy if exists "contracts_gerente_all" on loan_contracts;
create policy "contracts_gerente_all" on loan_contracts for all
  using (is_gerente() and tenant_id = current_tenant_id())
  with check (is_gerente());

-- ============================================================================
-- 6. installments
-- ============================================================================
drop policy if exists "installments_select" on installments;
create policy "installments_select" on installments for select
  using ((is_gerente() and tenant_id = current_tenant_id()) or exists (
    select 1 from loan_contracts lc where lc.id = installments.contract_id
      and (lc.client_id = auth.uid() or is_referrer_of(lc.client_id))
  ));

drop policy if exists "installments_gerente_write" on installments;
create policy "installments_gerente_write" on installments for all
  using (is_gerente() and tenant_id = current_tenant_id())
  with check (is_gerente());

-- ============================================================================
-- 7. renewal_cycles
-- ============================================================================
drop policy if exists "renewal_select" on renewal_cycles;
create policy "renewal_select" on renewal_cycles for select
  using ((is_gerente() and tenant_id = current_tenant_id()) or exists (
    select 1 from loan_contracts lc where lc.id = renewal_cycles.contract_id
      and (lc.client_id = auth.uid() or is_referrer_of(lc.client_id))
  ));

drop policy if exists "renewal_gerente_write" on renewal_cycles;
create policy "renewal_gerente_write" on renewal_cycles for all
  using (is_gerente() and tenant_id = current_tenant_id())
  with check (is_gerente());

-- ============================================================================
-- 8. payments
-- ============================================================================
drop policy if exists "payments_select" on payments;
create policy "payments_select" on payments for select
  using ((is_gerente() and tenant_id = current_tenant_id()) or exists (
    select 1 from loan_contracts lc where lc.id = payments.contract_id and lc.client_id = auth.uid()
  ));

drop policy if exists "payments_gerente_write" on payments;
create policy "payments_gerente_write" on payments for all
  using (is_gerente() and tenant_id = current_tenant_id())
  with check (is_gerente());

-- ============================================================================
-- 9. notifications_log
-- ============================================================================
drop policy if exists "notifications_select" on notifications_log;
create policy "notifications_select" on notifications_log for select
  using (recipient_id = auth.uid() or (is_gerente() and tenant_id = current_tenant_id()));

-- ============================================================================
-- 10. system_settings
-- ============================================================================
drop policy if exists "settings_select_gerente" on system_settings;
create policy "settings_select_gerente" on system_settings for select
  using (is_gerente() and tenant_id = current_tenant_id());

drop policy if exists "settings_gerente_update" on system_settings;
create policy "settings_gerente_update" on system_settings for update
  using (is_primary_admin() and tenant_id = current_tenant_id());

-- ============================================================================
-- 11. planning_debts
-- ============================================================================
drop policy if exists "planning_debts_gerente_all" on planning_debts;
create policy "planning_debts_gerente_all" on planning_debts for all
  using (is_primary_admin() and tenant_id = current_tenant_id())
  with check (is_primary_admin());

-- ============================================================================
-- 12. audit_log
-- ============================================================================
-- ATENÇÃO: tenant_id é NULLABLE em audit_log (eventos de login falho sem
-- sessão) — com este filtro, linhas com tenant_id NULL ficam INVISÍVEIS pra
-- todo mundo (NULL = qualquer coisa nunca é verdadeiro em SQL), até a Fase
-- 2/3 dar a você (Administrador Master) visibilidade cross-tenant de
-- verdade. Efeito hoje: praticamente nenhum (a esmagadora maioria das linhas
-- já tem tenant_id preenchido, só ficam ocultas as raríssimas tentativas de
-- login com CPF/e-mail que não resolveu profile nenhum).
drop policy if exists "audit_log_select_gerente" on audit_log;
create policy "audit_log_select_gerente" on audit_log for select
  using (is_gerente() and tenant_id = current_tenant_id());

-- ============================================================================
-- 13. tenants (criada na Fase 0) — cada gerente só vê a PRÓPRIA linha, não a
--     lista inteira de empresas. Comparação é com o id da própria tabela
--     (tenants.id), não com uma coluna tenant_id (essa tabela É a entidade
--     tenant, não referencia uma).
-- ============================================================================
drop policy if exists "tenants_select" on tenants;
create policy "tenants_select" on tenants for select
  using (is_gerente() and id = current_tenant_id());

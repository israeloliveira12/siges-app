-- ============================================================================
-- MIGRATION 020 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_019)
--
-- Correção dos achados médios/baixos deixados em aberto no QA crítico de
-- 2026-07-11 (ver CLAUDE.md, seção "QA crítico completo"):
--
-- 1) system_settings (SELECT) era legível por qualquer cliente autenticado,
--    vazando taxas internas/caixa/thresholds (planning_current_cash,
--    default_entry_fee_percent, etc.) — só company_name/company_whatsapp são
--    realmente necessários pro cliente. Agora o SELECT direto na tabela é
--    exclusivo de is_gerente(); clientes passam a usar a RPC nova
--    public_company_info(), que só devolve os 2 campos públicos.
--
-- 2) loan_requests (INSERT) não restringia quais colunas o cliente podia
--    setar via REST direto — um cliente técnico podia inserir já com
--    status='aprovado'/decided_by preenchido, contornando a aprovação do
--    gerente. Novo `with check` força status='pendente' e os campos de
--    decisão como null na criação.
--
-- 3) late_fee_percent/late_interest_percent (loan_contracts) sem validação de
--    não-negativo.
--
-- 4) FKs "dormentes" profiles.created_by / clients.decided_by /
--    loan_requests.decided_by (todas nullable, sem ON DELETE) agora usam
--    ON DELETE SET NULL — defesa em profundidade caso uma conta de gerente
--    seja excluída no futuro (hoje não existe essa feature, mas evita um erro
--    cru de FK se algum dia existir). As FKs NOT NULL equivalentes
--    (loan_contracts.created_by, renewal_cycles.created_by,
--    payments.received_by, planning_debts.created_by) ficam de propósito como
--    estão (RESTRICT) — são registro financeiro/auditoria, mesmo raciocínio
--    já usado para bloquear exclusão de cliente com contrato.
-- ============================================================================

-- --- (1) ---

drop policy if exists "settings_select_authenticated" on system_settings;
create policy "settings_select_gerente" on system_settings for select using (is_gerente());

create or replace function public_company_info()
returns table (company_name text, company_whatsapp text)
language plpgsql stable
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'FORBIDDEN';
  end if;
  return query select s.company_name, s.company_whatsapp from system_settings s where s.id = true;
end;
$$;

-- --- (2) ---

drop policy if exists "requests_insert_self" on loan_requests;
create policy "requests_insert_self" on loan_requests for insert
  with check (
    client_id = auth.uid()
    and exists (select 1 from clients c where c.profile_id = auth.uid() and c.approval_status = 'aprovado')
    and status = 'pendente'
    and decided_by is null
    and decision_reason is null
    and decided_at is null
    and resulting_contract_id is null
  );

-- --- (3) ---

alter table loan_contracts add constraint loan_contracts_late_fee_percent_check check (late_fee_percent >= 0);
alter table loan_contracts add constraint loan_contracts_late_interest_percent_check check (late_interest_percent >= 0);

-- --- (4) ---

alter table profiles drop constraint profiles_created_by_fkey;
alter table profiles
  add constraint profiles_created_by_fkey
  foreign key (created_by) references profiles(id) on delete set null;

alter table clients drop constraint clients_decided_by_fkey;
alter table clients
  add constraint clients_decided_by_fkey
  foreign key (decided_by) references profiles(id) on delete set null;

alter table loan_requests drop constraint loan_requests_decided_by_fkey;
alter table loan_requests
  add constraint loan_requests_decided_by_fkey
  foreign key (decided_by) references profiles(id) on delete set null;

-- ============================================================================
-- FIM DA MIGRATION 020
-- ============================================================================

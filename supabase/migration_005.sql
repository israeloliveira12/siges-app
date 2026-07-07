-- ============================================================================
-- MIGRATION 005 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_004)
--
-- CORRIGE DE VEZ o bug recorrente: "update or delete on table installments
-- violates foreign key constraint notifications_log_related_installment_id_fkey"
-- (acontecia ao excluir um contrato e ao apagar todos os dados).
--
-- Causa raiz (duas, na verdade):
-- 1. notifications_log referencia installments/loan_contracts SEM
--    "on delete set null" — qualquer notificação histórica mencionando uma
--    parcela/contrato impedia a exclusão deles.
-- 2. installments e renewal_cycles se referenciam uma à outra em mão dupla
--    (installments.renewed_into_cycle_id -> renewal_cycles.id E
--    renewal_cycles.origin_installment_id -> installments.id), então
--    excluir uma tabela antes da outra sempre ia esbarrar na que sobrou —
--    não existe uma ordem de DELETE que resolva isso sozinha.
--
-- A correção de verdade é no próprio schema (ON DELETE SET NULL/CASCADE nas
-- FKs), não só na ordem dos comandos — assim qualquer função futura que
-- excluir dados fica protegida automaticamente, sem precisar lembrar da
-- ordem certa toda vez.
-- ============================================================================

-- notifications_log é um histórico de auditoria: ao excluir a parcela/contrato
-- referenciado, mantém a notificação (não apaga o registro), só desfaz o link.
alter table notifications_log drop constraint if exists notifications_log_related_installment_id_fkey;
alter table notifications_log add constraint notifications_log_related_installment_id_fkey
  foreign key (related_installment_id) references installments(id) on delete set null;

alter table notifications_log drop constraint if exists notifications_log_related_contract_id_fkey;
alter table notifications_log add constraint notifications_log_related_contract_id_fkey
  foreign key (related_contract_id) references loan_contracts(id) on delete set null;

-- referência cruzada installments <-> renewal_cycles: SET NULL nos dois
-- sentidos quebra o ciclo de bloqueio mútuo.
alter table installments drop constraint if exists fk_renewed_into_cycle;
alter table installments add constraint fk_renewed_into_cycle
  foreign key (renewed_into_cycle_id) references renewal_cycles(id) on delete set null;

alter table renewal_cycles drop constraint if exists renewal_cycles_origin_installment_id_fkey;
alter table renewal_cycles add constraint renewal_cycles_origin_installment_id_fkey
  foreign key (origin_installment_id) references installments(id) on delete set null;

-- payments é registro filho de contrato/parcela/ciclo — cascata é o
-- comportamento correto (excluiu o pai, o pagamento ligado a ele também sai),
-- e protege qualquer função futura que não lembre de apagar payments primeiro.
alter table payments drop constraint if exists payments_contract_id_fkey;
alter table payments add constraint payments_contract_id_fkey
  foreign key (contract_id) references loan_contracts(id) on delete cascade;

alter table payments drop constraint if exists payments_installment_id_fkey;
alter table payments add constraint payments_installment_id_fkey
  foreign key (installment_id) references installments(id) on delete cascade;

alter table payments drop constraint if exists payments_renewal_cycle_id_fkey;
alter table payments add constraint payments_renewal_cycle_id_fkey
  foreign key (renewal_cycle_id) references renewal_cycles(id) on delete cascade;

-- mesma categoria de risco: loan_requests aponta pro contrato resultante,
-- então excluir o contrato ficava bloqueado por essa referência também
-- (a função delete_contract já limpa isso manualmente, mas reforça aqui
-- no schema como proteção contra qualquer outro caminho de exclusão).
alter table loan_requests drop constraint if exists fk_resulting_contract;
alter table loan_requests add constraint fk_resulting_contract
  foreign key (resulting_contract_id) references loan_contracts(id) on delete set null;

-- ============================================================================
-- FIM DA MIGRATION 005
-- ============================================================================

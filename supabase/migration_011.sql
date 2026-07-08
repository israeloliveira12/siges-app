-- ============================================================================
-- MIGRATION 011 — rode quando for conveniente (não é urgente, é limpeza)
--
-- Remove mais duas funções órfãs do mesmo tipo de problema da migration_010:
-- calc_installments_preview e create_loan_contract ganharam um parâmetro novo
-- (p_custom_interval_days, migration_006) e, como "create or replace" não
-- substitui quando a aridade muda, ficaram órfãs no banco ao lado das versões
-- novas. Hoje isso não quebra nada (o frontend sempre chama com o parâmetro
-- novo), mas são funções mortas ocupando espaço e um risco futuro se algum
-- dia alguém chamar essas RPCs com o conjunto antigo de parâmetros.
-- ============================================================================

drop function if exists calc_installments_preview(numeric, numeric, integer, due_type, date);
drop function if exists create_loan_contract(uuid, numeric, numeric, integer, due_type, date, date, boolean, numeric, boolean, numeric, numeric, text, uuid, jsonb);

-- ============================================================================
-- FIM DA MIGRATION 011
-- ============================================================================

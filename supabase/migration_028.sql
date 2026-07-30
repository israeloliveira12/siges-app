-- Migration 028: adiciona a "praça" (cidade) usada no texto da nota
-- promissória (ex: "na praça de Manaus"), cadastrável em Configurações.
-- Coluna nullable simples, sem função/RPC envolvida (o salvamento é um
-- update direto na tabela system_settings, não uma RPC) — não precisa de
-- nenhum drop function nem cuidado especial de aridade.

alter table system_settings add column if not exists company_city text;

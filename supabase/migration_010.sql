-- ============================================================================
-- MIGRATION 010 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_009)
--
-- CORRIGE BUG CRÍTICO (pré-existente, não é desta sessão): a trigger
-- handle_new_user() tentava inserir "cpf" e "phone" na tabela clients — essas
-- colunas nunca existiram lá (ficam em profiles). Isso quebrava TODO cadastro
-- público de cliente com "Database error saving new user" / erro Postgres
-- 42703 "column cpf of relation clients does not exist". CPF e telefone
-- digitados no cadastro nunca eram salvos em lugar nenhum.
--
-- CORRIGE BUG CRÍTICO: "create or replace function" NÃO substitui uma função
-- quando o TIPO de um parâmetro muda (só substitui se nome+tipos dos
-- parâmetros forem idênticos) — em vez disso, cria uma segunda versão
-- (overload) da função, deixando as duas no banco ao mesmo tempo.
--
-- Isso aconteceu com update_client_profile (p_salary numeric -> text, na
-- migration_008) e deixou DUAS versões da função no ar, uma com p_salary
-- numeric e outra com p_salary text. Como os nomes dos parâmetros são
-- idênticos nas duas, o PostgREST não consegue decidir qual usar e todo
-- "Editar cliente" / "Novo cliente" pelo admin passou a falhar com
-- "Could not choose the best candidate function".
--
-- receive_payment, receive_cycle_payment e renew_installment tiveram um
-- parâmetro NOVO adicionado (p_late_charge_amount, migrations 007/009) — isso
-- também gera uma segunda versão (overload) da função, só que sem ambiguidade
-- visível hoje porque o frontend sempre chama com o parâmetro novo. Mesmo
-- assim, a versão antiga fica órfã no banco — removida aqui por higiene.
-- ============================================================================

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role, cpf, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    lower(new.email),
    'cliente',
    new.raw_user_meta_data->>'cpf',
    new.raw_user_meta_data->>'phone'
  )
  on conflict (id) do nothing;

  insert into public.clients (profile_id, company, job_title, salary, pix_key)
  values (
    new.id,
    new.raw_user_meta_data->>'company',
    new.raw_user_meta_data->>'job_title',
    nullif(new.raw_user_meta_data->>'salary', ''),
    new.raw_user_meta_data->>'pix_key'
  )
  on conflict (profile_id) do nothing;

  return new;
end;
$$;

drop function if exists update_client_profile(uuid, text, text, text, numeric, text, text, text, text, text, numeric, text);
drop function if exists receive_payment(uuid, numeric, boolean, numeric, text);
drop function if exists receive_cycle_payment(uuid, numeric, boolean, numeric, text);
drop function if exists renew_installment(request_source, uuid, numeric, boolean, numeric, text);

-- ----------------------------------------------------------------------------
-- CORRIGE EXPOSIÇÃO DE DADOS: system_settings (taxas internas, thresholds de
-- risco) podia ser lido por QUALQUER visitante não autenticado direto pela
-- API REST do Supabase (a "anon key" é pública, já vem embutida no JS do
-- site) — não precisa de login nenhum para ler. Restringe a leitura a
-- usuários autenticados (cliente ou gerente), que é tudo que o app precisa.
-- ----------------------------------------------------------------------------
drop policy if exists "settings_select_all" on system_settings;
create policy "settings_select_authenticated" on system_settings for select using (auth.uid() is not null);

drop policy if exists "rate_ref_select_all" on loan_rate_reference;
create policy "rate_ref_select_authenticated" on loan_rate_reference for select using (auth.uid() is not null);

-- ============================================================================
-- FIM DA MIGRATION 010
-- ============================================================================

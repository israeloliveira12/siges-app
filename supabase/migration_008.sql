-- ============================================================================
-- MIGRATION 008 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_007)
--
-- Cobre: "Salário" vira "Renda Mensal" com faixas fixas (lista suspensa) em vez
-- de valor exato digitado. Campo passa de numeric para text (é só informativo,
-- nenhuma regra de negócio calcula em cima do valor exato de salário).
-- ============================================================================

alter table clients alter column salary type text using salary::text;

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    lower(new.email),
    'cliente'
  )
  on conflict (id) do nothing;

  insert into public.clients (profile_id, cpf, phone, company, job_title, salary, pix_key)
  values (
    new.id,
    new.raw_user_meta_data->>'cpf',
    new.raw_user_meta_data->>'phone',
    new.raw_user_meta_data->>'company',
    new.raw_user_meta_data->>'job_title',
    nullif(new.raw_user_meta_data->>'salary', ''),
    new.raw_user_meta_data->>'pix_key'
  )
  on conflict (profile_id) do nothing;

  return new;
end;
$$;

create or replace function update_client_profile(
  p_client_id uuid,
  p_full_name text,
  p_cpf text,
  p_phone text,
  p_credit_limit numeric,
  p_region text,
  p_client_group text,
  p_notes text,
  p_company text default null,
  p_job_title text default null,
  p_salary text default null,
  p_pix_key text default null
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

  update clients set credit_limit = p_credit_limit, region = p_region,
    client_group = p_client_group, notes = p_notes,
    company = p_company, job_title = p_job_title, salary = p_salary, pix_key = p_pix_key
    where profile_id = p_client_id;
end;
$$;

-- ============================================================================
-- FIM DA MIGRATION 008
-- ============================================================================

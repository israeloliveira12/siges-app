-- Migration 029:
-- 1) audit_log passa a reter só os 500 eventos mais recentes (poda a cada
--    insert, dentro do próprio log_audit_event) — mesma assinatura de
--    sempre (3 parâmetros), então create or replace substitui direto.
-- 2) Nova RPC complete_client_registration — permite o cliente completar o
--    próprio cadastro (CPF/telefone/empresa/cargo/renda/grupo/chave Pix)
--    logo após o primeiro login via Google, já que o OAuth não passa pelo
--    formulário de cadastro manual (só nome/e-mail vêm do provedor). Só
--    funciona enquanto approval_status ainda é 'pendente'.

create or replace function log_audit_event(
  p_action text,
  p_description text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_actor_role text;
begin
  if v_actor_id is not null then
    select full_name, role::text into v_actor_name, v_actor_role from profiles where id = v_actor_id;
  end if;
  insert into audit_log (actor_id, actor_name, actor_role, action, description, metadata)
  values (v_actor_id, coalesce(v_actor_name, 'Anônimo'), v_actor_role, p_action, p_description, coalesce(p_metadata, '{}'::jsonb));

  delete from audit_log where id in (
    select id from audit_log order by created_at desc offset 500
  );
end;
$$;

create or replace function complete_client_registration(
  p_full_name text,
  p_cpf text,
  p_phone text,
  p_company text,
  p_job_title text,
  p_salary text,
  p_client_group text,
  p_pix_key text
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_client_id uuid := auth.uid();
begin
  if v_client_id is null then raise exception 'FORBIDDEN'; end if;
  if not exists (select 1 from clients where profile_id = v_client_id and approval_status = 'pendente') then
    raise exception 'FORBIDDEN';
  end if;
  if p_full_name is null or trim(p_full_name) = '' then raise exception 'MISSING_FULL_NAME'; end if;
  if p_cpf is null or length(regexp_replace(p_cpf, '\D', '', 'g')) <> 11 then raise exception 'INVALID_CPF'; end if;
  if p_phone is null or trim(p_phone) = '' then raise exception 'MISSING_PHONE'; end if;
  if p_company is null or trim(p_company) = '' then raise exception 'MISSING_COMPANY'; end if;
  if p_job_title is null or trim(p_job_title) = '' then raise exception 'MISSING_JOB_TITLE'; end if;
  if p_salary is null or trim(p_salary) = '' then raise exception 'MISSING_SALARY'; end if;
  if p_client_group is null or trim(p_client_group) = '' then raise exception 'MISSING_GROUP'; end if;
  if p_pix_key is null or trim(p_pix_key) = '' then raise exception 'MISSING_PIX_KEY'; end if;

  update profiles set full_name = p_full_name, cpf = p_cpf, phone = p_phone, updated_at = now()
    where id = v_client_id;
  update clients set company = p_company, job_title = p_job_title, salary = p_salary,
    client_group = p_client_group, pix_key = p_pix_key
    where profile_id = v_client_id;
end;
$$;

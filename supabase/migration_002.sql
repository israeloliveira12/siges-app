-- ============================================================================
-- MIGRATION 002 — rode UMA VEZ no SQL Editor do Supabase do projeto que já
-- está em produção (não re-rode o schema.sql inteiro, ele já foi aplicado).
--
-- Cobre: taxas operacionais de entrada/saída separadas, correção da fórmula
-- de valor desembolsado (soma em vez de subtrai), aprovação de clientes,
-- campos extras de cadastro (empresa/cargo/salário/pix), admin primário com
-- poder de apagar todos os dados, whatsapp/pix da empresa.
-- ============================================================================

-- 1. Novo enum de status de aprovação do cliente
create type client_approval_status as enum ('pendente', 'aprovado', 'rejeitado');

-- 2. profiles: marcar o admin primário (o gerente que já existe hoje)
alter table profiles add column if not exists is_primary_admin boolean not null default false;
update profiles set is_primary_admin = true where email = 'israeloliveira196@gmail.com' and role = 'gerente';

-- 3. clients: aprovação + novos campos de cadastro
alter table clients add column if not exists approval_status client_approval_status not null default 'pendente';
alter table clients add column if not exists decided_by uuid references profiles(id);
alter table clients add column if not exists decided_at timestamptz;
alter table clients add column if not exists decision_reason text;
alter table clients add column if not exists company text;
alter table clients add column if not exists job_title text;
alter table clients add column if not exists salary numeric(12,2);
alter table clients add column if not exists pix_key text;

-- Clientes que já existirem antes desta migração ficam aprovados automaticamente
-- (para não travar contas que já estavam em uso antes da regra existir).
update clients set approval_status = 'aprovado' where approval_status = 'pendente';

-- 4. system_settings: taxas de entrada/saída separadas + contato da empresa
alter table system_settings add column if not exists default_exit_fee_percent numeric(6,3) not null default 0;
alter table system_settings add column if not exists default_entry_fee_percent numeric(6,3) not null default 0;
alter table system_settings add column if not exists company_whatsapp text;
alter table system_settings add column if not exists company_pix_key text;

do $$
begin
  if exists (select 1 from information_schema.columns where table_name='system_settings' and column_name='default_operational_fee_percent') then
    update system_settings set default_exit_fee_percent = default_operational_fee_percent
      where default_exit_fee_percent = 0;
    alter table system_settings drop column default_operational_fee_percent;
  end if;
end $$;

-- 5. loan_contracts: corrige a fórmula (era principal - taxa, o certo é
-- principal + taxa: a taxa é desembolsada A MAIS, não descontada do cliente)
alter table loan_contracts drop column if exists net_disbursed_amount;
alter table loan_contracts add column if not exists total_disbursed_amount numeric(12,2)
  generated always as (principal_amount + operational_fee_amount) stored;

-- 6. Helper de RLS para admin primário (mesma lógica de is_gerente(), evitando
-- recursão de policy)
create or replace function is_primary_admin()
returns boolean language sql stable
security definer set search_path = public
as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'gerente' and is_primary_admin and active);
$$;

-- 7. handle_new_user(): grava os novos campos de cadastro + e-mail em minúsculo
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
    nullif(new.raw_user_meta_data->>'salary', '')::numeric,
    new.raw_user_meta_data->>'pix_key'
  )
  on conflict (profile_id) do nothing;

  return new;
end;
$$;

-- 8. Aprovar / reprovar cliente
create or replace function approve_client(p_client_id uuid)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  update clients set approval_status = 'aprovado', decided_by = auth.uid(), decided_at = now(), decision_reason = null
    where profile_id = p_client_id;

  insert into notifications_log (recipient_id, event, channel, title, body)
  values (p_client_id, 'solicitacao_aprovada', 'in_app', 'Cadastro aprovado', 'Sua conta foi aprovada. Você já pode usar o SIGES normalmente.');
end;
$$;

create or replace function reject_client(p_client_id uuid, p_reason text)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  update clients set approval_status = 'rejeitado', decided_by = auth.uid(), decided_at = now(), decision_reason = p_reason
    where profile_id = p_client_id;

  insert into notifications_log (recipient_id, event, channel, title, body)
  values (p_client_id, 'solicitacao_reprovada', 'in_app', 'Cadastro não aprovado',
          coalesce('Motivo: ' || p_reason, 'Seu cadastro não foi aprovado.'));
end;
$$;

-- 9. Reforço de RLS: só cliente aprovado pode criar solicitação de empréstimo
drop policy if exists "requests_insert_self" on loan_requests;
create policy "requests_insert_self" on loan_requests for insert
  with check (
    client_id = auth.uid()
    and exists (select 1 from clients c where c.profile_id = auth.uid() and c.approval_status = 'aprovado')
  );

-- 10. update_client_profile: inclui os novos campos editáveis pelo gerente
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
  p_salary numeric default null,
  p_pix_key text default null
)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  update profiles set full_name = p_full_name, cpf = p_cpf, phone = p_phone, updated_at = now()
    where id = p_client_id;

  update clients set credit_limit = p_credit_limit, region = p_region,
    client_group = p_client_group, notes = p_notes,
    company = p_company, job_title = p_job_title, salary = p_salary, pix_key = p_pix_key
    where profile_id = p_client_id;
end;
$$;

-- 10b. Editar dados básicos de outro administrador/gerente (nunca altera
-- is_primary_admin por aqui, propositalmente)
create or replace function update_gerente_profile(
  p_gerente_id uuid,
  p_full_name text,
  p_phone text,
  p_active boolean
)
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  update profiles set full_name = p_full_name, phone = p_phone, active = p_active, updated_at = now()
    where id = p_gerente_id and role = 'gerente';
end;
$$;

-- 11. Apagar todos os dados de negócio (só admin primário). Chamada pela
-- serverless function /api/wipe-all-data.js, que também remove as contas de
-- auth.users dos clientes via service_role (SQL puro não alcança auth.users).
create or replace function wipe_all_business_data()
returns void language plpgsql
security definer set search_path = public
as $$
begin
  if not is_primary_admin() then
    raise exception 'FORBIDDEN';
  end if;

  delete from payments;
  delete from renewal_cycles;
  delete from installments;
  delete from loan_contracts;
  delete from loan_requests;
  delete from notifications_log;
  delete from push_subscriptions;
  delete from clients;
  delete from profiles where role = 'cliente';
end;
$$;

-- ============================================================================
-- FIM DA MIGRATION 002
-- ============================================================================

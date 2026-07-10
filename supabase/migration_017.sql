-- ============================================================================
-- MIGRATION 017 — rode UMA VEZ no SQL Editor do Supabase (depois da migration_016)
--
-- Cobre: nova tela "Auditoria" pro admin. Cria a tabela audit_log (trilha de
-- ações importantes do sistema — criação/edição/exclusão de contrato e
-- cliente, aprovação/rejeição de cadastro, pagamento recebido, renovação,
-- login falho) + a função log_audit_event() que o JS chama pra registrar
-- cada evento. Só gerente pode LER a tabela; a escrita só acontece via essa
-- função (security definer), inclusive para eventos sem sessão ainda (ex:
-- tentativa de login falha, onde não existe auth.uid()).
-- ============================================================================

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references profiles(id) on delete set null,
  actor_name text,
  actor_role text,
  action text not null,
  description text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_created_at_idx on audit_log(created_at desc);
create index audit_log_actor_id_idx on audit_log(actor_id);

alter table audit_log enable row level security;
create policy "audit_log_select_gerente" on audit_log for select using (is_gerente());

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
end;
$$;

-- Migration 045 — 2 bugs reais achados numa rodada de testes dirigidos
-- contra os RPCs novos da migration_043 (Plano Grátis/Trial/Assinaturas),
-- direto em produção com dados sintéticos.

-- 1) Apagar um plano que tinha empresa em teste deixava trial_ends_at
--    órfão — a empresa passava a mostrar "sem plano (ilimitado)" E "Em
--    teste — expira em Nd" ao mesmo tempo na tela Empresas (contraditório,
--    já que não há mais plano nenhum associado a esse teste).
create or replace function delete_plan(p_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  update tenants set trial_ends_at = null where plan_id = p_id;
  delete from plans where id = p_id;
end;
$$;

-- 2) upsert_tenant_payment com p_status NULL passava direto pro INSERT/
--    UPDATE (a comparação "not in" do SQL nunca é true com NULL) e quebrava
--    com o erro cru "null value in column status violates not-null
--    constraint" em vez da mensagem amigável INVALID_STATUS. Inofensivo
--    hoje (a tela sempre envia um status), mas é a mesma defesa em
--    profundidade já aplicada em outros pontos do schema.
create or replace function upsert_tenant_payment(
  p_id uuid,
  p_tenant_id uuid,
  p_amount numeric,
  p_due_date date,
  p_paid_date date,
  p_method text,
  p_status text,
  p_notes text
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'INVALID_AMOUNT'; end if;
  if not exists (select 1 from tenants where id = p_tenant_id) then raise exception 'NOT_FOUND'; end if;
  if p_status is null or p_status not in ('pendente', 'pago', 'atrasado', 'cancelado') then raise exception 'INVALID_STATUS'; end if;

  if p_id is null then
    insert into tenant_payments (tenant_id, amount, due_date, paid_date, method, status, notes, created_by)
    values (p_tenant_id, p_amount, p_due_date, p_paid_date, nullif(trim(p_method), ''), p_status, nullif(trim(p_notes), ''), auth.uid())
    returning id into v_id;
  else
    update tenant_payments set
      tenant_id = p_tenant_id, amount = p_amount, due_date = p_due_date, paid_date = p_paid_date,
      method = nullif(trim(p_method), ''), status = p_status, notes = nullif(trim(p_notes), '')
    where id = p_id
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

-- Migration 044 — Bug real corrigido: list_platform_broadcasts() (tela
-- Comunicados) falhava sempre com "function min(uuid) does not exist" —
-- Postgres não tem min()/max() nativo pra uuid. Achado testando a tela ao
-- vivo logo depois da migration_043. O envio do comunicado em si (
-- broadcast_platform_message) sempre funcionou normal; só o HISTÓRICO
-- quebrava.

create or replace function list_platform_broadcasts()
returns table (title text, body text, sent_at timestamptz, recipient_count bigint, tenant_scope text)
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  return query
  select
    n.title, n.body, n.sent_at, count(*),
    case when count(distinct n.tenant_id) = 1
      then coalesce((select t.name from tenants t where t.id = (array_agg(n.tenant_id))[1]), 'Empresa excluída')
      else 'Todas as empresas'
    end
  from notifications_log n
  where n.event = 'aviso_plataforma'::notification_event
  group by n.title, n.body, n.sent_at
  order by n.sent_at desc
  limit 50;
end;
$$;

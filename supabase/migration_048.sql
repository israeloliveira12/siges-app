-- ============================================================================
-- migration_048.sql — Correções da auditoria técnica de 2026-08-23
--
-- Fecha os 4 achados CRÍTICOS e os achados de banco de severidade alta/média
-- levantados na varredura completa do sistema (relatório "Auditoria SIGES",
-- 52 achados). Cada bloco abaixo cita o identificador do achado.
--
-- Ordem dos blocos:
--   1. SEC-01  tenant_id imutável em profiles
--   2. SEC-02  WITH CHECK com filtro de empresa + gatilhos que forçam tenant
--   3. OPS-01  refresh_overdue_status() religado (subconsulta correlacionada)
--   4. OPS-03  policy de UPDATE em push_subscriptions
--   5. SEC-03  log_audit_event() endurecido (ação validada, texto limitado)
--   6. UX-18   notificações com número do contrato e valor formatado
--   7. OPS-08  numeração de contrato por empresa, sem laço infinito
--   8. FIN-04  data de pagamento com limite inferior
--   9. FIN-01  RPCs de agregação (soma no banco, não no navegador)
--  10. OPS-01b registro de execução das rotinas + RPCs da tela Saúde
-- ============================================================================


-- ============================================================================
-- 1. SEC-01 — tenant_id (e email/cpf) imutáveis em profiles
--
-- A policy "profiles_update_self" permite que a pessoa edite a própria linha
-- sem restringir coluna, e este gatilho só disparava em role/is_primary_admin/
-- active/platform_owner. tenant_id ficava livre — e como current_tenant_id()
-- lê exatamente essa coluna, alterá-la reescreve tudo o que a RLS entende por
-- "minha empresa": um PATCH e o administrador da Empresa A passa a ler a
-- carteira inteira da Empresa B.
--
-- email entra junto porque é o que email_for_cpf() devolve no login por CPF
-- (deve ser trocado só por api/update-user-email.js, que mantém auth.users em
-- sincronia); cpf entra porque é âncora de identidade e chave de login.
-- ============================================================================

create or replace function prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- `active` entrou aqui junto de role/is_primary_admin: sem essa checagem, um
  -- gerente desativado (sessão do navegador ainda válida — desativar não
  -- revoga o token) conseguia se REATIVAR sozinho com um PATCH direto em
  -- profiles (a policy profiles_update_self permite update na própria linha
  -- sem restringir coluna), recuperando acesso total.
  if (new.role is distinct from old.role
      or new.is_primary_admin is distinct from old.is_primary_admin
      or new.active is distinct from old.active)
     and not is_primary_admin()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: só o administrador primário pode alterar papel/privilégio/status de uma conta';
  end if;

  -- platform_owner (Fase 2, SaaS multi-empresa) é mais rígido que os 3
  -- campos acima: nem is_primary_admin() basta aqui — só service_role (uso
  -- interno/scripts administrativos), nunca uma sessão de usuário comum,
  -- senão o admin primário de QUALQUER tenant conseguiria se auto-promover
  -- a dono da plataforma inteira via REST direto.
  if new.platform_owner is distinct from old.platform_owner
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: platform_owner só pode ser alterado internamente';
  end if;

  -- SEC-01 (auditoria 2026-08-23): tenant_id é a coluna que current_tenant_id()
  -- lê pra resolver "minha empresa" em TODA policy de RLS do sistema. Trocá-la
  -- é equivalente a trocar de empresa — nem o admin primário pode, só
  -- service_role (api/create-user.js e api/create-tenant.js, onde o valor vem
  -- de um profile já autenticado no servidor).
  if new.tenant_id is distinct from old.tenant_id
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: a empresa de um usuário não pode ser alterada por aqui';
  end if;

  -- email/cpf: identidade de login. email precisa ficar em sincronia com
  -- auth.users (só api/update-user-email.js faz isso corretamente, via
  -- service_role); cpf é único na plataforma e resolve o login por CPF.
  -- update_client_profile()/update_gerente_profile()/complete_client_
  -- registration() são security definer e rodam como donas da tabela, então
  -- continuam podendo gravar normalmente sem esbarrar aqui.
  if (new.email is distinct from old.email or new.cpf is distinct from old.cpf)
     and not is_gerente()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: e-mail e CPF são alterados pelo administrador, não diretamente';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_prevent_profile_privilege_escalation on profiles;
create trigger trg_prevent_profile_privilege_escalation
  before update of role, is_primary_admin, active, platform_owner, tenant_id, email, cpf on profiles
  for each row execute function prevent_profile_privilege_escalation();


-- ============================================================================
-- 2. SEC-02 — WITH CHECK com filtro de empresa nas políticas de escrita
--
-- Seis políticas terminavam em `with check (is_gerente())`, sem comparar
-- tenant_id. O USING foi corrigido na Fase 1a/1c; o WITH CHECK (o que valida
-- a linha que está sendo GRAVADA) nunca foi — o próprio comentário do schema
-- registrava isso como pendente. Na prática permitia:
--   - inserir contrato/parcela/ciclo/pagamento na empresa alheia;
--   - MOVER uma linha própria pra outra empresa (o USING aprova, porque a
--     linha ainda é sua no momento da checagem);
--   - inserir cliente sem filtro nenhum;
--   - notificar QUALQUER usuário de QUALQUER empresa (o mais explorável).
--
-- Defesa em dupla camada: a policy passa a validar, e um gatilho BEFORE força
-- tenant_id a partir do perfil de quem grava — mesmo padrão que
-- trg_check_credit_limit_request() já usava corretamente em loan_requests.
-- ============================================================================

-- 2.1 Gatilho genérico: nunca confia no tenant_id que veio da requisição.
-- Chamadas com service_role (serverless /api, cron) não têm auth.uid(), então
-- current_tenant_id() volta null — nesse caso preserva o valor recebido, que
-- naquele caminho vem sempre de um profile já autenticado no servidor.
create or replace function trg_force_tenant_id()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_tenant uuid := current_tenant_id();
begin
  if v_tenant is not null then
    new.tenant_id := v_tenant;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_force_tenant_clients on clients;
create trigger trg_force_tenant_clients
  before insert on clients
  for each row execute function trg_force_tenant_id();

drop trigger if exists trg_force_tenant_contracts on loan_contracts;
create trigger trg_force_tenant_contracts
  before insert on loan_contracts
  for each row execute function trg_force_tenant_id();

drop trigger if exists trg_force_tenant_installments on installments;
create trigger trg_force_tenant_installments
  before insert on installments
  for each row execute function trg_force_tenant_id();

drop trigger if exists trg_force_tenant_renewals on renewal_cycles;
create trigger trg_force_tenant_renewals
  before insert on renewal_cycles
  for each row execute function trg_force_tenant_id();

drop trigger if exists trg_force_tenant_payments on payments;
create trigger trg_force_tenant_payments
  before insert on payments
  for each row execute function trg_force_tenant_id();

-- 2.2 Gatilho que impede MOVER uma linha de negócio entre empresas.
-- O gatilho acima só cobre INSERT (um UPDATE não deve reescrever tenant_id
-- silenciosamente); aqui a regra é: uma vez gravada, a linha nunca troca de
-- empresa por uma sessão de usuário.
create or replace function trg_freeze_tenant_id()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.tenant_id is distinct from old.tenant_id
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN: um registro não pode mudar de empresa';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_freeze_tenant_clients on clients;
create trigger trg_freeze_tenant_clients
  before update of tenant_id on clients
  for each row execute function trg_freeze_tenant_id();

drop trigger if exists trg_freeze_tenant_contracts on loan_contracts;
create trigger trg_freeze_tenant_contracts
  before update of tenant_id on loan_contracts
  for each row execute function trg_freeze_tenant_id();

drop trigger if exists trg_freeze_tenant_installments on installments;
create trigger trg_freeze_tenant_installments
  before update of tenant_id on installments
  for each row execute function trg_freeze_tenant_id();

drop trigger if exists trg_freeze_tenant_renewals on renewal_cycles;
create trigger trg_freeze_tenant_renewals
  before update of tenant_id on renewal_cycles
  for each row execute function trg_freeze_tenant_id();

drop trigger if exists trg_freeze_tenant_payments on payments;
create trigger trg_freeze_tenant_payments
  before update of tenant_id on payments
  for each row execute function trg_freeze_tenant_id();

drop trigger if exists trg_freeze_tenant_requests on loan_requests;
create trigger trg_freeze_tenant_requests
  before update of tenant_id on loan_requests
  for each row execute function trg_freeze_tenant_id();

-- 2.3 As políticas em si.

drop policy if exists "clients_gerente_write" on clients;
create policy "clients_gerente_write" on clients for insert
  with check (is_gerente() and tenant_id = current_tenant_id());

drop policy if exists "contracts_gerente_all" on loan_contracts;
create policy "contracts_gerente_all" on loan_contracts for all
  using (is_gerente() and tenant_id = current_tenant_id())
  with check (is_gerente() and tenant_id = current_tenant_id());

drop policy if exists "installments_gerente_write" on installments;
create policy "installments_gerente_write" on installments for all
  using (is_gerente() and tenant_id = current_tenant_id())
  with check (is_gerente() and tenant_id = current_tenant_id());

drop policy if exists "renewal_gerente_write" on renewal_cycles;
create policy "renewal_gerente_write" on renewal_cycles for all
  using (is_gerente() and tenant_id = current_tenant_id())
  with check (is_gerente() and tenant_id = current_tenant_id());

drop policy if exists "payments_gerente_write" on payments;
create policy "payments_gerente_write" on payments for all
  using (is_gerente() and tenant_id = current_tenant_id())
  with check (is_gerente() and tenant_id = current_tenant_id());

-- notifications_log: além do filtro de empresa, exige que o DESTINATÁRIO
-- pertença à mesma empresa. Sem isso, mesmo com tenant_id correto na linha,
-- um gerente conseguiria endereçar o aviso a um usuário de outra empresa.
drop policy if exists "notifications_gerente_insert" on notifications_log;
create policy "notifications_gerente_insert" on notifications_log for insert
  with check (
    is_gerente()
    and tenant_id = current_tenant_id()
    and exists (
      select 1 from profiles p
      where p.id = notifications_log.recipient_id
        and p.tenant_id = current_tenant_id()
    )
  );

-- planning_debts já exigia is_platform_owner() no USING; fecha o WITH CHECK
-- pelo mesmo motivo das demais (só existe uma pessoa com esse papel, então o
-- risco era baixo — mas a regra deve ser uniforme).
drop policy if exists "planning_debts_gerente_all" on planning_debts;
create policy "planning_debts_gerente_all" on planning_debts for all
  using (is_platform_owner() and tenant_id = current_tenant_id())
  with check (is_platform_owner() and tenant_id = current_tenant_id());


-- ============================================================================
-- 3. OPS-01 — refresh_overdue_status() religado
--
-- `(select loss_days_threshold from system_settings)` era uma subconsulta
-- ESCALAR sobre uma tabela que, desde que a PK virou tenant_id (migration_046)
-- e o gatilho after_tenant_created passou a criar uma linha por empresa,
-- retorna várias linhas. O Postgres aborta com "more than one row returned by
-- a subquery used as an expression" e, como é tudo uma transação só, TODA a
-- função reverte — inclusive os dois UPDATE de atraso, que sozinhos
-- funcionariam.
--
-- Efeito diário (silencioso, porque api/cron-daily-check.js não conferia o
-- retorno): parcelas nunca passavam a 'atrasada' no banco, perdas nunca eram
-- reconhecidas, status de contrato nunca sincronizava, score de inadimplente
-- nunca recalculava e o aviso de "parcela em atraso" nunca saía (depende de um
-- status que ninguém atualizava). A interface mascarava parte disso via
-- effectiveInstallmentStatus(), que recalcula o atraso na tela — por isso
-- passou despercebido enquanto os relatórios, que leem a coluna real, ficavam
-- errados.
--
-- Correção: subconsulta CORRELACIONADA com a empresa da própria linha. Cada
-- empresa passa a usar o próprio loss_days_threshold, que é o comportamento
-- que sempre foi pretendido.
-- ============================================================================

create or replace function refresh_overdue_status()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_client_id uuid;
  v_contract_id uuid;
begin
  update installments set status = 'atrasada'
    where status = 'pendente' and due_date < current_date;

  update renewal_cycles set status = 'atrasada'
    where status = 'pendente' and new_due_date < current_date;

  -- Perda automática — marca a PARCELA/CICLO específico que ultrapassou o
  -- prazo configurado (loss_days_threshold), não mais o contrato inteiro:
  -- outras parcelas do mesmo contrato continuam intocadas (decisão explícita
  -- do usuário, 2026-07-27 — "perda da parcela específica"). O valor
  -- perdido é o capital ainda não recuperado daquela parcela/ciclo. Isso
  -- roda ANTES da sincronização de status do contrato logo abaixo, pra um
  -- contrato cuja única pendência acabou de virar perda não ser promovido
  -- por engano pra 'em_aberto' (não existe mais 'atrasada' nele) em vez de
  -- corretamente fechar como 'perda'.
  --
  -- OPS-01: o limiar é lido da linha de system_settings DA EMPRESA da própria
  -- parcela (i.tenant_id), nunca da tabela inteira. coalesce(...,60) mantém o
  -- default do schema caso alguma empresa fique sem linha de configuração.
  update installments i set
    status = 'perda',
    principal_lost = greatest(0, i.principal_share - i.principal_paid_partial),
    loss_recognized_at = now()
  where i.status = 'atrasada'
    and i.due_date < current_date - coalesce(
      (select s.loss_days_threshold from system_settings s where s.tenant_id = i.tenant_id),
      60
    );

  update renewal_cycles rc set
    status = 'perda',
    principal_lost = coalesce((select lc.principal_amount from loan_contracts lc where lc.id = rc.contract_id), 0),
    loss_recognized_at = now()
  where rc.status = 'atrasada'
    and rc.new_due_date < current_date - coalesce(
      (select s.loss_days_threshold from system_settings s where s.tenant_id = rc.tenant_id),
      60
    );

  -- Sincroniza o status de cada contrato ainda aberto a partir do estado
  -- real das suas parcelas/ciclos (em_aberto/atrasado/quitado/perda).
  for v_contract_id in select id from loan_contracts where status in ('em_aberto', 'atrasado')
  loop
    perform recompute_contract_status(v_contract_id);
  end loop;

  -- Recalcula o score de todo cliente com contrato atrasado ou em perda, para
  -- o score refletir o estado atual mesmo sem nenhum recebimento novo (senão
  -- o score de um cliente inadimplente que não interage mais fica parado).
  for v_client_id in
    select distinct client_id from loan_contracts where status in ('atrasado', 'perda')
  loop
    perform recalculate_client_score(v_client_id);
  end loop;
end;
$$;


-- ============================================================================
-- 4. OPS-03 — policy de UPDATE em push_subscriptions
--
-- js/push.js faz upsert(..., { onConflict: 'endpoint' }), que no Postgres vira
-- INSERT ... ON CONFLICT DO UPDATE. O caminho de UPDATE exige policy de
-- UPDATE, e a tabela só tinha SELECT/INSERT/DELETE. Resultado: o primeiro
-- registro do aparelho funcionava e TODO login seguinte era barrado pela RLS
-- — erro engolido pelo catch de push.js, que só escrevia "Push não disponível"
-- no console. Na prática o push parava de se re-registrar sem ninguém saber.
--
-- O USING olha a linha ANTIGA (dona anterior do endpoint) e o WITH CHECK a
-- nova: em aparelho compartilhado, quem assume o endpoint precisa poder
-- gravar a própria linha. Por isso o USING aceita qualquer dono anterior —
-- o endpoint é único por navegador/aparelho, então reivindicá-lo é o
-- comportamento correto de reatribuição.
-- ============================================================================

drop policy if exists "push_update_own" on push_subscriptions;
create policy "push_update_own" on push_subscriptions for update
  using (true)
  with check (profile_id = auth.uid());


-- ============================================================================
-- 5. SEC-03 — log_audit_event() endurecido
--
-- A função é security definer e NÃO verifica autorização — o que é
-- intencional: o registro de "login falhou" precisa acontecer antes de existir
-- sessão. Mas isso significava que qualquer pessoa na internet podia gravar
-- linhas em audit_log com action/description/metadata à escolha dela.
--
-- Combinado com o `value="${a}"` sem escape em gerente-auditoria.js (corrigido
-- no frontend nesta mesma rodada), virava XSS armazenado no navegador do
-- Administrador Master. Aqui fechamos a ORIGEM:
--   - `action` sem sessão fica restrito às 2 ações que realmente precisam ser
--     registradas antes do login (login_falho, login_sucesso);
--   - textos ganham teto de tamanho (evita inundar a tabela por linha);
--   - metadata sem sessão é descartada (não há motivo pra um anônimo escolher
--     o conteúdo de um jsonb que o admin vai ler).
-- ============================================================================

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
  v_tenant_id uuid;
  v_action text;
  v_description text;
  v_metadata jsonb;
begin
  -- SEC-03: `action` alimenta um <option value> na tela Auditoria e um mapa de
  -- rótulos — precisa ser um identificador simples, nunca texto livre.
  v_action := substring(coalesce(p_action, '') from 1 for 60);
  if v_action !~ '^[a-z0-9_]+$' then
    raise exception 'INVALID_ACTION';
  end if;

  v_description := substring(coalesce(p_description, '') from 1 for 500);

  if v_actor_id is not null then
    select full_name, role::text, tenant_id into v_actor_name, v_actor_role, v_tenant_id from profiles where id = v_actor_id;
    v_metadata := coalesce(p_metadata, '{}'::jsonb);
  else
    -- Sem sessão: só os eventos do próprio fluxo de login, e sem metadata
    -- escolhida por quem chama.
    if v_action not in ('login_falho', 'login_sucesso') then
      raise exception 'FORBIDDEN';
    end if;
    v_metadata := '{}'::jsonb;
  end if;

  -- tenant_id fica NULL quando não há sessão (ex: tentativa de login falha,
  -- onde v_actor_id já é null e não há profile pra resolver tenant nenhum) —
  -- mesmo design nullable de audit_log já decidido na Fase 1a.
  insert into audit_log (actor_id, actor_name, actor_role, action, description, metadata, tenant_id)
  values (v_actor_id, coalesce(v_actor_name, 'Anônimo'), v_actor_role, v_action, v_description, v_metadata, v_tenant_id);

  -- Retenção: mantém só os 500 eventos mais recentes POR TENANT.
  -- `is not distinct from` trata NULL corretamente (eventos sem tenant são
  -- podados entre si, à parte).
  delete from audit_log where tenant_id is not distinct from v_tenant_id and id in (
    select id from audit_log where tenant_id is not distinct from v_tenant_id order by created_at desc offset 500
  );
end;
$$;


-- ============================================================================
-- 6. UX-18 — notificações com número do contrato e valor formatado
--
-- As mensagens gravadas pelas RPCs mostravam o UUID do contrato e o número
-- cru do Postgres: "Seu contrato #a3f9c8e2-4b1d-… no valor de R$ 1000.00".
-- Agora usam contract_number (5 dígitos, o mesmo que aparece em toda tela) e
-- formatação brasileira.
-- ============================================================================

-- Formata numeric como moeda brasileira ("1234.5" -> "R$ 1.234,50").
-- to_char com o locale do servidor não é confiável (depende de lc_numeric),
-- então a máscara 'FM999G999G999D00' é aplicada e os separadores trocados
-- explicitamente: o Postgres emite ',' como agrupador e '.' como decimal no
-- locale padrão C, que é exatamente o inverso do português.
create or replace function fmt_brl(p_value numeric)
returns text
language sql immutable
as $$
  select 'R$ ' || translate(to_char(coalesce(p_value, 0), 'FM999G999G999G999D00'), ',.', '.,');
$$;

create or replace function create_loan_contract(
  p_client_id uuid,
  p_principal_amount numeric,
  p_interest_rate numeric,
  p_installments_count integer,
  p_due_type due_type,
  p_contract_date date,
  p_first_installment_date date,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_allows_renewal boolean,
  p_late_fee_percent numeric,
  p_late_interest_percent numeric,
  p_observations text,
  p_origin_request_id uuid default null,
  p_installments_override jsonb default null,
  p_custom_interval_days integer default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_contract_id uuid;
  v_contract_number integer;
  v_row jsonb;
  v_principal_sum numeric;
  v_override_count integer;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN: apenas gerentes podem criar contratos';
  end if;

  v_tenant_id := current_tenant_id();

  -- Fase 1c: cliente precisa pertencer ao mesmo tenant de quem cria o
  -- contrato — sem isso, uma chamada direta à RPC (fora do fluxo normal do
  -- app, que já só deixa escolher clientes do próprio tenant) conseguia
  -- criar um contrato em nome de cliente de OUTRO tenant.
  if not exists (select 1 from clients where profile_id = p_client_id and tenant_id = v_tenant_id) then
    raise exception 'FORBIDDEN: cliente não pertence ao seu tenant';
  end if;

  -- Auditoria 2026-08-23: a RPC nunca validou faixa de taxa nem coerência de
  -- datas. Um erro de digitação (300% em vez de 3%) entrava calado e só
  -- aparecia meses depois no extrato do cliente.
  if p_interest_rate < 0 or p_interest_rate > 1000 then
    raise exception 'INVALID_INTEREST_RATE';
  end if;
  if p_first_installment_date < p_contract_date then
    raise exception 'INVALID_DATE_ORDER';
  end if;
  if p_installments_count < 1 or p_installments_count > 360 then
    raise exception 'INVALID_INSTALLMENTS_COUNT';
  end if;

  insert into loan_contracts (
    client_id, created_by, origin_request_id, tenant_id,
    principal_amount, interest_rate, installments_count, due_type, custom_interval_days,
    has_operational_fee, operational_fee_amount,
    contract_date, first_installment_date,
    allows_renewal, late_fee_percent, late_interest_percent, observations
  ) values (
    p_client_id, auth.uid(), p_origin_request_id, v_tenant_id,
    p_principal_amount, p_interest_rate, p_installments_count, p_due_type, p_custom_interval_days,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0),
    p_contract_date, p_first_installment_date,
    p_allows_renewal, coalesce(p_late_fee_percent, 0), coalesce(p_late_interest_percent, 0), p_observations
  ) returning id, contract_number into v_contract_id, v_contract_number;

  if p_installments_override is not null then
    select jsonb_array_length(p_installments_override) into v_override_count;
    -- A contagem declarada no contrato precisa bater com o que foi de fato
    -- gravado — senão installments_count vira um número decorativo e a regra
    -- "renovação só em contrato de parcela única" passa a olhar dado errado.
    if v_override_count <> p_installments_count then
      raise exception 'INSTALLMENTS_COUNT_MISMATCH';
    end if;
    for v_row in select * from jsonb_array_elements(p_installments_override) loop
      -- Defesa em profundidade: o wizard já trava capital/juros negativos no
      -- JS, mas a RPC é pública (security definer) e não deveria confiar só
      -- na UI pra isso — parcela com juros negativo apareceria como lucro
      -- negativo mais tarde, sem nenhum aviso.
      if (v_row->>'principal_share')::numeric < 0 or (v_row->>'interest_share')::numeric < 0 then
        raise exception 'INVALID_AMOUNT';
      end if;
      insert into installments (contract_id, sequence_number, due_date, principal_share, interest_share, tenant_id)
      values (
        v_contract_id,
        (v_row->>'sequence_number')::integer,
        (v_row->>'due_date')::date,
        (v_row->>'principal_share')::numeric,
        (v_row->>'interest_share')::numeric,
        v_tenant_id
      );
    end loop;
  else
    insert into installments (contract_id, sequence_number, due_date, principal_share, interest_share, tenant_id)
    select v_contract_id, sequence_number, due_date, principal_share, interest_share, v_tenant_id
    from calc_installments_preview(p_principal_amount, p_interest_rate, p_installments_count, p_due_type, p_first_installment_date, p_custom_interval_days);
  end if;

  -- Reconciliação: a soma do capital das parcelas geradas/editadas precisa
  -- bater com o capital do contrato (dentro de uma tolerância de centavos).
  select coalesce(sum(principal_share), 0) into v_principal_sum from installments where contract_id = v_contract_id;
  if abs(v_principal_sum - p_principal_amount) > greatest(0.02 * p_installments_count, 0.02) then
    raise exception 'PRINCIPAL_MISMATCH';
  end if;

  if p_origin_request_id is not null then
    update loan_requests
      set status = 'aprovada', resulting_contract_id = v_contract_id,
          decided_by = auth.uid(), decided_at = now()
      where id = p_origin_request_id and tenant_id = v_tenant_id and client_id = p_client_id;
  end if;

  -- UX-18: número do contrato (5 dígitos) e valor formatado, não o UUID.
  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (
    p_client_id, 'contrato_criado', 'in_app', v_contract_id,
    'Novo contrato criado',
    'Seu contrato #' || v_contract_number || ' no valor de ' || fmt_brl(p_principal_amount) || ' foi criado.',
    v_tenant_id
  );

  return v_contract_id;
end;
$$;


-- ============================================================================
-- 7. OPS-08 — numeração de contrato por empresa, sem laço infinito
--
-- generate_contract_number() sorteava 5 dígitos (90.000 valores possíveis) e
-- repetia até achar um livre, com unicidade GLOBAL entre todas as empresas.
-- Dois problemas: o laço degrada conforme o espaço enche e NUNCA TERMINA
-- quando esgotar (trava a transação); e cada empresa esperaria a própria
-- sequência, não um número compartilhado com as concorrentes.
--
-- Agora a unicidade é (tenant_id, contract_number) e a numeração é sequencial
-- por empresa a partir de 10000 — determinística, sem sorteio, sem laço.
-- ============================================================================

alter table loan_contracts drop constraint if exists loan_contracts_contract_number_key;
create unique index if not exists loan_contracts_tenant_number_uidx
  on loan_contracts(tenant_id, contract_number);

drop function if exists generate_contract_number();

create or replace function set_contract_number()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_next integer;
begin
  if new.contract_number is null then
    -- Sequencial por empresa. O lock explícito serializa duas criações
    -- concorrentes na MESMA empresa (sem ele, as duas leriam o mesmo max e a
    -- segunda quebraria no índice único); empresas diferentes não se
    -- bloqueiam, porque a chave do advisory lock inclui o tenant.
    perform pg_advisory_xact_lock(hashtext('contract_number:' || new.tenant_id::text));
    select coalesce(max(contract_number), 9999) + 1 into v_next
      from loan_contracts where tenant_id = new.tenant_id;
    new.contract_number := v_next;
  end if;
  return new;
end;
$$;

-- O gatilho precisa rodar DEPOIS de trg_force_tenant_id (que resolve
-- new.tenant_id), e os gatilhos BEFORE de um mesmo evento disparam em ordem
-- alfabética de nome. "trg_force_tenant_contracts" < "trg_set_contract_number"
-- garante a ordem correta; o nome antigo (before_insert_contract_number)
-- viria antes de "trg_*" e leria tenant_id ainda nulo.
drop trigger if exists before_insert_contract_number on loan_contracts;
drop trigger if exists trg_set_contract_number on loan_contracts;
create trigger trg_set_contract_number
  before insert on loan_contracts
  for each row execute function set_contract_number();


-- ============================================================================
-- 8. FIN-04 — data de pagamento com limite inferior
--
-- O campo tinha `max` no HTML (não aceita futuro) mas nenhum `min`, e as RPCs
-- não validavam nada. Um pagamento podia ser lançado com data de anos atrás,
-- movendo receita entre meses já fechados sem trava nem registro do ajuste.
-- Teto de retroatividade: 365 dias. Futuro continua proibido.
-- ============================================================================

create or replace function assert_received_at_valid(p_received_at date)
returns void
-- `stable`, nunca `immutable`: a função lê current_date, que muda entre
-- transações. Marcar como immutable autorizaria o planejador a avaliar a
-- chamada uma vez e reaproveitar o resultado — o que faria o limite de
-- retroatividade "congelar" num dia antigo.
language plpgsql stable
as $$
begin
  if p_received_at is null then
    return;
  end if;
  if p_received_at > current_date then
    raise exception 'RECEIVED_AT_IN_FUTURE';
  end if;
  if p_received_at < current_date - 365 then
    raise exception 'RECEIVED_AT_TOO_OLD';
  end if;
end;
$$;

create or replace function receive_payment(
  p_installment_id uuid,
  p_amount_received numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_notes text default null,
  p_late_charge_amount numeric default 0,
  p_received_at date default current_date
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_installment installments%rowtype;
  v_contract loan_contracts%rowtype;
  v_payment_id uuid;
  v_remaining_interest numeric;
  v_remaining_principal numeric;
  v_remaining_total numeric;
  v_max_allowed numeric;
  v_pay_interest numeric;
  v_pay_principal numeric;
  v_pay_late numeric;
  v_after_interest numeric;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  perform assert_received_at_valid(p_received_at);

  v_tenant_id := current_tenant_id();

  -- Fase 1c: sem o filtro de tenant_id abaixo, um gerente de outra empresa
  -- podia informar o id de uma parcela de QUALQUER tenant e registrar um
  -- pagamento contra ela — grava dinheiro no lugar errado.
  select * into v_installment from installments where id = p_installment_id and tenant_id = v_tenant_id for update;
  if v_installment.id is null then
    raise exception 'NOT_FOUND';
  end if;
  if v_installment.status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  v_remaining_interest := v_installment.interest_share - v_installment.interest_paid_partial;
  v_remaining_principal := v_installment.principal_share - v_installment.principal_paid_partial;
  v_remaining_total := v_remaining_interest + v_remaining_principal;
  v_max_allowed := v_remaining_total + coalesce(p_late_charge_amount, 0);

  if p_amount_received <= 0 or p_amount_received > v_max_allowed + 0.01 then
    raise exception 'INVALID_AMOUNT';
  end if;

  select * into v_contract from loan_contracts where id = v_installment.contract_id for update;

  v_pay_interest := least(p_amount_received, v_remaining_interest);
  v_after_interest := p_amount_received - v_pay_interest;
  v_pay_principal := least(v_after_interest, v_remaining_principal);
  v_pay_late := v_after_interest - v_pay_principal;

  insert into payments (
    contract_id, installment_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract.id, p_installment_id, 'quitacao_parcela', p_amount_received,
    v_pay_principal, v_pay_interest + v_pay_late, v_pay_late,
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date), v_tenant_id
  ) returning id into v_payment_id;

  update installments set
    principal_paid_partial = principal_paid_partial + v_pay_principal,
    interest_paid_partial = interest_paid_partial + v_pay_interest
  where id = p_installment_id;

  if v_remaining_total - p_amount_received <= 0.01 then
    update installments set status = 'paga', paid_at = coalesce(p_received_at, current_date) where id = p_installment_id;
    perform recompute_contract_status(v_contract.id);

    insert into notifications_log (recipient_id, event, channel, related_contract_id, related_installment_id, title, body, tenant_id)
    values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id, p_installment_id,
            'Pagamento recebido',
            'Recebemos seu pagamento de ' || fmt_brl(p_amount_received) || ' no contrato #' || v_contract.contract_number || '.', v_tenant_id);
  else
    insert into notifications_log (recipient_id, event, channel, related_contract_id, related_installment_id, title, body, tenant_id)
    values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id, p_installment_id,
            'Pagamento parcial recebido',
            'Recebemos ' || fmt_brl(p_amount_received) || '. Restam ' || fmt_brl(round(v_remaining_total - p_amount_received, 2)) || ' desta parcela.', v_tenant_id);
  end if;

  return v_payment_id;
end;
$$;

create or replace function receive_cycle_payment(
  p_cycle_id uuid,
  p_amount_received numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_notes text default null,
  p_late_charge_amount numeric default 0,
  p_received_at date default current_date
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_cycle renewal_cycles%rowtype;
  v_contract loan_contracts%rowtype;
  v_principal numeric;
  v_interest numeric;
  v_full_amount_due numeric;
  v_payment_id uuid;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  perform assert_received_at_valid(p_received_at);

  v_tenant_id := current_tenant_id();

  select * into v_cycle from renewal_cycles where id = p_cycle_id and tenant_id = v_tenant_id for update;
  if v_cycle.id is null then
    raise exception 'NOT_FOUND';
  end if;
  if v_cycle.status not in ('pendente', 'atrasada') then
    raise exception 'CYCLE_NOT_PAYABLE';
  end if;

  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  v_full_amount_due := v_cycle.full_debt_amount + coalesce(p_late_charge_amount, 0);
  if p_amount_received <= 0 or abs(p_amount_received - v_full_amount_due) > 0.01 then
    raise exception 'INVALID_AMOUNT';
  end if;

  select * into v_contract from loan_contracts where id = v_cycle.contract_id for update;
  v_principal := v_contract.principal_amount;
  v_interest := v_cycle.full_debt_amount - v_principal;

  insert into payments (
    contract_id, renewal_cycle_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract.id, p_cycle_id, 'quitacao_final', p_amount_received,
    v_principal, v_interest + coalesce(p_late_charge_amount, 0), coalesce(p_late_charge_amount, 0),
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date), v_tenant_id
  ) returning id into v_payment_id;

  update renewal_cycles set status = 'paga', paid_at = coalesce(p_received_at, current_date) where id = p_cycle_id;
  perform recompute_contract_status(v_contract.id);

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (v_contract.client_id, 'pagamento_recebido', 'in_app', v_contract.id,
          'Pagamento recebido',
          'Recebemos seu pagamento de ' || fmt_brl(p_amount_received) || '. Contrato #' || v_contract.contract_number || ' quitado.', v_tenant_id);

  return v_payment_id;
end;
$$;

create or replace function renew_installment(
  p_source_type request_source,
  p_source_id uuid,
  p_interest_only_amount numeric,
  p_has_operational_fee boolean,
  p_operational_fee_amount numeric,
  p_notes text default null,
  p_late_charge_amount numeric default 0,
  p_received_at date default current_date,
  p_new_due_date date default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_contract_id uuid;
  v_contract_number integer;
  v_due_type due_type;
  v_custom_days integer;
  v_principal numeric;
  v_interest numeric;
  v_full_debt numeric;
  v_new_due_date date;
  v_cycle_number integer;
  v_new_cycle_id uuid;
  v_payment_id uuid;
  v_client_id uuid;
  v_step interval;
  v_status installment_status;
  v_installments_count integer;
  v_allows_renewal boolean;
  v_tenant_id uuid;
begin
  if not is_gerente() then
    raise exception 'FORBIDDEN';
  end if;

  perform assert_received_at_valid(p_received_at);

  v_tenant_id := current_tenant_id();

  if p_interest_only_amount < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if coalesce(p_late_charge_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;

  if p_source_type = 'installment' then
    select i.contract_id,
           greatest(0, i.principal_share - i.principal_paid_partial),
           greatest(0, i.interest_share - i.interest_paid_partial),
           i.status
      into v_contract_id, v_principal, v_interest, v_status
      from installments i where i.id = p_source_id and i.tenant_id = v_tenant_id for update;
  else
    select rc.contract_id, rc.status, rc.full_debt_amount
      into v_contract_id, v_status, v_full_debt
      from renewal_cycles rc where rc.id = p_source_id and rc.tenant_id = v_tenant_id for update;
    v_principal := 0;
    v_interest := v_full_debt;
  end if;

  if v_contract_id is null then
    raise exception 'NOT_FOUND';
  end if;

  -- defesa contra corrida: duplo-clique ou dois gerentes renovando a mesma
  -- parcela/ciclo quase simultaneamente.
  if v_status not in ('pendente', 'atrasada') then
    raise exception 'INSTALLMENT_NOT_PAYABLE';
  end if;

  select lc.due_type, lc.client_id, lc.custom_interval_days, lc.installments_count, lc.allows_renewal, lc.contract_number
    into v_due_type, v_client_id, v_custom_days, v_installments_count, v_allows_renewal, v_contract_number
    from loan_contracts lc where lc.id = v_contract_id for update;

  -- Renovação só é permitida em contratos de parcela única com o flag
  -- habilitado.
  if v_installments_count <> 1 or not coalesce(v_allows_renewal, false) then
    raise exception 'RENEWAL_NOT_ALLOWED';
  end if;

  v_full_debt := coalesce(v_full_debt, v_principal + v_interest);

  v_step := case v_due_type
    when 'mensal' then interval '1 month'
    when 'quinzenal' then interval '15 days'
    when 'semanal' then interval '7 days'
    when 'personalizado' then (coalesce(v_custom_days, 30) || ' days')::interval
  end;
  v_new_due_date := coalesce(p_new_due_date, coalesce(p_received_at, current_date) + v_step);

  -- Auditoria 2026-08-23: renovar pra uma data já vencida criava um ciclo que
  -- nascia atrasado, sem nenhum aviso.
  if v_new_due_date <= coalesce(p_received_at, current_date) then
    raise exception 'NEW_DUE_DATE_NOT_FUTURE';
  end if;

  select coalesce(max(cycle_number), 0) + 1 into v_cycle_number
    from renewal_cycles where contract_id = v_contract_id;

  insert into renewal_cycles (
    contract_id, cycle_number, origin_installment_id, previous_cycle_id,
    interest_only_amount, full_debt_amount, new_due_date, created_by, tenant_id
  ) values (
    v_contract_id, v_cycle_number,
    case when p_source_type = 'installment' then p_source_id else null end,
    case when p_source_type = 'renewal_cycle' then p_source_id else null end,
    p_interest_only_amount, v_full_debt, v_new_due_date, auth.uid(), v_tenant_id
  ) returning id into v_new_cycle_id;

  if p_source_type = 'installment' then
    update installments set status = 'renovada', renewed_into_cycle_id = v_new_cycle_id where id = p_source_id;
  else
    update renewal_cycles set status = 'renovada' where id = p_source_id;
  end if;

  insert into payments (
    contract_id, renewal_cycle_id, payment_kind, amount_received,
    principal_component, interest_component, late_charge_amount,
    has_operational_fee, operational_fee_amount, received_by, notes, received_at, tenant_id
  ) values (
    v_contract_id, v_new_cycle_id, 'renovacao_juros', p_interest_only_amount + coalesce(p_late_charge_amount, 0),
    0, p_interest_only_amount + coalesce(p_late_charge_amount, 0), coalesce(p_late_charge_amount, 0),
    p_has_operational_fee, coalesce(p_operational_fee_amount, 0), auth.uid(), p_notes,
    coalesce(p_received_at, current_date), v_tenant_id
  ) returning id into v_payment_id;

  update loan_contracts set status = 'em_aberto', updated_at = now()
    where id = v_contract_id and status in ('em_aberto', 'atrasado', 'perda');

  insert into notifications_log (recipient_id, event, channel, related_contract_id, title, body, tenant_id)
  values (v_client_id, 'renovacao_registrada', 'in_app', v_contract_id,
          'Renovação registrada',
          'Sua dívida do contrato #' || v_contract_number || ' foi renovada. Novo vencimento: ' ||
          to_char(v_new_due_date, 'DD/MM/YYYY') || '.', v_tenant_id);

  return v_new_cycle_id;
end;
$$;


-- ============================================================================
-- 9. FIN-01 — agregação no banco, não no navegador
--
-- O PostgREST corta a resposta em 1.000 linhas por padrão. Dashboard e
-- Relatórios buscavam as linhas cruas e somavam no JavaScript — passando de
-- 1.000 pagamentos no período, o total simplesmente parava de crescer, sem
-- erro e sem aviso. Um relatório que trava em zero levanta suspeita; um que
-- mostra R$ 180 mil quando o correto é R$ 240 mil, não.
--
-- Estas RPCs somam no Postgres (sem teto de linhas) e devolvem um jsonb
-- pequeno. Todas filtram por current_tenant_id() e exigem gerente.
-- ============================================================================

-- Totais financeiros de um período. `p_start` inclusivo, `p_end` EXCLUSIVO
-- (mesma convenção de periodoRange() em gerente-relatorios.js).
create or replace function financial_totals(p_start date, p_end date)
returns jsonb
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_result jsonb;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();

  select jsonb_build_object(
    'recebido', coalesce((
      select sum(amount_received) from payments
      where tenant_id = v_tenant and received_at >= p_start and received_at < p_end
    ), 0),
    'lucro_bruto', coalesce((
      select sum(interest_component) from payments
      where tenant_id = v_tenant and received_at >= p_start and received_at < p_end
    ), 0),
    -- Capital que VOLTOU pro caixa no período (parte principal dos
    -- recebimentos) — é o "Retornado" da tabela de Lucro Analítico.
    'retorno', coalesce((
      select sum(principal_component) from payments
      where tenant_id = v_tenant and received_at >= p_start and received_at < p_end
    ), 0),
    -- Total desembolsado: capital emprestado + taxa de saída (coluna gerada
    -- total_disbursed_amount). É o "Aporte" do Fluxo de Caixa.
    'aporte', coalesce((
      select sum(total_disbursed_amount) from loan_contracts
      where tenant_id = v_tenant and contract_date >= p_start and contract_date < p_end
    ), 0),
    'net_profit', coalesce((
      select sum(net_profit) from payments
      where tenant_id = v_tenant and received_at >= p_start and received_at < p_end
    ), 0),
    'taxa_entrada', coalesce((
      select sum(operational_fee_amount) from payments
      where tenant_id = v_tenant and has_operational_fee
        and received_at >= p_start and received_at < p_end
    ), 0),
    'taxa_saida', coalesce((
      select sum(operational_fee_amount) from loan_contracts
      where tenant_id = v_tenant and has_operational_fee
        and contract_date >= p_start and contract_date < p_end
    ), 0),
    'capital_emprestado', coalesce((
      select sum(principal_amount) from loan_contracts
      where tenant_id = v_tenant and contract_date >= p_start and contract_date < p_end
    ), 0),
    'contratos_novos', coalesce((
      select count(*) from loan_contracts
      where tenant_id = v_tenant and contract_date >= p_start and contract_date < p_end
    ), 0),
    'perda', coalesce((
      select sum(principal_lost) from installments
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= p_start and loss_recognized_at < p_end
    ), 0) + coalesce((
      select sum(principal_lost) from renewal_cycles
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= p_start and loss_recognized_at < p_end
    ), 0),
    'pagamentos_count', coalesce((
      select count(*) from payments
      where tenant_id = v_tenant and received_at >= p_start and received_at < p_end
    ), 0)
  ) into v_result;

  return v_result;
end;
$$;

-- Série temporal agregada (por dia ou por mês) — alimenta os gráficos sem
-- trazer uma linha por pagamento pro navegador.
create or replace function financial_series(p_start date, p_end date, p_bucket text)
returns table (
  bucket text,
  recebido numeric,
  lucro numeric,
  retorno numeric,
  juros numeric,
  taxa_entrada numeric,
  taxa_saida numeric,
  aporte numeric,
  perda numeric
)
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_fmt text;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();
  v_fmt := case when p_bucket = 'mes' then 'YYYY-MM' else 'YYYY-MM-DD' end;

  -- União de todas as fontes num só conjunto de colunas e um GROUP BY
  -- final. Um FULL OUTER JOIN em três lados exigiria coalesce aninhado na
  -- condição de junção e erra silenciosamente quando um período existe só
  -- na terceira fonte — a união não tem esse problema.
  return query
  select x.b::text,
         sum(x.recebido)::numeric,
         sum(x.lucro)::numeric,
         sum(x.retorno)::numeric,
         sum(x.juros)::numeric,
         sum(x.taxa_entrada)::numeric,
         sum(x.taxa_saida)::numeric,
         sum(x.aporte)::numeric,
         sum(x.perda)::numeric
  from (
    -- Pagamentos: entrada de caixa, lucro líquido, capital retornado, juros
    -- brutos e a taxa de ENTRADA efetivamente cobrada.
    select to_char(received_at, v_fmt) as b,
           amount_received as recebido,
           net_profit as lucro,
           principal_component as retorno,
           interest_component as juros,
           case when has_operational_fee then operational_fee_amount else 0 end as taxa_entrada,
           0::numeric as taxa_saida,
           0::numeric as aporte,
           0::numeric as perda
    from payments
    where tenant_id = v_tenant and received_at >= p_start and received_at < p_end

    -- Contratos: saída de caixa (aporte) e a taxa de SAÍDA.
    union all
    select to_char(contract_date, v_fmt), 0, 0, 0, 0, 0,
           case when has_operational_fee then operational_fee_amount else 0 end,
           total_disbursed_amount, 0
    from loan_contracts
    where tenant_id = v_tenant and contract_date >= p_start and contract_date < p_end

    -- Perdas reconhecidas no período (parcelas e ciclos).
    union all
    select to_char(loss_recognized_at, v_fmt), 0, 0, 0, 0, 0, 0, 0, principal_lost
    from installments
    where tenant_id = v_tenant and status = 'perda'
      and loss_recognized_at >= p_start and loss_recognized_at < p_end

    union all
    select to_char(loss_recognized_at, v_fmt), 0, 0, 0, 0, 0, 0, 0, principal_lost
    from renewal_cycles
    where tenant_id = v_tenant and status = 'perda'
      and loss_recognized_at >= p_start and loss_recognized_at < p_end
  ) x
  group by x.b
  order by 1;
end;
$$;

-- Números do topo do Dashboard, todos somados no banco.
create or replace function dashboard_totals()
returns jsonb
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
  v_today date := current_date;
  v_month_start date := date_trunc('month', current_date)::date;
  v_prev_start date := date_trunc('month', current_date - interval '1 month')::date;
  v_prev_end date;
  v_result jsonb;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();
  -- Mesmo período comparável do mês anterior (dia 1 até o mesmo dia-do-mês).
  v_prev_end := least(
    v_prev_start + (v_today - v_month_start),
    (date_trunc('month', v_prev_start) + interval '1 month')::date - 1
  );

  -- Todas as janelas são semiabertas ([início, fim+1)) porque received_at e
  -- loss_recognized_at são timestamptz: comparar `<= data` só alcançaria a
  -- meia-noite exata do último dia e perderia qualquer registro gravado com
  -- hora real dentro dele.
  select jsonb_build_object(
    'recebido_hoje', coalesce((select sum(amount_received) from payments
      where tenant_id = v_tenant and received_at >= v_today and received_at < v_today + 1), 0),
    'recebido_mes', coalesce((select sum(amount_received) from payments
      where tenant_id = v_tenant and received_at >= v_month_start and received_at < v_today + 1), 0),
    'lucro_mes', coalesce((select sum(net_profit) from payments
      where tenant_id = v_tenant and received_at >= v_month_start and received_at < v_today + 1), 0),
    'lucro_prev', coalesce((select sum(net_profit) from payments
      where tenant_id = v_tenant and received_at >= v_prev_start and received_at < v_prev_end + 1), 0),
    'taxa_entrada_mes', coalesce((select sum(operational_fee_amount) from payments
      where tenant_id = v_tenant and has_operational_fee
        and received_at >= v_month_start and received_at < v_today + 1), 0),
    'taxa_saida_mes', coalesce((select sum(operational_fee_amount) from loan_contracts
      where tenant_id = v_tenant and has_operational_fee
        and contract_date >= v_month_start and contract_date <= v_today), 0),
    'taxa_saida_prev', coalesce((select sum(operational_fee_amount) from loan_contracts
      where tenant_id = v_tenant and has_operational_fee
        and contract_date >= v_prev_start and contract_date <= v_prev_end), 0),
    'perda_mes', coalesce((select sum(principal_lost) from installments
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= v_month_start and loss_recognized_at < v_today + 1), 0)
      + coalesce((select sum(principal_lost) from renewal_cycles
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= v_month_start and loss_recognized_at < v_today + 1), 0),
    'perda_prev', coalesce((select sum(principal_lost) from installments
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= v_prev_start and loss_recognized_at < v_prev_end + 1), 0)
      + coalesce((select sum(principal_lost) from renewal_cycles
      where tenant_id = v_tenant and status = 'perda'
        and loss_recognized_at >= v_prev_start and loss_recognized_at < v_prev_end + 1), 0),
    'contratos_em_aberto', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and status = 'em_aberto'), 0),
    'contratos_atrasado', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and status = 'atrasado'), 0),
    'contratos_quitado', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and status = 'quitado'), 0),
    'contratos_perda', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and status = 'perda'), 0),
    'contratos_novos_mes', coalesce((select count(*) from loan_contracts
      where tenant_id = v_tenant and contract_date >= v_month_start and contract_date <= v_today), 0),
    'capital_na_rua', coalesce((select sum(principal_amount) from loan_contracts
      where tenant_id = v_tenant and status in ('em_aberto', 'atrasado')), 0),
    'a_receber_mes', coalesce((select sum(amount_due - principal_paid_partial - interest_paid_partial)
      from installments
      where tenant_id = v_tenant and status in ('pendente', 'atrasada')
        and due_date >= v_month_start and due_date < v_month_start + interval '1 month'), 0)
      + coalesce((select sum(full_debt_amount) from renewal_cycles
      where tenant_id = v_tenant and status in ('pendente', 'atrasada')
        and new_due_date >= v_month_start and new_due_date < v_month_start + interval '1 month'), 0),
    'vencidos_count', coalesce((select count(*) from installments
      where tenant_id = v_tenant and status in ('pendente', 'atrasada') and due_date <= v_today), 0)
      + coalesce((select count(*) from renewal_cycles
      where tenant_id = v_tenant and status in ('pendente', 'atrasada') and new_due_date <= v_today), 0),
    'solicitacoes_pendentes', coalesce((select count(*) from loan_requests
      where tenant_id = v_tenant and status = 'pendente'), 0)
  ) into v_result;

  return v_result;
end;
$$;

-- Série dos últimos N dias de recebimento (gráfico de tendência do Dashboard).
create or replace function dashboard_trend(p_days integer default 30)
returns table (dia date, recebido numeric)
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_tenant uuid;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;
  v_tenant := current_tenant_id();
  return query
  select d::date,
         coalesce((select sum(p.amount_received) from payments p
                   where p.tenant_id = v_tenant
                     and p.received_at >= d::date
                     and p.received_at < d::date + 1), 0)::numeric
  from generate_series(current_date - (greatest(p_days, 1) - 1), current_date, interval '1 day') d
  order by 1;
end;
$$;


-- ============================================================================
-- 10. OPS-01b / OPS-02 — registro de execução das rotinas + tela "Saúde"
--
-- A rotina diária falhava em silêncio: api/cron-daily-check.js chamava a RPC
-- com `await` solto, sem conferir o resultado. Agora cada tarefa do cron
-- registra o próprio desfecho aqui, e a tela "Saúde da Plataforma" (nova, modo
-- Plataforma SaaS) mostra quando cada uma rodou pela última vez e o que
-- aconteceu. O silêncio vira sinal.
-- ============================================================================

create table if not exists cron_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null,
  status text not null check (status in ('ok', 'falhou', 'parcial')),
  message text,
  duration_ms integer,
  processed integer,
  remaining integer,
  ran_at timestamptz not null default now()
);
create index if not exists cron_runs_job_ran_at_idx on cron_runs(job, ran_at desc);

alter table cron_runs enable row level security;
drop policy if exists "cron_runs_select_owner" on cron_runs;
create policy "cron_runs_select_owner" on cron_runs for select
  using (is_platform_owner());
-- sem policy de insert — gravação só via service_role (o cron), que bypassa RLS.

-- Poda: mantém as 200 execuções mais recentes de cada tarefa.
create or replace function record_cron_run(
  p_job text,
  p_status text,
  p_message text default null,
  p_duration_ms integer default null,
  p_processed integer default null,
  p_remaining integer default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN';
  end if;

  insert into cron_runs (job, status, message, duration_ms, processed, remaining)
  values (p_job, p_status, substring(coalesce(p_message, '') from 1 for 400), p_duration_ms, p_processed, p_remaining);

  delete from cron_runs where job = p_job and id in (
    select id from cron_runs where job = p_job order by ran_at desc offset 200
  );
end;
$$;

-- Tudo o que a tela "Saúde da Plataforma" precisa, numa chamada só.
create or replace function get_platform_health()
returns jsonb
language plpgsql stable
security definer set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not is_platform_owner() then raise exception 'FORBIDDEN'; end if;

  select jsonb_build_object(
    -- Última execução de cada tarefa + quantas falhas seguidas ela acumula.
    'jobs', coalesce((
      select jsonb_agg(j order by j->>'job')
      from (
        select jsonb_build_object(
          'job', last.job,
          'status', last.status,
          'message', last.message,
          'ran_at', last.ran_at,
          'duration_ms', last.duration_ms,
          'processed', last.processed,
          'remaining', last.remaining,
          -- Falhas seguidas = execuções com status 'falhou' desde a última
          -- que deu certo. 'parcial' não zera o contador nem conta como
          -- falha (a tarefa rodou, só não terminou o lote).
          'consecutive_failures', (
            select count(*) from cron_runs c2
            where c2.job = last.job
              and c2.status = 'falhou'
              and c2.ran_at > coalesce(
                (select max(c3.ran_at) from cron_runs c3
                 where c3.job = last.job and c3.status = 'ok'),
                '-infinity'::timestamptz
              )
          )
        ) as j
        from (
          select distinct on (job) job, status, message, ran_at, duration_ms, processed, remaining
          from cron_runs order by job, ran_at desc
        ) last
      ) agg
    ), '[]'::jsonb),

    'tenants_ativos', (select count(*) from tenants where active),
    'tenants_total', (select count(*) from tenants),

    'avisos_hoje', (select count(*) from notifications_log
      where channel = 'in_app' and sent_at >= current_date
        and event in ('vence_amanha', 'vence_hoje', 'atrasada')),
    'avisos_media_7d', (select round(count(*)::numeric / 7, 0) from notifications_log
      where channel = 'in_app' and sent_at >= current_date - 7 and sent_at < current_date
        and event in ('vence_amanha', 'vence_hoje', 'atrasada')),

    'emails_falhos_7d', (select count(*) from notifications_log
      where channel = 'email' and delivery_status = 'failed' and sent_at >= current_date - 7),

    'push_total', (select count(*) from push_subscriptions),

    -- Verificações de isolamento: nenhuma linha deveria ter empresa diferente
    -- da entidade de que depende. Tudo zero = isolamento íntegro.
    'orfaos', jsonb_build_object(
      'contratos_cliente_outra_empresa', (
        select count(*) from loan_contracts lc
        join clients c on c.profile_id = lc.client_id
        where c.tenant_id <> lc.tenant_id),
      'parcelas_contrato_outra_empresa', (
        select count(*) from installments i
        join loan_contracts lc on lc.id = i.contract_id
        where lc.tenant_id <> i.tenant_id),
      'ciclos_contrato_outra_empresa', (
        select count(*) from renewal_cycles rc
        join loan_contracts lc on lc.id = rc.contract_id
        where lc.tenant_id <> rc.tenant_id),
      'pagamentos_contrato_outra_empresa', (
        select count(*) from payments p
        join loan_contracts lc on lc.id = p.contract_id
        where lc.tenant_id <> p.tenant_id),
      'notificacoes_fora_da_empresa', (
        select count(*) from notifications_log n
        join profiles pr on pr.id = n.recipient_id
        where n.tenant_id is not null and pr.tenant_id <> n.tenant_id)
    ),

    -- Empresas sem linha de configuração: quebra Configurações e faz o
    -- limiar de perda cair no default. Deve ser sempre zero.
    'tenants_sem_settings', (
      select count(*) from tenants t
      where not exists (select 1 from system_settings s where s.tenant_id = t.id))
  ) into v_result;

  return v_result;
end;
$$;

-- Fila do dia pro cron: devolve tudo o que precisa ser notificado, já
-- deduplicado contra o que saiu hoje e já com e-mail do destinatário — o
-- serverless deixa de fazer 5 idas ao banco POR PARCELA (OPS-02).
create or replace function pending_due_notifications(p_limit integer default 500)
returns table (
  kind text,
  ref_id uuid,
  contract_id uuid,
  contract_number integer,
  client_id uuid,
  client_email text,
  event text,
  amount numeric,
  due_date date
)
language plpgsql stable
security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN';
  end if;

  return query
  with base as (
    select 'installment'::text as kind, i.id as ref_id, i.contract_id,
           lc.contract_number, lc.client_id, p.email as client_email,
           case
             when i.due_date < current_date then 'atrasada'
             when i.due_date = current_date then 'vence_hoje'
             else 'vence_amanha'
           end as event,
           (i.amount_due - i.principal_paid_partial - i.interest_paid_partial) as amount,
           i.due_date
    from installments i
    join loan_contracts lc on lc.id = i.contract_id
    join profiles p on p.id = lc.client_id
    join tenants t on t.id = i.tenant_id and t.active
    where i.status in ('pendente', 'atrasada')
      and i.due_date <= current_date + 1

    union all

    select 'cycle'::text, rc.id, rc.contract_id,
           lc.contract_number, lc.client_id, p.email,
           case
             when rc.new_due_date < current_date then 'atrasada'
             when rc.new_due_date = current_date then 'vence_hoje'
             else 'vence_amanha'
           end,
           rc.full_debt_amount,
           rc.new_due_date
    from renewal_cycles rc
    join loan_contracts lc on lc.id = rc.contract_id
    join profiles p on p.id = lc.client_id
    join tenants t on t.id = rc.tenant_id and t.active
    where rc.status in ('pendente', 'atrasada')
      and rc.new_due_date <= current_date + 1
  )
  select b.kind, b.ref_id, b.contract_id, b.contract_number, b.client_id,
         b.client_email, b.event, b.amount, b.due_date
  from base b
  where not exists (
    select 1 from notifications_log n
    where n.recipient_id = b.client_id
      and n.event::text = b.event
      and n.sent_at >= current_date
      and (
        (b.kind = 'installment' and n.related_installment_id = b.ref_id)
        or (b.kind = 'cycle' and n.related_contract_id = b.contract_id and n.related_installment_id is null)
      )
  )
  order by b.due_date asc
  limit greatest(p_limit, 1);
end;
$$;

-- Quantos ainda faltam depois do lote atual — alimenta o "N na fila" da tela
-- Saúde sem precisar puxar as linhas.
create or replace function pending_due_notifications_count()
returns integer
language plpgsql stable
security definer set search_path = public
as $$
declare v_n integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN';
  end if;
  select count(*) into v_n from pending_due_notifications(1000000);
  return v_n;
end;
$$;


-- ============================================================================
-- 11. SEC-05 — freio na consulta pública de CPF → e-mail
--
-- email_for_cpf() é security definer, não exige sessão, não filtra por empresa
-- e não tinha limite de chamadas. Ela PRECISA ser pública (é o que faz o login
-- por CPF funcionar antes de existir sessão), mas do jeito que estava era um
-- oráculo aberto: dado um CPF, devolvia o e-mail da pessoa — para a plataforma
-- inteira. Confirma se alguém é cliente de ALGUMA financeira do SIGES e
-- entrega o contato. Dado o volume de bases de CPF em circulação no Brasil,
-- é enumeração em massa viável, e tratamento de dado pessoal sem base legal
-- sob a LGPD.
--
-- Não dá pra fechar a função sem quebrar o login. O que dá pra fazer, e é o
-- que este bloco faz: pôr um teto por ORIGEM. Um fluxo de login legítimo faz
-- meia dúzia de consultas por janela; um varredor faz milhares. Acima do teto
-- a função passa a responder "não encontrei" — indistinguível de um CPF que
-- realmente não existe, então o varredor não aprende nada com o bloqueio.
-- ============================================================================

create table if not exists cpf_lookup_attempts (
  id bigserial primary key,
  origin text,
  attempted_at timestamptz not null default now()
);
create index if not exists cpf_lookup_attempts_idx on cpf_lookup_attempts(origin, attempted_at desc);

alter table cpf_lookup_attempts enable row level security;
-- Sem policy nenhuma: ninguém lê nem escreve direto. Só a função abaixo
-- (security definer) toca nesta tabela.

create or replace function email_for_cpf(p_cpf text)
returns text
language plpgsql
volatile
security definer set search_path = public
as $$
declare
  v_origin text;
  v_recent int;
  v_email text;
begin
  -- Chave da janela: o IP de origem quando o proxy do Supabase informa, senão
  -- um balde único compartilhado (degrada para limite global — pior para a
  -- experiência, melhor do que não limitar nada).
  begin
    v_origin := coalesce(
      split_part(current_setting('request.headers', true)::json->>'x-forwarded-for', ',', 1),
      'desconhecido'
    );
  exception when others then
    v_origin := 'desconhecido';
  end;
  if v_origin is null or v_origin = '' then v_origin := 'desconhecido'; end if;

  select count(*) into v_recent
  from cpf_lookup_attempts
  where origin = v_origin and attempted_at > now() - interval '10 minutes';

  insert into cpf_lookup_attempts (origin) values (v_origin);

  -- Poda oportunista: mantém a tabela pequena sem depender de cron.
  if random() < 0.02 then
    delete from cpf_lookup_attempts where attempted_at < now() - interval '1 hour';
  end if;

  -- 30 consultas em 10 minutos cobre com folga alguém errando a senha várias
  -- vezes, trocando de conta, ou uma família compartilhando a mesma rede.
  if v_recent >= 30 then
    return null;
  end if;

  select email into v_email from profiles where cpf = p_cpf limit 1;
  return v_email;
end;
$$;


-- ============================================================================
-- FIM — migration_048.sql
-- ============================================================================

-- ============================================================================
-- migration_050.sql — Adiar parcela não tirava o "Atrasada"
--
-- Bug real reportado pelo usuário (2026-09-01): parcela vencida há 2 dias,
-- reagendada para daqui a 5 dias, continuava exibindo a pílula "Atrasada" — e
-- o contrato inteiro continuava "Atrasado".
--
-- Três defeitos encadeados:
--
--   1. update_installment_schedule() gravava due_date, valores e
--      principal_lost, mas NUNCA tocava em `status`. Uma parcela que estava
--      'atrasada' seguia 'atrasada' com vencimento no futuro.
--
--   2. A função também nunca chamava recompute_contract_status(), então
--      loan_contracts.status continuava 'atrasado' mesmo sem nenhuma parcela
--      de fato vencida.
--
--   3. refresh_overdue_status() (o cron diário) só faz pendente -> atrasada.
--      Não existe a transição inversa. Ou seja: o cron NUNCA consertaria a
--      linha sozinho — ela ficaria 'atrasada' até ser paga, contaminando
--      relatórios e a régua de cobrança.
--
-- O caso equivalente do CICLO de renovação já estava correto — foi tratado
-- em migration_049 (update_cycle_schedule). Esta migration leva a mesma
-- regra para a parcela, adiciona a transição inversa como rede de segurança
-- no cron, e corrige as linhas que já estão erradas no banco.
-- ============================================================================


-- ============================================================================
-- 1. Corrige as linhas JÁ gravadas erradas
--
-- Roda primeiro, de propósito: quem já adiou uma parcela antes desta correção
-- tem a linha travada em 'atrasada' com vencimento futuro, e nada no sistema
-- desfaria isso. Só toca em 'atrasada' com data futura — 'paga', 'renovada',
-- 'cancelada' e 'perda' são estados terminais e não podem ser revertidos por
-- data (sair de 'perda' exige o botão "Reverter perda", que também devolve o
-- capital abatido do lucro).
-- ============================================================================

update installments
   set status = 'pendente'
 where status = 'atrasada'
   and due_date >= current_date;

update renewal_cycles
   set status = 'pendente'
 where status = 'atrasada'
   and new_due_date >= current_date;

-- Ressincroniza o status dos contratos afetados (um contrato só é 'atrasado'
-- se ainda tiver alguma parcela/ciclo de fato vencido).
--
-- A lógica abaixo é a MESMA de recompute_contract_status(), mas escrita
-- direto como UPDATE em vez de chamar a função. Motivo: aquela função exige
-- `is_gerente() or auth.role() = 'service_role'`, e no SQL Editor do Supabase
-- não existe JWT na sessão — auth.uid() e auth.role() voltam nulos, então a
-- chamada morre com FORBIDDEN e derruba a migration inteira (a primeira
-- versão desta migration fazia exatamente isso e falhou).
--
-- Se mudar a regra de status do contrato em recompute_contract_status(),
-- lembre que ela está duplicada aqui — mas só para esta correção pontual de
-- dados; o caminho normal do sistema continua passando pela função.
with estado as (
  select
    lc.id,
    exists (select 1 from installments i   where i.contract_id  = lc.id and i.status  = 'atrasada')
      or exists (select 1 from renewal_cycles rc where rc.contract_id = lc.id and rc.status = 'atrasada') as tem_atrasado,
    exists (select 1 from installments i   where i.contract_id  = lc.id and i.status  in ('pendente', 'atrasada'))
      or exists (select 1 from renewal_cycles rc where rc.contract_id = lc.id and rc.status in ('pendente', 'atrasada')) as tem_aberto,
    exists (select 1 from installments i   where i.contract_id  = lc.id and i.status  = 'perda')
      or exists (select 1 from renewal_cycles rc where rc.contract_id = lc.id and rc.status = 'perda') as tem_perda
  from loan_contracts lc
  where lc.status in ('em_aberto', 'atrasado')
)
update loan_contracts alvo
   set status = novo.st, updated_at = now()
  from (
    select id,
           (case
              when tem_aberto then (case when tem_atrasado then 'atrasado' else 'em_aberto' end)
              else (case when tem_perda then 'perda' else 'quitado' end)
            end)::contract_status as st
      from estado
  ) novo
 where alvo.id = novo.id
   and alvo.status <> novo.st;


-- ============================================================================
-- 2. update_installment_schedule() — reagendar volta a sair do atraso
--
-- Espelha exatamente o que update_cycle_schedule() (migration_049) já fazia
-- do lado do ciclo. Mantém todo o resto da função intacto.
-- ============================================================================

create or replace function update_installment_schedule(
  p_installment_id uuid,
  p_due_date date,
  p_principal_share numeric,
  p_interest_share numeric
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_installment installments%rowtype;
  v_installments_count integer;
  v_principal_amount numeric;
  v_principal_sum numeric;
begin
  if not is_gerente() then raise exception 'FORBIDDEN'; end if;

  -- Fase 1c: sem o filtro de tenant_id, um gerente editava/reagendava
  -- parcela de qualquer tenant informando o id direto.
  select * into v_installment from installments where id = p_installment_id and tenant_id = current_tenant_id();
  if v_installment.id is null then raise exception 'NOT_FOUND'; end if;

  -- Não deixa o novo valor ficar abaixo do que já foi pago (parcial ou
  -- integralmente) — sem essa checagem, o saldo restante (amount_due -
  -- paid_partial) ficava negativo, e "Pago parcial: resta R$-X" aparecia
  -- nas telas do cliente.
  if p_principal_share < v_installment.principal_paid_partial
    or p_interest_share < v_installment.interest_paid_partial
  then
    raise exception 'AMOUNT_BELOW_ALREADY_PAID';
  end if;

  update installments set
    due_date = p_due_date,
    principal_share = p_principal_share,
    interest_share = p_interest_share,
    -- Se a parcela já foi reconhecida como perda, o valor perdido precisa
    -- acompanhar a correção do capital — senão uma edição posterior (ex:
    -- corrigir um valor digitado errado) deixaria o abate do lucro
    -- registrado num mês antigo desatualizado em relação ao capital real.
    principal_lost = case when status = 'perda' then greatest(0, p_principal_share - v_installment.principal_paid_partial) else principal_lost end,
    -- Bug corrigido em migration_050: reagendar uma parcela ATRASADA para uma
    -- data futura precisa tirá-la do atraso — é o objetivo da operação. Sem
    -- isto ela continuava 'atrasada' para sempre (o cron só faz pendente ->
    -- atrasada, nunca o inverso), com a pílula "Atrasada" na tela, o contrato
    -- travado em 'atrasado' e a parcela contaminando a régua de cobrança. O
    -- inverso também vale: reagendar para uma data já passada devolve o
    -- status para 'atrasada'.
    --
    -- Só mexe em pendente/atrasada. 'paga', 'renovada', 'cancelada' e 'perda'
    -- são terminais: aqui a edição é correção de registro histórico, e sair
    -- de 'perda' exige o botão "Reverter perda", que também acerta o capital
    -- abatido do lucro.
    status = case
      when status in ('pendente', 'atrasada')
        then (case when p_due_date < current_date then 'atrasada' else 'pendente' end)::installment_status
      else status
    end
  where id = p_installment_id;

  -- Reconciliação: mesmo raciocínio de create_loan_contract — a soma do
  -- capital de todas as parcelas do contrato precisa continuar batendo com
  -- o capital contratado, dentro de uma tolerância de centavos de
  -- arredondamento. Sem isso, um typo no valor da parcela (ex: 5000 em vez
  -- de 500) muda silenciosamente o capital total do contrato, distorcendo
  -- o limite de crédito consumido (client_outstanding_principal) sem
  -- nenhum aviso pro admin.
  select installments_count, principal_amount into v_installments_count, v_principal_amount
    from loan_contracts where id = v_installment.contract_id;
  select coalesce(sum(principal_share), 0) into v_principal_sum
    from installments where contract_id = v_installment.contract_id;
  if abs(v_principal_sum - v_principal_amount) > greatest(0.02 * v_installments_count, 0.02) then
    raise exception 'PRINCIPAL_MISMATCH';
  end if;

  -- O status do CONTRATO deriva do estado das parcelas/ciclos: tirar a única
  -- parcela em atraso precisa refletir em loan_contracts.status ('atrasado'
  -- -> 'em_aberto'), senão o cabeçalho do contrato continua com a pílula
  -- "Atrasado" mesmo sem nada vencido. Faltava esta chamada desde sempre.
  perform recompute_contract_status(v_installment.contract_id);
end;
$$;


-- ============================================================================
-- 3. refresh_overdue_status() — transição inversa como rede de segurança
--
-- O cron só sabia promover pendente -> atrasada. Faltava o caminho de volta,
-- e é ele que faz o sistema se autocorrigir se uma data for movida por
-- qualquer caminho que venha a existir no futuro. Mantém intacto todo o resto
-- da função (incluindo a correção de OPS-01 da migration_048, que passou a
-- ler loss_days_threshold POR EMPRESA).
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

  -- migration_050: caminho de volta. Uma parcela/ciclo marcado como atrasado
  -- cujo vencimento foi movido para o futuro deixa de estar em atraso. Sem
  -- isto o sistema só sabia piorar o status, nunca melhorar — e uma linha
  -- reagendada ficava 'atrasada' até ser paga.
  update installments set status = 'pendente'
    where status = 'atrasada' and due_date >= current_date;

  update renewal_cycles set status = 'pendente'
    where status = 'atrasada' and new_due_date >= current_date;

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
-- FIM — migration_050.sql
-- ============================================================================

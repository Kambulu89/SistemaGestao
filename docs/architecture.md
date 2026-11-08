# Arquitectura

Monólito modular: `frontend/` (Angular 22 + Tailwind CSS 4) e `backend/` (AdonisJS 7 + PostgreSQL 16). Sem Redis nem
serviços externos nesta fase.

## Módulos do backend

`backend/app/modules/<módulo>/` com `domain/` (regras puras), `application/` (casos de uso), `infrastructure/` (SQL,
serviços técnicos) e `http/` (controllers e middleware, só transporte). Cada módulo expõe a sua API pública em
`index.ts`; os outros importam **só** daí (`tests/unit/architecture.spec.ts` falha caso contrário). `app/shared/` é código
técnico partilhado e não depende de módulos.

| Módulo                                                        | Responsabilidade                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `health`                                                      | `GET /api/v1/health`                                                                      |
| `identity`                                                    | Utilizador global, sessão em cookie, CSRF, convites, recuperação, sessões                 |
| `tenancy`, `members`                                          | Tenant, contexto, `runInTenant`, memberships e convites                                   |
| `rbac`                                                        | Perfis, permissões e atribuições com âmbito                                               |
| `organization`                                                | Entidades legais, filiais, departamentos, cargos, centros de custo, dependências, árvores |
| `settings`                                                    | Perfil e configurações da empresa, câmbios, séries, calendários, contas bancárias         |
| `subscription`, `platform`                                    | Funcionalidades, planos, subscrições, limites; administração da plataforma                |
| `audit`, `approvals`, `attachments`, `notifications`, `tasks` | Auditoria, aprovações e delegações, anexos, notificações, centro de tarefas               |
| `dashboard`                                                   | Painel e pesquisa global                                                                  |
| `preferences`                                                 | Preferências de interface do membro (favoritos, disposição do painel)                     |
| `hr`                                                          | Colaboradores, recrutamento e onboarding; âmbitos de RH e dados pessoais por campo        |

## Multi-tenancy

- **Tenant** é a fronteira de isolamento. Tabelas globais enumeradas em `PLATFORM_TABLES`
  (`tenants`, `users`, `auth_sessions`, `rate_limit_counters`); todas as outras têm `tenant_id`.
- Tabelas de tenant criam-se com `createTenantTable` (`database/support/tables.ts`): UUID, `tenant_id`, `version`,
  auditoria, chave `(tenant_id, id)` para FKs compostas (`tenantForeignKey`) e **RLS `ENABLE` + `FORCE`** com política
  sobre `app_current_tenant_id()`. `tests/functional/schema_conformance.spec.ts` falha para qualquer tabela fora do padrão.
- **Duas contas PostgreSQL**: `app_owner` (dona do esquema, migrações, `BYPASSRLS` para manutenção) e `app` (runtime: só
  DML, sem superuser nem `BYPASSRLS`). A aplicação usa sempre `app`.
- **Contexto de tenant**: o middleware `tenant` lê `X-Tenant-Id` (só um selector), confirma a membership **activa** do
  utilizador autenticado e o estado do tenant, e cria o `TenantContext`. O acesso a dados de tenant passa por
  `runInTenant(context, fn)`, que abre uma transacção e define `app.tenant_id` com `set_config(..., true)` (local à
  transacção, nunca fica no pool). Sem contexto: erro, nunca «tenant por omissão».
- A lista das empresas de um utilizador (antes de escolher uma) usa a função `app_user_tenants(user_id)` (SECURITY DEFINER),
  chamada só com o utilizador autenticado.

## Autenticação

- Sessão opaca: token aleatório de 256 bits no cookie HttpOnly `sg_session` (`__Host-` em produção, SameSite=Lax); a base
  guarda só o SHA-256. Inactividade 8 h, máximo 7 dias, revogação no logout.
- CSRF de dupla submissão: cookie `XSRF-TOKEN` (HMAC da sessão com a `APP_KEY`), enviado pelo Angular em `X-XSRF-TOKEN`;
  obrigatório em todos os métodos que alteram dados atrás do middleware `auth`.
- Login: mensagens genéricas, tempo constante quando o email não existe, limite de tentativas por email (10/15 min) e por
  IP (100/15 min) em PostgreSQL (`rate_limit_counters`). Não há registo público: as contas vêm de convites (por fazer) ou da
  administração.

## Respostas e erros

Sucesso `{ data, meta: { requestId } }`; erro `{ error: { code, message, details[], requestId } }` (400, 401, 403, 404,
409, 422, 429, 5xx genérico). Nunca stack, SQL nem segredos. O registo de SQL está desligado.

## Autorização (RBAC)

- Permissões definidas em `app/modules/rbac/domain/permissions.ts` e sincronizadas para `permissions` com
  `node ace catalog:sync` (também actualiza o perfil de sistema `tenant_admin` de todas as empresas).
- Perfis (`roles`) por empresa; atribuições (`membership_roles`) com âmbito `TENANT`, `OWN`, `LEGAL_ENTITY`, `BRANCH`
  ou `DEPARTMENT` (este inclui os subdepartamentos). O alvo fica numa coluna própria com FK composta e um CHECK exige a
  coluna certa para cada âmbito. `permissionScope(scope, permissão)` devolve onde a permissão vale; as rotas de gestão
  continuam a exigir âmbito `TENANT`. Equipas: quando existir o cadastro de equipas.
- Rotas protegidas com `middleware.can({ permission })`; negar por omissão. Só contam membership **activa** e perfis
  **activos**.
- Anti-escalada: um perfil só leva permissões que o actor tem com âmbito de empresa; só se atribui um perfil cujas
  permissões o actor tem; ninguém altera os próprios perfis nem o próprio estado; o último administrador activo não é
  suspenso nem perde o perfil (verificado sob `FOR UPDATE`).

## Convites e email

- Convidar cria (ou reutiliza) a conta global e uma membership `INVITED`; o token de uso único (validade configurável
  por empresa, 1–30 dias, 7 por omissão) só é emitido depois de gravada a membership. Reenviar invalida os tokens
  anteriores e emite outro; revogar invalida-os e põe a membership `REVOKED`; o detalhe mostra a validade. Aceitar consome o token e activa a membership na **mesma** transacção.
- Sem fornecedor de email escolhido: `MAIL_DRIVER=none` não envia e a API responde `delivery: NOT_CONFIGURED` (nunca finge
  envio); `dev-memory` guarda a mensagem em memória para testes/desenvolvimento (proibido em produção).

## Estrutura organizacional

- `legal_entities` (código e NIF+país únicos, moeda funcional), `branches` (tipo, entidade legal), `departments` (árvore,
  entidade legal, filial opcional), `positions` (família, categoria, nível 1–20, departamento opcional) e `cost_centers`
  (árvore, código único por entidade legal, departamento opcional). Todos com estado `ACTIVE`/`INACTIVE` e vigência
  `valid_from`/`valid_to` coerente; o código e a entidade legal não mudam depois de criados.
- Filial, pai, departamento e centro de custo referenciados têm de pertencer à **mesma entidade legal**.
- Ciclos impedidos com CTE recursiva sob um bloqueio por empresa e árvore (`pg_advisory_xact_lock`), pedido **antes** de
  bloquear a linha (evita o deadlock com a FK do pai; coberto por teste de concorrência).
- API única `/api/v1/organization/:kind` (`legal-entities`, `branches`, `departments`, `positions`, `cost-centers`) com
  `organization.read` / `organization.manage`; o domínio só aceita os campos declarados (sem mass assignment).
- Prompt 05: regime fiscal, IVA, início do exercício, contactos, morada (província, município, comuna, bairro) e
  representante nas entidades legais; contactos, morada, responsável (membership activa) e centro de custo (da mesma
  entidade legal) nas filiais; responsável e centro de custo nos departamentos; responsável nos centros de custo;
  função, requisitos e responsabilidades nos cargos. Inactivar com dependentes activos é recusado (409
  `HAS_ACTIVE_DEPENDENTS`, com a contagem por tipo); `GET …/:id/dependents` e `GET …/tree` (organograma de
  departamentos e centros de custo) alimentam a interface.
- Repositório genérico de tabelas de tenant em `app/shared/db/tenant_crud.ts` (listagem paginada, filtros por igualdade,
  pesquisa, versão, conflitos de unicidade → 409).

## Subscrições e entitlements

- Tabelas globais (plano de controlo, fora do RLS e só alteradas pela administração da plataforma): `features`
  (catálogo em código, `BOOLEAN` ou `LIMIT`), `plans` (`DRAFT` → `ACTIVE` → `RETIRED`; um plano publicado não muda, por
  trigger), `plan_features`, `subscriptions` (uma corrente por tenant, índice único parcial), `subscription_events`
  (só acrescentar, por trigger) e `tenant_entitlement_overrides` (excepção por funcionalidade, com motivo e validade).
- Estados: `TRIALING` → `ACTIVE` → `SUSPENDED` ↔ `ACTIVE`, qualquer um → `CANCELLED`. `EXPIRED` é derivado (período
  experimental ou período terminado), não gravado. Só `TRIALING` e `ACTIVE` dão funcionalidades.
- Entitlement ≠ autorização: `middleware.entitled({ feature })` responde 403 `NOT_ENTITLED` quando a empresa não
  tem a funcionalidade; a permissão RBAC continua a ser exigida à parte (`can`). Limites com `assertWithinLimit`, que
  conta sob `pg_advisory_xact_lock` por tenant e funcionalidade (409 `LIMIT_REACHED`); hoje `members.max` (convites) e
  `legal_entities.max`.
- Sem plano comercial semeado: preços, faturação e pagamentos ficam para quando houver decisão comercial (D-008).

## Auditoria

- `audit_events` por tenant (RLS), escrito com `audit(scope, { action, entityType, entityId, changes, metadata })` na
  **mesma** transacção da operação: se a operação falha, o evento não fica; se o evento falha, a operação também não.
- Só de acrescentar: a conta de runtime não tem `UPDATE`/`DELETE`/`TRUNCATE` e um trigger recusa alterações a qualquer
  conta. O actor vem do contexto do servidor; `changes` guarda só os campos alterados; chaves com aspecto de segredo
  (`password`, `token`, `hash`, …) ficam `[REDACTED]`.
- Auditado hoje: criação do tenant, convites e aceitação, suspensão/reactivação, atribuição e remoção de perfis,
  perfis, estrutura organizacional, workflows, pedidos e decisões de aprovação, delegações, anexos (carregar,
  descarregar, eliminar). Consulta com `audit.read`.

## Aprovações

- `approval_workflows` (DRAFT → ACTIVE → RETIRED; publicado é imutável, também por trigger nas etapas) com etapas
  ordenadas; aprovador por **perfil** (qualquer membro activo com o perfil activo, em qualquer âmbito) ou por **membro**;
  `requiredApprovals` por etapa. Publicar exige perfis activos com titulares suficientes e membros activos.
- Pedidos (`approval_requests`) sobre um assunto: `manual` ou um tipo registado por um módulo (`bank_account`). O módulo
  dono submete com `submitForSubject` na sua transacção e regista o efeito com `registerSubjectHandler` (em
  `start/module_hooks.ts`, para não criar importações circulares); o efeito corre na transacção da decisão final
  (aprovado, rejeitado ou cancelado).
- Decidir não depende de uma permissão: depende de ser aprovador da etapa corrente ou delegado activo de um. O pedido
  é bloqueado (`FOR UPDATE`) durante a decisão; `approval_decisions` é só de acrescentar e tem dois índices únicos: um
  voto por aprovador elegível e um voto por pessoa em cada etapa (um delegado que também é aprovador não vota duas vezes).
- Segregação de funções: o requerente (e quem lhe delegou) não decide o próprio pedido. Rejeitar exige motivo.
- Delegações: cada membro delega as suas aprovações (período, motivo, opcionalmente só um workflow); o delegado decide
  "em nome de" e fica registado quem decidiu e por quem. Sem cadeias: só se delega o que se tem directamente.
- Visibilidade: `approvals.read` vê tudo; os restantes vêem os pedidos que fizeram, em que decidiram ou que podem
  decidir agora (os outros respondem 404).

## Configurações da empresa (módulo `settings`)

- `tenant_profiles` (um por empresa): nome a apresentar, referências, contactos, morada, logótipo (imagem anexada ao
  perfil). Idioma, fuso e moeda por omissão continuam no tenant (dono: `tenancy`) e são validados pelas regras dele. A
  identidade fiscal é de cada entidade legal, não do perfil.
- `tenant_settings`: casas decimais de valores (0–6), quantidades (0–6) e preços (0–8), arredondamento `HALF_UP` ou
  `HALF_EVEN`, validade dos convites, notificações de aprovação desligáveis (a tarefa existe sempre), workflow de
  aprovação de contas bancárias. Sem linha, valem os valores por omissão; `tenantSettings(scope)` é o contrato.
- `exchange_rates`: taxa `numeric(24,10)` em texto decimal na API (nunca `float`), um por par e data; a taxa em vigor
  numa data é a mais recente com `valid_on` ≤ data (`rateOn`).
- `document_series`: por entidade legal (filial opcional) e tipo de documento; a numeração só avança e uma série fechada
  não reabre. `reserveDocumentNumber(scope, seriesId, on)` bloqueia a série (`FOR UPDATE`) e devolve o número formatado
  na transacção de quem emite (sem lacunas se a emissão falhar, porque tudo volta atrás).
- `calendars` e `calendar_holidays`: dias de descanso (ISO 1–7) e feriados nacionais/regionais/da empresa; `GET
…/working-days` conta dias úteis (até 366 dias; `workingDaysBetween` para os módulos).
- `bank_accounts`: IBAN validado (mod 97) e SWIFT/BIC; dados bancários imutáveis (para mudar, cria-se outra conta);
  uma conta por omissão por entidade legal e moeda; com workflow configurado nasce `PENDING_APPROVAL` e só fica
  `ACTIVE` quando aprovada (rejeitada → `REJECTED`); sem aprovações contratadas e com workflow configurado recusa-se
  (409 `APPROVAL_UNAVAILABLE`). As listas mostram o IBAN mascarado.
- Permissões: `settings.read`/`settings.manage` e `bank_accounts.read`/`bank_accounts.manage`. Depois de acrescentar
  permissões, `node ace catalog:sync` dá-as ao perfil `tenant_admin` das empresas existentes.
- Fora deste módulo, de propósito: cálculo fiscal, tesouraria, movimentos bancários.

## Contabilidade (módulo `accounting`, Prompt 06)

Blocos 6.1 a 6.8 e 6.10 feitos; 6.9 (SAF-T) bloqueado até haver a especificação oficial verificada (ver `docs/reports/prompt-06.md`).

- **Plano de contas** por entidade legal (um activo, índice parcial único). Contas em árvore: classe → conta →
  subconta; o código do filho começa pelo do pai; só contas sem subcontas são movimentáveis; natureza, saldo normal,
  exigência de centro de custo/terceiro e linha das demonstrações (código livre para 6.8). Uma conta com movimentos
  não muda de natureza nem deixa de ser movimentável. **Nenhum plano oficial é pré-carregado** (D-014).
- **Exercícios** sem sobreposição (restrição de exclusão `daterange`), 1 a 24 meses, com períodos gerados: abertura
  (0), mensais e regularizações. Fechar um período exige não haver lançamentos submetidos/aprovados; reabrir exige
  motivo; ambos auditados (`accounting.close` / `accounting.reopen`).
- **Diários** numerados por uma série documental do tipo `JOURNAL` da mesma entidade legal
  (`reserveDocumentNumber`, sem lacunas, no momento da contabilização).
- **Lançamentos**: rascunho → submetido → aprovado → contabilizado. Submeter e contabilizar validam ≥ 2 linhas, um
  só lado por linha, valores > 0, contas movimentáveis e activas do plano da entidade, centros de custo da mesma
  entidade, período e exercício abertos e débito = crédito **na moeda do lançamento e na funcional** (conversão
  linha a linha com o arredondamento da empresa, decimais exactos em BigInt). Quem criou ou submeteu não aprova nem
  rejeita. Contabilizado é imutável (trigger `journal_entries_guard`/`journal_lines_guard`, também para a conta dona);
  corrige-se por estorno (lados trocados, mesmo diário, numerado, uma única vez, nunca de um estorno).
  `idempotencyKey` devolve o lançamento já criado (bloqueio consultivo + índice único). Montantes guardados em
  `numeric(24,6)` e devolvidos na precisão da empresa. Anexos (`journal_entry`) até à contabilização.
- **Motor de contabilização (6.3)**: `posting_rules` por entidade legal, origem (`SALES_INVOICE`, …) e evento
  (`ISSUED`, …), com diário e vigência; duas regras activas da mesma origem/evento não se sobrepõem (restrição de
  exclusão). As linhas da regra indicam lado, **conta configurada pela empresa** (nunca códigos no código) e a chave do
  montante no evento (`total`, `net`, `tax`, …); montante zero omite a linha, montante em falta é erro. Uma regra que
  já contabilizou eventos não muda (só nome, data fim, descrição, automático e estado): fecha-se a vigência e cria-se
  outra. `postAccountingEvent(scope, evento)` é o contrato para os módulos: corre na transacção de quem chama, cria o
  lançamento com as mesmas validações dos manuais e, se a regra o pedir, contabiliza-o (numerado); senão fica em
  rascunho para o fluxo normal. Idempotente pela chave (por omissão `origem:evento:referência`, bloqueio consultivo +
  índice único). Pela API (`POST /accounting/posting-events`) uma falha fica registada em `posting_events` como
  `FAILED` com a mensagem (numa transacção à parte) e pode ser reprocessada; `…/simulate` mostra as linhas e os
  problemas sem gravar.
- **Abertura, razão e balancete (6.4)**: a importação de saldos recebe linhas por **código** de conta (CSV colado
  ou carregado e lido no browser), valida-as todas (conta existente e movimentável, um só lado, centro de custo e
  terceiro quando exigidos, duplicados, equilíbrio) e cria um rascunho no período de abertura com origem
  `OPENING_BALANCE`; uma importação activa por exercício (bloqueio consultivo), nova só depois de estornada a anterior.
  O razão (`GET /accounting/ledger`) é por exercício: conta (com subcontas, por CTE recursiva), datas, terceiro e
  centro de custo; saldo anterior = movimentos do exercício antes da data inicial; totais calculados no SQL, linhas
  limitadas a 5000. O balancete (`GET /accounting/trial-balance`) usa intervalos de períodos (0 = abertura) com
  saldo anterior, débitos, créditos e saldos devedor/credor; analítico ou sintético até um nível. As contas-mãe são
  somas da subárvore e **não entram nos totais** (só as folhas), por isso nada é contado duas vezes. Ambos só contam
  lançamentos contabilizados, na moeda funcional, com somas em BigInt; testes garantem balancete = razão.
- **Analítica (6.5)**: dimensões (projecto, região, …) com valores, chaves de repartição por entidade legal e
  imputações de linhas por (lançamento, n.º de linha), cada destino com percentagem (4 casas), centro de custo da
  entidade e no máximo um valor por dimensão (FK composta valor+dimensão). As percentagens somam exactamente 100; a
  repartição de um valor usa o maior resto, para que a soma das partes seja sempre o valor da linha. As imputações
  são uma camada sobre o razão: não criam nem alteram movimentos, por isso podem ser corrigidas depois de
  contabilizar (auditadas). Sem imputação, a linha conta 100% para o seu centro de custo. Mudar as linhas de um
  rascunho apaga as imputações antigas. O relatório (`GET /accounting/analytics`) reparte os movimentos
  contabilizados por centro de custo ou por valor de uma dimensão, mostra "Sem imputação" e confirma que os totais
  coincidem com o razão filtrado.
- **Activos fixos (6.6)**: classes por entidade (diário, conta do activo, amortizações acumuladas, gasto, ganho e
  perda; vida útil, método e coeficiente por omissão) e fichas (n.º de inventário, n.º de série, fornecedor,
  documento, data e custo de aquisição, residual, vida útil em meses, método, início da depreciação, localização e
  centro de custo). Estados `DRAFT` → `ACTIVE` (aquisição contabilizada) → `DISPOSED` (abate contabilizado). O mapa
  de depreciação é calculado (puro, BigInt): linha recta com acumulado arredondado mês a mês (soma exacta) ou
  degressivo por blocos de 12 meses com passagem à linha recta; mês inteiro no início, nada no mês do abate. O
  processamento mensal gera um lançamento contabilizado por mês e diário (gasto por conta e centro de custo em vigor
  no fim do mês, crédito das amortizações acumuladas) e uma linha por activo e mês em `fixed_asset_depreciations`
  (UNIQUE activo+mês). Bloqueio de duplicados: n.º de inventário e n.º de série (sem maiúsculas) únicos por
  entidade, depreciação única por mês, aquisição e abate só uma vez (estado + chave de idempotência). Concorrência:
  advisory lock por entidade e fichas `FOR UPDATE`. Transferências (localização/centro de custo) ficam no histórico
  de movimentos e não podem cair num mês já depreciado. O abate exige as depreciações até ao mês anterior e lança
  custo, acumulado, valor de venda e ganho/perda. Os lançamentos têm origem `FIXED_ASSETS` e só se estornam pela
  ficha (anular aquisição sem depreciações, anular abate, anular o último mês de depreciação); o estorno genérico
  recusa-os (409). Mapa por exercício: custo, acumulado inicial, do exercício, final, valor líquido e previsto.
  Permissões `fixed_assets.read|manage|post`. Vidas úteis e taxas são as que a empresa configura — não se assumem
  taxas fiscais.
- **Regularizações (6.7)**: tudo o que mexe no razão é um **rascunho** que segue a aprovação normal (quem gera não
  aprova); as tabelas do bloco só o referenciam e apagar o rascunho liberta a ocorrência (FK `ON DELETE CASCADE`).
  Planos (`adjustment_schedules`): recorrências com linhas fixas (mensal/trimestral/anual, com ou sem fim) e
  acréscimos/diferimentos com um total repartido exactamente por N meses (acumulado arredondado mês a mês); geração
  até um mês com simulação, advisory lock por entidade e UNIQUE plano+mês. Com meses gerados, o
  acréscimo/diferimento já não muda total, meses, início nem contas. Provisões: constituição/reforço (gasto →
  provisão), reversão (provisão → rendimento) e utilização (provisão → conta indicada); a provisão fica bloqueada e
  reversões/utilizações nunca excedem o saldo (que conta rascunhos e exclui estornados). Diferenças cambiais: para as
  contas escolhidas, saldos contabilizados por conta+moeda+terceiro; saldo em moeda ≠ 0 → não realizada (moeda ×
  câmbio de fecho de `rateOn`), saldo em moeda = 0 com resíduo funcional → realizada; o rascunho é em moeda funcional
  e cada diferença fica em `fx_revaluation_lines`, somada às seguintes quando contabilizada e não estornada. Uma por
  entidade e data, nunca com outra por contabilizar, nunca sem câmbio. Reconciliação de contas: grupos de linhas
  contabilizadas da mesma conta, entidade e terceiro cujos débitos igualam os créditos (funcional); UNIQUE por
  linha do razão e FK para `journal_lines`; desfazer é auditado.
- **Demonstrações financeiras (6.8)**: modelos por plano de contas, versionados (`DRAFT` → `PUBLISHED` → `RETIRED`;
  um publicado e um rascunho por código; publicar retira o anterior; o publicado não muda). Linhas: títulos, contas
  (prefixos de código com regra de saldo qualquer/devedor/credor), totais por fórmula (`A1+A2-A3`, sem ciclos) e
  resultado líquido (só no balanço). Cada conta vai para a linha do **prefixo mais longo** que aceita o sinal do seu
  saldo — nunca duas linhas — e o mesmo prefixo com regras sobrepostas em duas linhas é recusado. A demonstração é
  calculada a pedido dos lançamentos contabilizados (balanço: períodos até ao indicado, abertura incluída;
  resultados: só períodos normais), com coluna comparativa opcional e detalhe por conta; confere quando não há contas
  com saldo sem linha e as linhas de controlo coincidem (activo = capital próprio + passivo; resultado = resultado do
  razão). Notas numeradas por exercício. Exportação Excel (.xlsx gerado no browser, sem dependências) e
  impressão/PDF pelo browser (a moldura da aplicação não é impressa). Não há modelos pré-definidos nem alegação de
  conformidade com o PGC: os mapas são configurados pela empresa. Fluxos de caixa ficam para quando houver
  classificação de fluxos (Finanças).
- **Fecho (6.10)**: checklist por período, calculada a pedido — bloqueios (lançamentos submetidos/aprovados por
  contabilizar, débitos ≠ créditos) e avisos (rascunhos, eventos de integração falhados, depreciações e regularizações
  por gerar, actualizações cambiais em rascunho, períodos anteriores abertos, tarefas manuais por concluir) — e tarefas
  manuais (`close_tasks`, copiáveis do período anterior). Fechar um período com bloqueios é recusado
  (`CLOSE_BLOCKED`); com avisos exige `acknowledgeWarnings` (`CLOSE_WARNINGS`), que fica na auditoria. Concorrência:
  contabilizar bloqueia o período `FOR SHARE` e fechar bloqueia-o `FOR UPDATE`, por isso nunca entra um lançamento num
  período que outra transacção acabou de fechar. Encerramento do exercício (`fiscal_year_closings`, um em vigor por
  exercício): exige todos os períodos fechados menos o de regularizações; gera e contabiliza no período de
  regularizações o apuramento (contas de resultados por conta e centro de custo saldadas contra uma conta de capital
  próprio) e, se pedido, o transporte dos saldos de balanço (por conta, terceiro e centro de custo) para o período de
  abertura do exercício seguinte (vazio de lançamentos em vigor); fecha o período de regularizações e o exercício. A
  reabertura (motivo obrigatório, `accounting.reopen`) estorna o transporte na abertura seguinte (que tem de estar
  aberta) e o apuramento no período de regularizações; os lançamentos `YEAR_CLOSE`/`YEAR_OPENING` só se estornam assim.
- Permissões: `accounting.read|create|approve|post|reverse|close|reopen|settings|reports|analytics|adjustments|reconcile|statements` e `fixed_assets.read|manage|post`; funcionalidade `accounting`. Regras:
  `accounting.settings`; enviar/reprocessar eventos: `accounting.post`; simular e consultar: `accounting.read`.

## Anexos

- Metadados em `attachments` (RLS) e ficheiro no armazenamento local (`ATTACHMENTS_DIR`), numa chave gerada pelo
  servidor `<tenant>/<prefixo>/<id>`; nunca o nome enviado. Nome apresentável limpo de caminho e caracteres de controlo.
- Tipo decidido pela extensão (lista fechada: pdf, png, jpg/jpeg, webp, txt, csv, docx, xlsx, odt, ods) e confirmado pela
  assinatura do conteúdo; até 10 MB; SHA-256 gravado e verificado na descarga. Descarga com `attachment`, `nosniff`,
  `no-store` e CSP `sandbox`.
- Acesso herdado: cada `subject_type` tem uma política (funcionalidade contratada + permissões do registo). Ler exige
  ver o registo; escrever exige poder alterá-lo. Quota `attachments.storage_mb` (soma dos activos, sob advisory lock).
- Eliminação lógica (`DELETED`): ficheiro e metadados ficam para a auditoria; purga física por política de retenção
  fica pendente.

## Notificações e centro de tarefas

- `notifications` por destinatário (membership), criadas na transacção do evento (pedido pendente, decisão,
  cancelamento, delegação recebida); o actor não se notifica a si próprio. A leitura filtra sempre pela membership em
  contexto. Só in-app: o email espera fornecedor (D-009).
- `GET /me/tasks` deriva as tarefas das fontes de verdade (hoje: etapas de aprovação que o membro pode decidir, por si ou
  por delegação); não há tabela de tarefas duplicada.

## Preferências do membro

- `member_preferences` (tenant, membership, chave, valor JSON), uma linha por chave. `GET/PUT /me/preferences/:key`
  só lê e escreve a membership em contexto; chaves conhecidas (`favorites`, `dashboard`) com validação própria
  (caminhos internos, ids de widgets, limites de tamanho); chave desconhecida é 404. Sem dados de negócio, por isso
  sem auditoria (D-021).

## Frontend

- Angular 22 standalone, sinais e detecção de alterações sem zone; Tailwind 4 com primitivas mínimas em `styles.css`
  (`btn-*`, `input`, `card`, `table`, `badge`) até ao design system do Prompt 04.
- `core/api.ts`: único cliente HTTP; desembrulha `data`/`meta.total` e converte erros em `ApiError` (código, mensagem,
  detalhes por campo, `requestId`). `core/http.ts`: interceptor que envia `X-Tenant-Id` e, num 401, limpa a sessão e
  volta ao login. CSRF pelo mecanismo do Angular (`XSRF-TOKEN` → `X-XSRF-TOKEN`); a sessão é só o cookie HttpOnly.
- `core/session.ts` (`/auth/me`) e `core/workspace.ts` (`/context` + `/me/permissions`): a empresa escolhida fica em
  `localStorage` apenas como preferência; o servidor valida-a em cada pedido.
- Guards: `authGuard`, `tenantGuard` (escolha automática quando há uma só empresa), `accessGuard` (permissão e
  funcionalidade em `data`) e `platformGuard`. Esconder um ecrã nunca substitui a verificação da API.
- Formulários mostram os erros de validação do servidor junto do campo; alterações enviam `expectedVersion` e só os
  campos alterados (os imutáveis nunca se reenviam).
- O painel só mostra dados reais (tarefas, notificações, subscrição); módulos de negócio ausentes não aparecem.

## Painel e pesquisa global

- `GET /api/v1/dashboard` e `GET /api/v1/search?q=` (módulo `dashboard`) só compõem funções públicas dos módulos donos
  (`organizationCounts`, `countsByStatus`, `approvalStats`, `storageUsedBytes`, `searchOrganization`,
  `searchApprovals`, …), na empresa em contexto, com a mesma permissão e funcionalidade de cada módulo. Secção sem
  acesso vem `null`; fonte sem acesso não entra na pesquisa. Cobertos por `dashboard.spec.ts` e pela matriz de
  isolamento.
- Listas com ordenação no servidor: só campos declarados (organização: os da especificação e as datas; membros:
  `fullName`, `email`, `status`, `joinedAt`); outro campo dá 422. Os nomes de colunas nunca vêm do pedido.

## Recursos humanos (módulo `hr`, Prompt 07)

Blocos 7.1 e 7.2 feitos (ver `docs/reports/prompt-07.md`, D-024 e D-025).

- **Colaborador** (`employees`): código único, nome, contactos profissionais, entidade legal, filial, departamento,
  cargo, superior, centro de custo, membership opcional, admissão e estado (`ACTIVE`/`SUSPENDED`/`TERMINATED`). Dados
  pessoais em colunas próprias: nascimento, nacionalidade, documento e validade, NIF, INSS, contactos e morada pessoais,
  emergência, formação e banco (IBAN validado e normalizado). NIF, INSS e membership únicos por empresa (índices
  parciais); nascimento antes da admissão; não pode ser o próprio superior; ciclos recusados (CTE recursiva).
- **Âmbito**: `hr.read`, `hr.manage`, `hr.sensitive` com âmbito empresa, entidade legal, filial, departamento (com
  subárvore) ou o próprio; verificado em `EmployeeService` (`scopeClause`/`covers`). Fora do âmbito → 404; gerir sem
  âmbito → 403 `OUT_OF_SCOPE`; dados pessoais sem permissão → 403 `SENSITIVE_FORBIDDEN`.
- **Concorrência**: `expectedVersion` obrigatório em alterações (409 `VERSION_CONFLICT`).
- **Auditoria**: `hr.employee.created|updated|status_changed`, com os campos pessoais como `[RESERVADO]`.
- **Anexos**: tipo `employee` (funcionalidade `hr`), só com acesso aos dados pessoais do colaborador.
- Funcionalidade `hr` (plano); sem ela as rotas dão 403 `NOT_ENTITLED`.
- **Recrutamento** (7.2): `job_requisitions` (vaga com cargo, requisitos, quantidade, prazo e remuneração autorizada em
  `numeric`; DRAFT → PENDING_APPROVAL → OPEN → FILLED/CLOSED/CANCELLED), `candidates` (contactos mínimos, email único
  sem maiúsculas), `job_applications` (uma por vaga e candidato; etapas APPLIED → SCREENING → INTERVIEW → OFFER → HIRED,
  ou REJECTED/WITHDRAWN), `job_interviews`, `job_evaluations` (só de acréscimo, uma por avaliador e entrevista),
  `job_offers` (salário dentro da remuneração autorizada; uma em curso por candidatura) e `onboarding_tasks`.
- **Aprovações do recrutamento**: `hr_settings` aponta para workflows publicados (`job_requisition`, `job_offer`); sem
  workflow, decisão directa com `hr.recruitment.approve` no âmbito e segregação (403 `SEGREGATION`); com workflow, a
  decisão directa dá 409 `USE_APPROVAL_WORKFLOW` e o efeito chega por `onRequisitionDecided`/`onOfferDecided`
  (registados em `start/module_hooks.ts`).
- **Contratação** (`POST /hr/offers/:id/hire`): numa transacção, com a vaga bloqueada, cria o colaborador
  (`EmployeeService.createIn`, mesmas regras de 7.1), a checklist de onboarding e marca a vaga FILLED ao atingir a
  quantidade; repetir dá 409.
- **Validação**: os controllers do RH validam só o corpo JSON (`{ data: ctx.request.body() }`), para que parâmetros,
  cabeçalhos e cookies nunca cheguem aos serviços nem à auditoria.

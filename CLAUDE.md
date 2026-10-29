# CLAUDE.md — instruções permanentes de desenvolvimento

Plataforma de gestão empresarial **multi-tenant**, modular e configurável. Contrato funcional e técnico:
[`docs/especificacao-v2.docx`](docs/especificacao-v2.docx) (v2.0, 20/10/2026). Em caso de dúvida, a especificação
manda; se este ficheiro e a especificação divergirem, assinalar e propor correcção, nunca assumir.

Documentação: [`docs/architecture.md`](docs/architecture.md) · [`docs/decisions.md`](docs/decisions.md) ·
[`docs/implementation-plan.md`](docs/implementation-plan.md) · [`README.md`](README.md).

## Estado do repositório (actualizar quando mudar)

- `src/` (raiz): frontend **Angular 22 + Tailwind 4**. Identidade, tenants, membros, convites, organização e perfis, **administração
  da plataforma** (tenants, planos, subscrições), plano e módulos do tenant e configurações (preferências, impostos, unidades,
  sequências) já falam com a API real (sessão em cookie `HttpOnly`, CSRF, `X-Tenant-Id`; módulos e funcionalidades vêm do registo,
  sem direitos provisórios). O core dinâmico (C10: designer de entidades, listagem, formulário, detalhe e histórico) também fala com a API real (D-036); o campo FORMULA e o editor de regras (3.4, D-038) também; os formulários publicados organizam os registos e há um Form Builder (3.7, D-041); o estado e as acções de transição dos registos vêm do servidor (3.8, D-042) e há um designer de máquinas de estados (3.9, D-043); há caixa de aprovações, painel de aprovação nos registos, delegações e designer de workflows (3.10, D-044); há automações com simulação, activação e histórico de execuções (3.11, D-045), há o módulo «Catálogo e preços» (4.1, D-046) a página «Clientes» (4.2, D-047) e a de propostas e encomendas (4.3, D-048), a de armazéns e stock (4.4, D-050), o separador de expedições (4.5, D-051) a de facturação e contratos (4.6, D-052) a de compras (4.7, D-053) e a «Tesouraria» (5.1, D-054), e as UIs de papéis, políticas ABAC com simulador, âmbitos, centros de custo/equipas, Party («Pessoas e entidades») e conta (sessões, palavra-passe) também (fatia 1.10, D-049).
- `backend/`: API **AdonisJS 6 + PostgreSQL 16 + Redis**. Fase 0 e fatias 1.1–1.9 feitas (a 1.8, frontend, ficou parcial: ver `docs/implementation-plan.md` 2.9) (arranque, ambiente, saúde, erros,
  correlation id, `TenantContext`, acesso a dados por tenant com RLS, helpers de migration, verificadores de esquema e de
  arquitectura), tenants/domínios, autenticação (sessão opaca, CSRF, recuperação; sem MFA/SSO) e `TenantMembership` com
  resolução do contexto de tenant no servidor (`GET /context`) e autorização RBAC+ABAC (papéis, atribuições, políticas por
  AST, simulação) e organização (unidades em árvore, centros de custo, equipas, âmbitos de acesso por unidade), convites e gestão de membros (último administrador protegido) e Party (pessoas e organizações externas, contactos, moradas) e auditoria mínima (fatia 2.1: `audit_logs` imutável por triggers, `security_events`, consulta com RBAC) e planos/assinaturas (fatia 2.2: versões imutáveis, quota de membros por plano, `GET /tenant/subscription`; gestão por comandos `plan:*`/`subscription:*`) e registo de módulos (fatia 2.3: manifestos por código, activação por tenant com licença, `middleware.feature`; `modules:sync`) e configurações/impostos/unidades/sequências (fatia 2.4: precedência por âmbitos permitidos, numeração sob lock via `settingsServices().sequenceIssuer`) e administração da plataforma (fatia 2.5: concessões `platform.*` por comando, rotas `/platform/*` sem tenant, provisionamento idempotente) e metadados/entidades dinâmicas (fatia 3.1, `app/dynamic/metadata`: entidades com versões publicadas imutáveis, campos tipados, registos JSONB validados por versão, únicos pela base, sensíveis à parte; permissões `entity.*`/`dynamic.*` com ABAC por entidade, D-035) e fórmulas/regras/valores relacionados/formulários (fatias 3.3, 3.5 e 3.6: campo FORMULA com AST e cálculo exacto no servidor; `app/dynamic/rules` com regras `VALIDATE`/`BLOCK` por AST, simulação e avaliações registadas, D-037; campo LOOKUP lido em tempo real com a autorização do destino, D-039; `app/dynamic/forms` com formulários de secções e ligações a campos, revisões imutáveis, D-040; `app/dynamic/states` com máquinas de estados, transições atómicas com histórico e outbox, D-042) e workflows de aprovação (fatia 3.10: `app/dynamic/workflows` com definições imutáveis por etapas, processos com snapshot e versão do registo, tarefas de grupo, decisões idempotentes sob bloqueio, segregação de funções, delegações e eventos por outbox, D-044) e automações (fatia 3.11: `app/dynamic/automations` com gatilho por evento do outbox ou calendário, execução em nome de quem activa, inbox, deduplicação, causalidade limitada, recuo e fila de falhas; trabalhador `node ace automation:work`, D-045).
  A matriz de isolamento (`tests/functional/isolation_matrix.spec.ts`) cobre todas as rotas e tabelas de tenant: ao criar
  uma rota ou tabela de tenant, estenda `tests/support/matrix_fixture.ts` e declare o selector no OpenAPI.
  Catálogo e preços (fatia 4.1, `app/modules/catalog`, módulo `catalog` do registo: categorias, produtos e variantes com SKU, tabelas de preços por escalão e resolução com origem, D-046) é o **primeiro módulo de negócio**; clientes (fatia 4.2, `app/modules/customers`, módulo `customers`: condições comerciais sobre a Party, crédito protegido, bloqueio, interacções, D-047) é o segundo; propostas e encomendas (fatia 4.3, `app/modules/orders`, módulo `orders`: linhas em instantâneo com aritmética exacta, aceitação e confirmação idempotentes, D-048) é o terceiro; inventário (fatia 4.4, `app/modules/inventory`, módulo `inventory`: armazéns, locais, lotes, livro de movimentos imutável, saldos sob bloqueio, custo médio, reservas; reserva e liberta stock na transacção de confirmar/cancelar encomendas via `registerOrderEffects`, D-050) é o quarto; as expedições (fatia 4.5, dentro do módulo `orders`, funcionalidade `orders.shipments`: saldo por linha sob bloqueio da encomenda, lançar baixa o stock por efeito registado pelo inventário na mesma transacção, reverter repõe, D-051) são a parte seguinte de M04; contratos, facturas e notas de crédito (fatia 4.6, `app/modules/invoicing`, módulo `invoicing`: facturas de encomenda pelo expedido/encomendado sob bloqueio da encomenda ou de linhas livres, emissão atómica e idempotente com instantâneo do cliente, notas de crédito que nunca excedem o facturado e não devolvem stock, contratos com estado «expirado» derivado, tudo imutável depois de emitido, D-052) é o quinto (M05); compras (fatia 4.7, `app/modules/procurement`, módulo `procurement`: fornecedores sobre a Party, requisições aprovadas por outra pessoa, encomendas a fornecedor com custos exactos, recepções que dão entrada do stock ao custo da encomenda por efeito registado pelo inventário na mesma transacção, tudo imutável depois de confirmado ou lançado, D-053) é o sexto (M06); finanças (fatia 5.1, `app/modules/finance`, módulo `finance`: contas de tesouraria, recebíveis criados ao emitir facturas (`registerInvoiceEffects`), pagáveis das facturas de fornecedor validadas com conferência a três vias, pagamentos cuja confirmação é a única operação que move dinheiro (saldo derivado, nunca um campo; movimentos só-de-acrescentar; reversão), limite e reserva de crédito na confirmação de encomendas, D-054) é o sétimo (M09); a logística de stock (fatia 4.8, dentro de `app/modules/inventory`, funcionalidades `inventory.transfers|counts|returns`: transferências com armazém técnico de trânsito e recepção parcial, contagens que congelam locais e lançam ajustes uma só vez, devoluções derivadas do livro e limitadas à origem; armazéns técnicos `TRANSITO`/`DANIFICADO`/`QUARENTENA`, D-055) é o oitavo (M08); os restantes (conciliação bancária, cotações) **ainda não existem**.
- Fase actual e próximos passos: ver `docs/implementation-plan.md`. Uma fase de cada vez; não avançar sem pedido.

## Comandos

Frontend (raiz, npm; lockfile `package-lock.json`):
`npm ci` · `npm run lint` · `npm run format:check` · `npm run check:generic` · `npx ng test --watch=false` · `npm run build`
(o Angular CLI exige Node ≥ 22.22.3 ou 24.15; se o `node` do ambiente for mais antigo, use um Node 24 no `PATH`)

Backend (`cd backend`, npm; lockfile `backend/package-lock.json`):
`npm ci` · `cp .env.example .env` (preencher; ver README) · `npm run migrate` · `npm run lint` · `npm run format:check` ·
`npm run typecheck` · `npm test` · `npm run build` · `npm run dev` · `node ace automation:work` (trabalhador das automações; `--once` faz uma só volta)

Nunca fazer commit de `.env`, `.env.*` (excepto `*.example`) nem de qualquer segredo. Não colar valores de segredos em
respostas, logs ou documentação.

## Invariantes — multi-tenancy

- O **tenant é a fronteira de isolamento**. O **backend** resolve e valida o contexto do tenant em cada pedido.
- Um `tenant_id` recebido do frontend **nunca** constitui autorização (é só um selector a validar contra a sessão e a
  membership activa).
- `User` é uma identidade **global**; `TenantMembership` associa o utilizador a cada tenant. Pessoa de negócio ≠ User.
- As entidades de domínio pertencem ao tenant (`tenant_id` obrigatório). Tabelas globais são enumeradas explicitamente;
  nunca se infere globalidade pela ausência de filtro.
- Relações entre entidades não podem ligar dados de tenants diferentes (FKs compostas `(tenant_id, id)`).
- O isolamento cobre **base de dados, cache, jobs, ficheiros, pesquisa, relatórios, exportações e WebSocket**
  (chaves/prefixos/canais com tenant; jobs transportam o contexto e revalidam).
- **RLS complementa** (não substitui) os filtros dos repositórios e a autorização. A conta de runtime nunca é
  superuser, dona das tabelas nem `BYPASSRLS`; migrations usam a conta `owner` (ver `docs/architecture.md`).
- Operações de domínio **sem contexto de tenant válido falham de forma segura** (negar, nunca "tenant por omissão").

## Invariantes — arquitectura

- **Monólito modular**, cada módulo com `domain`, `application`, `infrastructure` e `presentation`. Sem microserviços
  prematuros.
- Controllers e componentes de interface **não** concentram regras de negócio (validam transporte e chamam casos de uso).
- Um módulo **não escreve** nas tabelas de outro: usa interface pública ou comando. Reporting pode usar read models.
- Regras sectoriais pertencem aos módulos **verticais**; o núcleo comum não conhece sectores.

## Invariantes — autorização

- RBAC + ABAC **no servidor**; **negar por omissão**; qualquer DENY prevalece.
- Proteger também **campos sensíveis, comandos, operações em lote e exportações**.
- Guards e menus do frontend são conveniência visual, **nunca** segurança.
- O administrador SaaS **não** recebe acesso automático aos dados empresariais dos tenants (suporte excepcional exige
  concessão explícita, limitada no tempo, justificada e auditada).
- Leitura de um ID alheio devolve 404 (não revela existência).

## Invariantes — consistência

- Dinheiro e quantidades usam precisão decimal (`money` = numeric(19,4), `qty` = numeric(19,6)); **nunca float**;
  decimais atravessam a API como **strings**.
- Transacções, controlo de concorrência (`expectedVersion`/`409`) e **idempotência** (`Idempotency-Key`) onde necessário.
- Documentos emitidos e movimentos lançados **não são alterados silenciosamente**: reverte-se por operação explícita.
- Confirmação de venda, entrega, emissão de fatura e recebimento são operações **distintas**.
- Stock é suportado por **movimentos rastreáveis**.
- Eventos críticos usam **outbox** e consumidores **idempotentes** (inbox) quando forem implementados.

## Invariantes — personalização (low-code)

- Metadados, formulários e workflows publicados são **versionados** e imutáveis depois de publicados.
- O motor low-code **não elimina** invariantes de segurança ou de negócio.
- **Nunca** executar SQL, JavaScript ou código fornecido pelo tenant (só AST/gramáticas declarativas).
- Sem regras específicas de um cliente no núcleo.

## Invariantes — qualidade

- Não apresentar mocks, placeholders ou funcionalidades incompletas como concluídas.
- Não alterar regras de negócio para fazer um teste passar; os testes representam as invariantes da especificação.
- Não declarar que se executaram comandos ou testes que não se executaram; registar o que ficou por verificar.
- Manter a documentação coerente com o código efectivamente implementado.

## Convenções técnicas

- API: base `/api/v1`; DTOs `camelCase`; tabelas `snake_case`; IDs UUID (string). Sucesso `{ data, meta:{correlationId} }`;
  erro `{ error:{ code, message, details:[{path,code,message}], correlationId } }`. Nunca devolver stack, SQL ou segredos.
- HTTP: 400 pedido/selector inválido · 401 sem sessão · 403 sem permissão · 404 inexistente/fora do âmbito ·
  409 conflito (versão, estado, duplicado, idempotência) · 422 validação · 429 limite · 5xx falha interna (genérica).
- Cada pedido tem `correlationId` (gerado/validado pelo servidor, cabeçalho `X-Correlation-Id`); entra em logs e erros.
- Logs estruturados, sem payloads sensíveis (campos redigidos em `config/logger.ts`).
- Configuração por variáveis de ambiente validadas no arranque (`backend/start/env_schema.ts`). Sem segredos no código.
- Tabelas de tenant criam-se **só** com `createTenantTable`/`tenantForeignKey` (`backend/database/support`); acesso a dados
  de tenant **só** por `LucidTenantDatabase.run()` + `TenantRepository`; módulos importam outros só por `index.ts`.
  `npm test` falha se uma tabela não cumprir o isolamento ou se uma fronteira de módulo for violada.
- Migrations: versionadas, **sem** `IF NOT EXISTS` indiscriminado, estratégia expand/contract; seeds idempotentes;
  dados de demonstração só em ambientes não produtivos e em **dois tenants** separados.
- Não actualizar versões principais de dependências sem ADR (ver `docs/decisions.md`). Respeitar os lockfiles.
- TypeScript estrito; sem `any` desnecessário; sem código morto nem ficheiros vazios "para depois".

## Como trabalhar

1. Ler o ficheiro/área antes de editar; preservar alterações locais e funcionalidades existentes.
2. Antes de cada fase: mapa de ficheiros, entidades, contratos e testes de aceitação (`docs/implementation-plan.md`).
3. Implementar **fatias verticais** (migration + domínio + API + UI + autorização + auditoria + testes).
4. Antes de dar uma entrega por concluída: lint, typecheck, testes, build e migrations numa base limpa — e dizer o que
   **não** foi possível executar.
5. Não fazer commit, push, deploy, migrations em produção nem operações destrutivas sem autorização explícita.

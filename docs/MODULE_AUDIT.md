# Auditoria dos módulos

Auditoria de 2026-10-29 sobre o repositório no commit `f287cd4` (branch `claude/pensive-clarke-5gm075`). O estado de um módulo **não** se deduz da existência de ficheiros: cada linha reflecte código lido, testes executados e a especificação `docs/especificacao-v2.docx`.

## 1. Método e evidências

- **Inventário:** manifestos do frontend (`defineModule`, 35 capacidades), módulos do backend (`app/core`, `app/platform`, `app/dynamic`, `app/modules`), 304 rotas em `backend/start/routes.ts`, 30 migrations e 76 tabelas de tenant (`createTenantTable`).
- **Testes executados na última corrida completa:** backend 643 (unitários e funcionais, incluindo a matriz de isolamento por tabela e rota e a paridade rotas↔OpenAPI), frontend 1014 (Vitest). Lint, format, typecheck e build limpos. Migrations subidas e descidas numa base limpa em cada corrida do backend.
- **E2E em browser real** (Playwright sobre a API real) correram por fatia, com scripts locais fora do repositório (limitação: não são reproduzíveis por terceiros nem estão em CI).
- **Varreduras automáticas ao frontend:** sem `(click)` vazio, sem `href="#"`/`routerLink="#"`, sem botões desactivados fixos, sem `TODO/FIXME`; os *mocks* (`core/mock`, `core/testing`) só são carregados em testes (`provideMockBackend` só é importado por `core/testing`). Os ecrãs provisórios (`module-scaffold`) dizem explicitamente que o módulo não está implementado.
- **Critérios de aceitação da especificação:** 129 critérios; ver `MODULE_COMPLETION.md` (53 verificados por teste, 10 parciais, 66 não verificados ou de módulos não implementados).

## 2. Estado por módulo

Legenda dos estados de módulo: **Não iniciado** · **Parcialmente implementado** · **Implementado sem validação** · **Em testes** · **Concluído e validado** · **Bloqueado**. Legenda das colunas: Completo (cumpre todos os requisitos da especificação para essa camada) · Parcial · Ausente.

| Grupo | Módulos | Estado |
| --- | --- | --- |
| Fundação (C01–C09, S06 mínimo) | tenants, planos, módulos, identidade, membros, autorização, organização, Party, configurações, auditoria | Parcialmente implementado (fatias validadas; lacunas na matriz) |
| Core dinâmico (C10–C15) | entidades/campos, formulários, regras, estados, workflows, automações | Parcialmente implementado |
| Negócio implementado | M01 clientes, M03 catálogo, M04 vendas/expedições, M05 facturação, M06 compras, M07 inventário | Parcialmente implementado |
| Negócio por fazer | M02, M08, M09, M10, M11, M12, M13, M14 | Não iniciado |
| Serviços transversais por fazer | S01 documentos, S02 notificações, S03 calendário, S04 relatórios, S05 integrações, S06 (UI/exportação/recuperação) | Não iniciado |
| Verticais | V01–V06 | Não iniciado |

**Nenhum módulo está «Concluído e validado»**: todos têm requisitos aprovados por cumprir (coluna «Problemas»).

## 3. Matriz de funcionalidades

| Módulo | Submódulo | Funcionalidade | Frontend | Backend | Base de dados | Integração | Testes | Problemas encontrados | Acções necessárias |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C01 Tenants | Provisionamento | Criar, suspender, reactivar tenant; domínios | Parcial | Completo | Completo | Parcial | BE: tenants/platform.spec (20) · FE: platform (19) | Sem `ProvisioningStep` persistido | Persistir passos de provisionamento (baixa prioridade) |
| C02 Planos | Planos e assinaturas | Planos versionados, assinatura, quota de membros, mudança de plano | Parcial | Parcial | Completo | Parcial | billing.spec (10) | Sem `UsageCounter`, pedido de mudança de plano nem faturação SaaS/webhooks | Contadores de uso; pedido de mudança; registo de faturação SaaS |
| C03 Módulos | Registo | Catálogo por código, activação, overrides, `middleware.feature` | Completo | Completo | Completo | Completo | modules.spec (15) | Sem configuração por módulo | Configuração por módulo (settings já suportam o âmbito) |
| C03 Módulos | Capacidades do frontend | Menu e rotas das capacidades do catálogo | Parcial | Completo | Completo | Parcial | module-catalog.spec | **6 capacidades** (`iam.teams`, `organization.cost-centers`, `workflow.flows`, `workflow.rules`, `configuration.forms`, `configuration.localization`) mostram o ecrã provisório «ainda não implementadas» embora a função exista noutras rotas (A-01) | Ligar cada capacidade à página real |
| C04 Identidade | Autenticação | Login, sessão opaca, CSRF, recuperação, verificação de email, sessões | Completo | Parcial | Completo | Completo | auth.spec (24) · FE auth (10) | Sem MFA/SSO nem fornecedor de email (D-021) | MFA (TOTP) e driver de email — decisão de produto |
| C05 Membros | Convites e membros | Membership, convites, quota, último admin, preferências | Completo | Completo | Completo | Completo | members.spec (18) · FE users | Sem reenvio de convite nem auto-registo | Reenvio de convite |
| C06 Autorização | RBAC/ABAC | Papéis, atribuições, políticas AST, simulação, regras de campo | Completo | Parcial | Completo | Completo | iam.spec (13) · FE permissions | Sem filtro de linhas, cache de decisões nem auditoria própria | Auditoria das alterações de papéis/políticas já via triggers; cache fora de âmbito |
| C07 Organização | Estrutura | Organizações, unidades, centros de custo, equipas, âmbitos | Completo | Parcial | Completo | Completo | organization.spec (14) | Sem preview de impacto, regra de documentos nem moeda-base bloqueada por lançamentos; documentos não guardam a unidade | Unidade nos documentos; bloquear moeda-base com lançamentos |
| C08 Party | Pessoas e entidades | Party, contactos, moradas, relações, duplicados | Parcial | Parcial | Completo | Completo | party.spec (14) | Sem fusão assistida; contactos e moradas não são editáveis na UI | Fusão assistida (`party.merge`); edição de contactos/moradas |
| C09 Configurações | Settings/impostos/unidades/sequências | Valor efectivo por âmbito, taxas, unidades, numeração | Completo | Parcial | Completo | Completo | settings.spec (15) | Sem catálogo de moedas e idiomas; sem cálculo de impostos genérico | Catálogo de moedas/idiomas; UI de preferências por módulo |
| C10 Core dinâmico | Entidades e campos | Versões imutáveis, 15 tipos de campo, registos, únicos | Parcial | Parcial | Completo | Completo | metadata.spec (26) · FE dynamic-core (152) | Sem AUTONUMBER/FILE/IMAGE/CURRENCY/CHECKBOX, extensão de entidades nativas, migração de dados nem estado do registo | Tipos em falta; migração de dados com dry-run |
| C11 Formulários | Form Builder | Formulários por entidade, secções, condições, revisões | Completo | Parcial | Completo | Completo | forms.spec (9) | Sem `FormSubmission`, política de valores escondidos nem grupos | Submissões e grupos |
| C12 Regras | Regras e fórmulas | Regras VALIDATE/BLOCK, FORMULA, simulação | Completo | Parcial | Completo | Completo | rules.spec (8) | Sem gatilhos BEFORE/AFTER_COMMIT, acções além de bloquear nem orçamento de custo | Orçamento de avaliação testado; outras acções |
| C13 Estados | Máquinas de estados | Estados, transições, histórico, outbox | Parcial | Parcial | Completo | Completo | states.spec (8) | Sem worker/inbox, migração de registos em curso, `action_code` nem diagrama | Diagrama; migração de registos |
| C14 Workflows | Aprovações | Etapas, QUORUM, delegações, caixa de tarefas | Completo | Parcial | Completo | Completo | workflows.spec (15) | Sem escalonamento, notificações (S02), SLA, ramificações nem consumidores | Escalonamento e notificações após S02 |
| C15 Automações | Automações | Eventos e calendário, execução, retry, fila de falhas | Completo | Parcial | Completo | Completo | automations.spec (15) | Sem acções de notificação/tarefas, retenção nem idempotência própria das acções | Acções de notificação após S02 |
| S06 Auditoria | Registo de auditoria | `audit_logs` imutável, security_events, consulta | Ausente | Parcial | Completo | Parcial | audit.spec (8) | **Sem UI**, exportação, retenção automática nem hash encadeado; sem backups/restauro | UI de consulta; exportação; retenção |
| M01 Clientes | Clientes | Condições comerciais sobre a Party, segmentos, interacções | Completo | Parcial | Completo | Completo | customers.spec (11) · FE crm (12) | Sem verificação de crédito nem saldo (dependem de M09); sem importação | Crédito e saldo com M09 |
| M02 CRM comercial | Leads, oportunidades, campanhas | Pipeline, conversão, campanhas | Ausente | Ausente | Ausente | Ausente | — | Módulo não iniciado (a capacidade `crm.pipeline`/`crm.campaigns` é provisória) | Implementar (fila 3) |
| M03 Catálogo | Produtos e preços | Categorias, produtos, variantes, tabelas de preços, resolução | Parcial | Completo | Completo | Completo | catalog.spec (11) | UI sem edição de variantes/itens de preço nem desactivação de categorias; sem promoções, preço por cliente, imagens, unidades alternativas, importação | Completar UI e regras de preço |
| M04 Vendas | Propostas e encomendas | Linhas em instantâneo, aceitação, confirmação, cancelamento | Parcial | Parcial | Completo | Completo | orders.spec (15) | Sem verificação de crédito, preços manuais com alçada, filiais, PDF | Crédito (M09); alçada de desconto (C14) |
| M04 Vendas | Expedições | Saldo por linha, lançar baixa stock, reverter | Completo | Parcial | Completo | Completo | shipments.spec (12) | Sem escolha manual de lote/local, séries nem devoluções | Devoluções (M08) |
| M05 Facturação | Facturas e notas de crédito | Emissão atómica, snapshot, notas, imutabilidade | Completo | Parcial | Completo | Completo | invoicing.spec (19) | Sem recebível, certificação fiscal, PDF, notas de débito; 2 critérios só parciais | Receivable ao emitir (M09); PDF (S01) |
| M05 Facturação | Contratos | Rascunho/activo/terminado, expirado derivado | Completo | Parcial | Completo | Completo | invoicing.spec | Sem facturação recorrente | Recorrência por contrato |
| M06 Compras | Fornecedores e requisições | Fornecedor sobre Party, requisição, aprovação por outra pessoa | Completo | Parcial | Completo | Completo | procurement.spec (16) | Sem cotações nem comparação | Cotações (`/supplier-quotations`) |
| M06 Compras | Encomendas e recepções | Encomenda, recepção, entrada de stock, reversão | Completo | Parcial | Completo | Completo | procurement.spec | **Desvio:** não cancela o restante depois de recepção parcial; sem aceite/rejeitado na recepção, três vias, devoluções ao fornecedor | Corrigir o cancelamento do restante; qualidade na recepção; 3 vias com M09 |
| M07 Inventário | Armazéns, movimentos, lotes, reservas | Livro imutável, saldos, custo médio, reservas | Completo | Parcial | Completo | Completo | inventory.spec (22) | Sem números de série, «em trânsito» nem trabalhador de expiração | Trânsito (M08); trabalhador de expiração |
| M08 Logística de stock | Transferências, contagens, devoluções | Transferência com trânsito, contagem com congelamento, devolução | Ausente | Ausente | Ausente | Ausente | — | Módulo não iniciado (`inventory.movements`, `inventory.stocktaking` provisórios) | Implementar (fila 2) |
| M09 Tesouraria | Contas, recebíveis, pagamentos, conciliação | Obrigações, alocações, reversão, extrato | Ausente | Ausente | Ausente | Ausente | — | Módulo não iniciado; **bloqueia** crédito (M01/M04), recebível (M05) e três vias (M06) | Implementar primeiro (fila 1) |
| M10 Orçamentos | Orçamentos e despesas | Orçamento, reserva de disponibilidade, despesas | Ausente | Ausente | Ausente | Ausente | — | Não iniciado | Fila 5 |
| M11 RH | Colaboradores, contratos, assiduidade, férias | Colaborador sem conta, férias, salário protegido | Ausente | Ausente | Ausente | Ausente | — | Não iniciado | Fila 5 |
| M12 Talento | Avaliação, formação, recrutamento | Ciclos, objectivos, vagas | Ausente | Ausente | Ausente | Ausente | — | Não iniciado | Fila 5 |
| M13 Projectos | Projectos, tarefas, tempos | Tarefas com dependências, timesheets | Ausente | Ausente | Ausente | Ausente | — | Não iniciado | Fila 5 |
| M14 Suporte | Tickets, SLA, base de conhecimento | Ticket, SLA, notas internas | Ausente | Ausente | Ausente | Ausente | — | Não iniciado | Fila 5 |
| S01 Documentos | Anexos, versões, templates | Upload com quota, versões, templates, PDF | Ausente | Ausente | Ausente | Ausente | — | Não iniciado; bloqueia PDF de documentos (M04/M05) | Fila 4 |
| S02 Notificações | Notificações e comunicação | Entrega, preferências, dedupe | Ausente | Ausente | Ausente | Ausente | — | Não iniciado; bloqueia notificações de workflows/automações/campanhas | Fila 4 |
| S03 Calendário | Calendários e reservas de recursos | Eventos, reservas sem sobreposição | Ausente | Ausente | Ausente | Ausente | — | Não iniciado | Fila 4 |
| S04 Relatórios | Dashboards, relatórios, exportação, pesquisa | Totais coerentes com listagens, CSV sem campos escondidos | Ausente | Ausente | Ausente | Ausente | — | Não iniciado; o dashboard do tenant não mostra dados de negócio reais | Fila 4 |
| S05 Integrações | API pública, chaves, webhooks, importações | Chaves revogáveis, webhooks com event_id, import com relatório | Ausente | Ausente | Ausente | Ausente | — | Não iniciado | Fila 4 |
| V01–V06 Verticais | Formação, escola, clínica, POS, federação, logística/manutenção | Módulos verticais | Ausente | Ausente | Ausente | Ausente | — | Não iniciados (fora do núcleo; o núcleo não conhece sectores) | Fila 6, só após o núcleo |

## 4. Lacunas identificadas (registo)

| ID | Lacuna | Módulo | Gravidade | Estado |
| --- | --- | --- | --- | --- |
| A-01 | Seis capacidades do catálogo mostram o ecrã provisório «ainda não implementadas» embora a funcionalidade exista noutras rotas (equipas e centros de custo na Organização, fluxos e regras/automações, entidades, numeração/impostos nas Configurações) | C03/C07/C09/C12–C15 | Média (UX enganadora) | Aberta |
| A-02 | Cancelar a encomenda a fornecedor é recusado depois de uma recepção parcial; a especificação pede cancelar o restante preservando a recepção | M06 | Média (desvio da spec) | Aberta |
| A-03 | Critérios sem teste automático: alteração do NIF/cliente depois de emitir a factura (C08.3, M05.2), falha depois de numerar (M05.1), orçamento de avaliação de regras (C12.1), transição inexistente → 409 (C13.1), regras e documentos emitidos (C12.3) | C08/C12/C13/M05 | Média | Aberta |
| A-04 | Crédito do cliente, saldo e recebível não existem (dependem de M09): critérios M01.3, M05.3 e a reserva de crédito de M04 | M01/M04/M05 | Alta (bloqueia fluxo order-to-cash) | Aberta — depende de M09 |
| A-05 | Três vias (encomenda–recepção–factura do fornecedor), contas a pagar e cotações | M06/M09 | Alta | Aberta — depende de M09 |
| A-06 | Devoluções, transferências e inventários físicos | M07/M08 | Alta | Aberta |
| A-07 | UI de auditoria, exportação e retenção; sem backup/restauro | S06 | Média | Aberta |
| A-08 | Catálogo: edição de variantes e itens de preço na UI, desactivação de categorias | M03 | Média | Aberta |
| A-09 | Contactos e moradas da Party não editáveis; sem fusão | C08 | Baixa | Aberta |
| A-10 | Scripts E2E fora do repositório e do CI | transversal | Média | Aberta |
| A-11 | Sem notificações (S02), documentos/PDF (S01), relatórios/exportações (S04): workflows, automações, campanhas e documentos emitidos dependem deles | transversal | Alta | Aberta |
| A-12 | Sem MFA/SSO e sem fornecedor de email (decisão de produto D-021) | C04 | Média | **Bloqueada** por decisão de produto |

## 5. Ordem de desenvolvimento (por dependências)

1. **Reconciliação das capacidades (A-01)** e testes em falta (A-03), correcção do cancelamento (A-02): fecham inconsistências sem dependências.
2. **M09 Tesouraria, contas a receber e a pagar** (cria o recebível ao emitir, o pagável da factura do fornecedor, o saldo e a exposição de crédito; resolve A-04/A-05).
3. **M08 Transferências, inventários físicos e devoluções** (resolve A-06).
4. **M02 CRM comercial.**
5. **S02 Notificações → S01 Documentos/PDF → S04 Relatórios/Exportações → S03 Calendário → S05 Integrações → S06 UI/recuperação.**
6. **M10 → M11 → M12 → M13 → M14.**
7. **V01–V06** só depois do núcleo.

O estado vivo e o registo de execução estão em `docs/PROGRESS.md`.

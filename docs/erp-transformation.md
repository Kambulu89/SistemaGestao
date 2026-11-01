# Transformação em ERP empresarial integrado — diagnóstico, arquitectura e plano

Documento da primeira entrega do pedido «Transformação do sistema existente num ERP empresarial integrado» (31/10/2026),
sobre o commit `1d8060e` do branch `claude/pensive-clarke-5gm075`. Complementa — não substitui — a especificação
[`especificacao-v2.docx`](especificacao-v2.docx), a auditoria [`MODULE_AUDIT.md`](MODULE_AUDIT.md) e os critérios
[`MODULE_COMPLETION.md`](MODULE_COMPLETION.md). A decisão de âmbito correspondente é a **D-062** em [`decisions.md`](decisions.md).

Legenda usada em todo o documento: **Existe** (implementado e testado, reutiliza-se tal como está) · **Alterar** (existe e
precisa de ser estendido ou corrigido) · **Novo** (desenvolvimento de raiz).

---

## 0. Divergência com a especificação (assinalada antes de tudo)

O `CLAUDE.md` manda seguir a especificação v2 e assinalar qualquer divergência. O pedido actual diverge em dois pontos:

| Ponto | Especificação v2 | Pedido actual | Proposta (D-062) |
| ----- | ---------------- | ------------- | ---------------- |
| Contabilidade | M10: «não chamar “contabilidade completa” à tesouraria: plano de contas, diários, encerramento e obrigações legais são **módulo adicional com especificação própria**» | Contabilidade geral completa (plano de contas, diários, razão, balancete, activos, depreciações, demonstrações) | Aceitar como **módulo adicional** `accounting`, com a especificação própria escrita na secção 8 deste documento; a tesouraria (M09) continua a ser a fonte do dinheiro e passa a **originar** lançamentos, nunca a ser substituída por eles. |
| Processamento salarial | M12: «Payroll permanece feature desactivada até especificação própria validada» | Remunerações, processamento salarial, pagamento e contabilização | Aceitar como funcionalidade `hr.payroll` com especificação própria (secção 8, fase E6), **desligada por omissão** até as regras fiscais e de segurança social angolanas serem confirmadas por quem tem essa competência. |

Tudo o resto do pedido cabe nos módulos M01–M14 e S01–S06 da especificação, que já estão parcialmente implementados.
Nenhuma conformidade fiscal angolana (SAF-T AO, certificação de software pela AGT, assinatura de documentos, IRT/INSS) é
dada como feita: a arquitectura prepara-a (secção 3.6) e as fases dizem quando é verificada.

---

## 1. Diagnóstico técnico do projecto actual

### 1.1 Stack e organização

| Camada | Tecnologia | Organização |
| ------ | ---------- | ----------- |
| Frontend | Angular 22 (standalone, signals, `rxResource`), Tailwind 4, Vitest | `src/app/{core,shared,layouts,features}`; módulos de negócio declarados por **manifesto** (`defineModule`) que gera rotas, menu e permissões; design system em `shared/ui` (24 componentes) |
| Backend | AdonisJS 6, TypeScript estrito, Lucid/knex com SQL parametrizado, VineJS | **Monólito modular**: `app/core` (13 núcleos), `app/platform` (4), `app/dynamic` (6, low-code), `app/modules` (12 de negócio); cada módulo com `domain/application/infrastructure/presentation` e API pública em `index.ts` |
| Dados | PostgreSQL 16 com **RLS forçada**, 126 tabelas de tenant, 39 migrations; Redis (sessões, limites) | FKs compostas `(tenant_id, id)`, auditoria por trigger em `audit_logs` imutável, outbox transaccional, decimais `numeric(19,4)`/`(19,6)` |
| Qualidade | Testes de arquitectura (fronteiras de módulos), de esquema (isolamento), **matriz de isolamento** por rota e tabela, paridade OpenAPI | Backend 893 testes, frontend 1150; E2E em browser por fatia (scripts locais) |

### 1.2 Pontos fortes que a transformação aproveita

- **Multi-tenant real e seguro**: o tenant é a fronteira; RLS + filtros + autorização; `tenant_id` do cliente é só selector.
- **Multiempresa já existe**: `organizations` (empresas) e `organization_units` (estabelecimentos/departamentos em árvore)
  dentro de cada tenant; documentos, armazéns, contas e sequências já são por organização.
- **Autorização granular**: RBAC + ABAC no servidor, campos sensíveis escondidos por política, simulador, âmbitos por unidade.
- **Consistência**: transacções com bloqueios, `expectedVersion`/409, idempotência por chave e por origem
  (`source_key` únicos), documentos emitidos imutáveis por trigger, reversões explícitas, outbox + inbox.
- **Integrações já automáticas entre módulos** (ganchos públicos `registerOrderEffects`, `registerInvoiceEffects`):
  encomenda confirmada reserva stock e crédito; expedição baixa stock; factura emitida cria recebível; factura de fornecedor
  validada cria pagável com conferência a três vias; recepção dá entrada de stock ao custo da encomenda.
- **Low-code governado** (entidades, formulários, regras AST, estados, workflows de aprovação, automações) e serviços
  transversais (notificações, documentos/PDF, relatórios e exportações, pesquisa, calendário).

### 1.3 Lacunas funcionais face ao ERP pedido

| Área | Lacuna |
| ---- | ------ |
| Contabilidade | **Inexistente**: sem plano de contas, exercícios, diários, lançamentos, razão, balancete, activos ou demonstrações. Nenhum módulo gera lançamentos. |
| Recursos humanos | **Inexistente no backend** (M11/M12 não iniciados): o frontend só tem capacidades de catálogo (`hr.employees`, `hr.attendance`, `hr.talent`) que levam a ecrãs de módulo por contratar. |
| Assiduidade, salários, avaliação | Inexistentes (dependem de RH). |
| Compras | Faltam pedidos de cotação (RFQ) e comparação de propostas; devoluções a fornecedor existem só como devolução de stock (M08). |
| Facturação | Faltam notas de débito, recibos (como documento fiscal ligado ao pagamento) e séries fiscais com assinatura; as notas de crédito existem. |
| Inventário | Faltam números de série, níveis mínimos/pontos de encomenda e valorização em relatório (o custo médio existe no livro). |
| Finanças | Faltam orçamentos e execução orçamental (M10), fluxo de caixa e projecções. |
| Interface | Falta sidebar recolhível em ecrãs largos, dashboard executivo com dados reais (o painel do tenant ainda não usa os indicadores do S04), pesquisa global no topo (existe página `Pesquisa`). |

### 1.4 Conflitos e duplicações identificados

- **Capacidades duplicadas no catálogo do frontend**: `business/organization` repete funções já cobertas pela página
  «Organização» do tenant; a sidebar mostra entradas «Dados» repetidas quando há entidades dinâmicas homónimas (ex.: várias
  «Despesas»). Resolver na fase E1 (navegação) sem apagar dados: agrupar por módulo e esconder duplicados.
- **Pessoa vs colaborador vs utilizador**: a especificação já separa `User` (global), `TenantMembership` e `Person` (Party). O RH
  **não** deve criar uma tabela de pessoas própria: `Employee` referencia `person_id` (Party) e, opcionalmente, `membership_id`.
- **Centros de custo**: existem em `cost_centers` (C07). A contabilidade usa-os como dimensão analítica; não cria os seus.
- **Impostos e sequências**: existem em C09 (`tax_rates`, `sequences`). A contabilidade e a facturação reutilizam-nos.
- **Orçamento**: a M10 da especificação (orçamento operacional por centro de custo) e o orçamento financeiro do pedido são o
  mesmo conceito — um só módulo `budgeting` (fase E5).

---

## 2. Inventário de funcionalidades reaproveitáveis

| Funcionalidade do ERP | Já existe (módulo, decisão) | Estado para o ERP |
| --------------------- | --------------------------- | ----------------- |
| Empresas, estabelecimentos, departamentos, centros de custo, equipas | C07 `core/organization` (D-0xx) | **Existe** — departamentos = unidades de tipo `DEPARTMENT` |
| Utilizadores, grupos (papéis), perfis e permissões, simulador | C04–C06 | **Existe** |
| Parametrizações, impostos, unidades, séries/sequências | C09 `core/settings` | **Alterar** — acrescentar parâmetros contabilísticos (contas por omissão) via regras de contabilização |
| Fluxos de aprovação, delegações | C14 `dynamic/workflows` (D-044) | **Existe** — usar para requisições, férias, ocorrências, despesas |
| Auditoria | S06 mínimo `core/audit` | **Existe** |
| Notificações | S02 (D-058) | **Existe** |
| Gestão documental, PDF | S01 (D-059) | **Existe** |
| Relatórios, painéis, exportação CSV, pesquisa | S04 (D-060) | **Alterar** — novos datasets (razão, balancete, RH, assiduidade) |
| Calendários, horário útil, feriados | S03 (D-061) | **Existe** — base de horários/turnos da assiduidade |
| Produtos, serviços, categorias, preços | M03 `modules/catalog` | **Existe** |
| Armazéns, localizações, lotes, movimentos, custo médio, reservas | M07 `modules/inventory` (D-050) | **Alterar** — números de série, mínimos, relatório de valorização |
| Transferências, contagens, ajustes, devoluções | M08 (D-055) | **Existe** |
| Clientes, propostas, encomendas, expedições | M01, M04 | **Existe** |
| Facturas, notas de crédito, contratos | M05 `modules/invoicing` (D-052) | **Alterar** — notas de débito, recibos, séries fiscais/hash (fase E3) |
| Fornecedores, requisições, encomendas, recepções | M06 `modules/procurement` (D-053) | **Alterar** — RFQ e comparação de propostas (fase E3) |
| Caixas e bancos, contas a receber/pagar, pagamentos, facturas de fornecedor, conciliação | M09 `modules/finance` (D-054, D-056) | **Existe** — passa a originar lançamentos |
| Leads e oportunidades | M02 (D-057) | **Existe** (fora dos 8 módulos, mantém-se) |

---

## 3. Arquitectura proposta para o ERP

### 3.1 Princípios

1. **Evoluir, não reconstruir**: mesma stack, mesmo monólito modular, mesmos padrões (`createTenantTable`,
   `LucidTenantDatabase.run`, API pública por `index.ts`, outbox).
2. **Um dono por dado**: cada módulo escreve só nas suas tabelas; outros módulos usam a sua API pública ou eventos.
3. **A contabilidade é consumidora**: os módulos operacionais publicam factos (factura emitida, pagamento confirmado,
   recepção lançada, salário processado); a contabilidade transforma-os em lançamentos pelas **regras de contabilização**
   configuradas por empresa. Os módulos de origem não conhecem contas.
4. **Idempotência por origem**: todo o lançamento automático tem `source_key` único (ex.: `invoice:<id>:issued`); repetir o
   evento devolve o lançamento existente. Reverter cria um lançamento inverso, nunca apaga.
5. **Partidas dobradas garantidas na base de dados**: um lançamento lançado (`POSTED`) só fica gravado se débitos = créditos
   (trigger de restrição diferida) e torna-se imutável.
6. **Dados sensíveis protegidos**: salários, NIF pessoal, IBAN e dados de saúde são campos sensíveis (ABAC `hiddenFields` e
   permissões próprias como `salary.read`), redigidos na auditoria.

### 3.2 Domínios e módulos (backend)

```
core/        tenancy · auth · members · permissions · organization · party · settings · audit · outbox · decimal
platform/    tenants · billing · modules · administration
dynamic/     metadata · forms · rules · states · workflows · automations
modules/
  accounting   (Novo)  plano de contas, exercícios, diários, lançamentos, razão, balancete, regras, activos, demonstrações
  hr           (Novo)  colaboradores, cargos, contratos, histórico, documentos, férias/licenças, benefícios, recrutamento
  attendance   (Novo)  horários, turnos, picagens, ocorrências, justificações, fecho mensal para salários
  payroll      (Novo)  rubricas, processamento, recibos de vencimento, pagamento, contabilização (feature desligada por omissão)
  performance  (Novo)  ciclos, modelos, critérios, competências, objectivos/KPI, avaliações, 360°, calibração, PDI
  budgeting    (Novo)  orçamentos, compromissos, execução, despesas, fluxo de caixa e projecções
  catalog · inventory · orders · invoicing · procurement · finance · customers · prospecting   (Existem; alguns Alterar)
  notifications · documents · reporting · calendar                                              (Existem)
```

### 3.3 Integração entre módulos

- **Síncrona e atómica** quando a regra de negócio o exige na mesma transacção (já usado: reservas de stock e crédito).
- **Por outbox** para efeitos derivados (contabilização, notificações, relatórios): o evento é gravado na mesma transacção da
  operação; o consumidor da contabilidade é idempotente (inbox por `consumer + event_id`, já existente).
- Os lançamentos automáticos ficam em `PENDING_RULE` se faltar regra de contabilização (nunca contas «por adivinhar»); o ecrã
  de pendências mostra-os e permite repetir depois de configurar.

### 3.4 Frontend

- Um **manifesto por módulo** (padrão existente) com submódulos como capacidades; páginas com separadores; formulários em
  diálogos/rotas com grupos; tabelas do design system com ordenação, filtros e paginação do servidor.
- **Layout ERP**: sidebar agrupada por domínio (Vendas, Compras, Inventário, Finanças, Contabilidade, Pessoas, Administração),
  recolhível; breadcrumbs (existem); pesquisa global no cabeçalho (reutiliza `/search`); tema claro/escuro (existe
  `ThemeService`); painel executivo com widgets do S04.

### 3.5 Segurança e dados pessoais

Permissões por módulo e acção (`accounting.*`, `employee.*`, `salary.read`, `attendance.*`, `payroll.*`, `review.*`); ABAC por
unidade (gestor vê a equipa); campos sensíveis com `hiddenFields`; auditoria com colunas redigidas; exportações revalidadas
(S04). Recibos de vencimento só visíveis ao próprio e a quem tem `payroll.read`.

### 3.6 Preparação para conformidade angolana (sem a presumir)

- Plano de contas com **classes 1 a 8** do PGC angolano como estrutura de partida (modelo editável; validação por contabilista).
- Campos e chaves preparados para **SAF-T (AO)**: NIF de cliente/fornecedor (já na Party), séries e numeração sem lacunas
  (C09), hash/assinatura dos documentos de venda (fase E3), identificação de lançamentos por diário e número.
- IVA e retenções a partir de `tax_rates` (C09). IRT e INSS como rubricas de salário **configuradas**, nunca fixas no código.
- Nenhuma destas peças é declarada «certificada» até haver verificação externa.

---

## 4. Mapa dos módulos e submódulos

| Módulo do ERP | Submódulos | Origem |
| ------------- | ---------- | ------ |
| **1. Contabilidade** | Plano de contas · Exercícios e períodos · Diários · Lançamentos (manuais e automáticos) · Razão · Balancete · Regras de contabilização · Centros de custo (C07) · Reconciliações (M09) · Activos fixos e depreciações · Demonstrações financeiras (balanço, resultados) · Encerramento | Novo (E1, E2, E7) |
| **2. Recursos Humanos** | Estrutura (C07) · Cargos · Colaboradores · Contratos · Histórico laboral · Documentos (S01) · Férias e licenças · Benefícios · Recrutamento · Remunerações e processamento salarial | Novo (E4, E6) |
| **3. Inventário** | Produtos/serviços/categorias/unidades (M03, C09) · Armazéns e localizações · Entradas/saídas/transferências/ajustes · Contagens · Lotes · Números de série · Níveis mínimos · Valorização · Rastreabilidade | Existe + Alterar (E3) |
| **4. Compras** | Fornecedores · Requisições · Pedidos de cotação · Comparação de propostas · Ordens de compra · Aprovações (C14) · Recepções · Devoluções · Facturas de fornecedor · Acompanhamento | Existe + Alterar (E3) |
| **5. Facturação** | Clientes · Propostas/orçamentos · Encomendas · Facturas · Séries · Impostos · Descontos · Recibos · Notas de crédito · Notas de débito · Contas a receber | Existe + Alterar (E3) |
| **6. Finanças** | Caixas e bancos · Movimentos · Pagamentos e recebimentos · Contas a pagar/receber · Conciliação · Orçamento e execução · Fluxo de caixa · Projecções | Existe + Novo (E5) |
| **7. Assiduidade** | Calendários (S03) · Horários · Turnos · Picagens · Faltas e atrasos · Horas extraordinárias · Justificações · Aprovação · Relatórios · Fecho para salários | Novo (E5) |
| **8. Avaliação de desempenho** | Ciclos e períodos · Modelos · Critérios e competências · Escalas e ponderações · Objectivos e KPI · Autoavaliação · Avaliação hierárquica · 360° · Calibração · Planos de desenvolvimento · Relatórios comparativos | Novo (E6) |
| Administração (transversal) | Empresas e estabelecimentos · Departamentos · Utilizadores e grupos · Perfis e permissões · Parâmetros · Fluxos de aprovação · Auditoria · Notificações · Gestão documental · Parâmetros fiscais e contabilísticos | Existe + Alterar (parâmetros contabilísticos em E1) |

---

## 5. Matriz de integração entre os oito módulos

Cada célula diz o que a **linha** fornece à **coluna** (vazio = sem integração directa). «Ev.» = por evento de outbox;
«Sínc.» = na mesma transacção.

| De ↓ / Para → | Contabilidade | RH | Inventário | Compras | Facturação | Finanças | Assiduidade | Avaliação |
| ------------- | ------------- | -- | ---------- | ------- | ---------- | -------- | ----------- | --------- |
| **Contabilidade** | — | | | | | Plano de contas para tesouraria (conta por caixa/banco) | | |
| **RH** | Custos com pessoal (via salários) | — | | | | Pagamento de salários (pagável) | Colaborador, contrato, horário | Colaborador, gestor, cargo |
| **Inventário** | Ev. entradas/saídas valorizadas (custo das vendas, existências) | | — | Sínc. stock recebido | Sínc. stock expedido | | | |
| **Compras** | Ev. factura de fornecedor (custo/IVA/fornecedor) | | Sínc. recepção → entrada de stock | — | | Sínc. factura validada → pagável | | |
| **Facturação** | Ev. factura/nota emitida (cliente/proveito/IVA) | | Sínc. expedição → saída | | — | Sínc. factura → recebível | | |
| **Finanças** | Ev. pagamento/recebimento confirmado e revertido | | | | | — | | |
| **Assiduidade** | | Ocorrências no histórico | | | | | — | Assiduidade como indicador |
| **Avaliação** | | PDI e histórico | | | | | | — |

Processos ponta a ponta exigidos (e fase em que ficam verificados):

| Processo | Elos já existentes | Elos novos | Fase |
| -------- | ------------------ | ---------- | ---- |
| Compra aprovada → recepção → inventário → obrigação financeira → contabilidade | requisição aprovada, encomenda, recepção com entrada de stock, factura validada → pagável | lançamentos de recepção (existências/fornecedor a facturar), factura (fornecedor/IVA), pagamento | E2 |
| Venda → facturação → inventário → contas a receber → recebimento → contabilidade | encomenda, expedição com saída, factura → recebível, pagamento confirmado | lançamentos de factura, custo das vendas, recebimento, notas de crédito | E2 |
| Colaborador → contrato → assiduidade → processamento salarial → pagamento → contabilização | — | todos | E4–E6 |
| Colaborador → objectivos → avaliação → plano de desenvolvimento | — | todos | E6 |
| Despesas → tesouraria → contabilidade → relatórios financeiros | pagamentos e tesouraria | despesas (M10), lançamentos, demonstrações | E5, E7 |

---

## 6. Modelo conceptual das principais entidades

Entidades **existentes** (reutilizadas): Tenant · Organization (empresa) · OrganizationUnit (estabelecimento/departamento) ·
CostCenter · TenantMembership · Party/Person/OrganizationParty · TaxRate · Sequence · Product/Variant · Warehouse/Location/Lot ·
StockMovement · Customer · SalesOrder · Shipment · Invoice/CreditNote · Supplier · PurchaseOrder · GoodsReceipt ·
SupplierInvoice · TreasuryAccount · Receivable/Payable · Payment/Allocation · TreasuryEntry · BusinessCalendar.

Entidades **novas** (resumo; detalhe na fase respectiva):

```
Organization 1─* LedgerAccount (código, classe, natureza, tipo HEADER|POSTING, pai, exige centro de custo/terceiro)
Organization 1─* FiscalYear 1─* FiscalPeriod (OPEN|CLOSED)
Organization 1─* Journal (GERAL, VENDAS, COMPRAS, TESOURARIA, SALÁRIOS, ABERTURA, APURAMENTO)
Journal 1─* JournalEntry (DRAFT|POSTED|REVERSED; nº por diário e exercício; source_key único) 1─* JournalLine
JournalLine *─1 LedgerAccount, *─0..1 CostCenter, *─0..1 Party
Organization 1─* PostingRule (evento + papel → conta, diário)
Organization 1─* FixedAsset 1─* DepreciationEntry → JournalEntry

Person (Party) 1─0..1 Employee ─* EmploymentContract, ─* JobHistory, ─* EmployeeDocument (S01)
Employee *─1 Position (cargo) *─1 OrganizationUnit (departamento); Employee *─0..1 Employee (gestor)
Employee ─* LeaveRequest / LeaveBalanceEntry; ─* BenefitEnrollment
WorkSchedule ─* Shift; Employee ─* ShiftAssignment; Employee ─* ClockEvent; AttendanceDay (derivado) ─* Occurrence (falta, atraso, HE) ─ Justification
PayrollRun (período) ─* Payslip (Employee) ─* PayslipLine (PayrollItem: rubrica com fórmula AST) → Payable (salários) → JournalEntry
ReviewCycle ─* PerformanceReview (Employee) ─* ReviewAnswer; ReviewTemplate(versão) ─* Criterion/Competency; Goal ─* KeyResult; DevelopmentPlan ─* Action
Budget ─* BudgetLine (CostCenter, conta/categoria) ─* BudgetCommitment; ExpenseClaim ─* ExpenseLine
```

---

## 7. Estrutura de navegação e proposta de interface

```
Painel executivo (KPI: vendas, cobranças, pagamentos, stock crítico, resultados, pessoas)
Vendas        Clientes · Propostas e encomendas · Expedições · Facturação · Recibos e notas · Contas a receber
Compras       Fornecedores · Requisições · Cotações · Encomendas · Recepções · Facturas de fornecedor
Inventário    Produtos e serviços · Armazéns e stock · Movimentos · Transferências · Contagens · Devoluções · Valorização
Finanças      Caixas e bancos · Pagamentos · Contas a pagar · Conciliação · Orçamentos · Fluxo de caixa
Contabilidade Plano de contas · Lançamentos · Razão · Balancete · Exercícios e períodos · Regras · Activos · Demonstrações
Pessoas       Colaboradores · Contratos · Férias e licenças · Assiduidade · Salários · Avaliação · Recrutamento
Agenda        Calendário e reservas
Documentos · Relatórios e painéis · Pesquisa · Notificações · Aprovações
Administração Empresas e estabelecimentos · Utilizadores · Permissões · Configurações · Módulos · Plano · Auditoria
```

Padrões de ecrã: lista (tabela com filtros e paginação do servidor) → detalhe com separadores (geral, linhas, histórico,
documentos, auditoria) → acções de estado explícitas (Lançar, Reverter, Aprovar) com confirmação. Estados de carregamento,
vazio, erro e sucesso já existem no design system (`LoadingState`, `EmptyState`, `Alert`). Formulários: validação no cliente
para orientar e no servidor para decidir, com erros por campo.

---

## 8. Plano de execução faseado

Cada fase é uma ou mais fatias verticais (migration + domínio + API + UI + autorização + auditoria + testes + E2E + docs), com
o projecto compilável e todos os testes verdes no fim de cada fatia. As fases E2–E7 só começam a pedido.

### E0 — Diagnóstico e plano (esta entrega) — **concluída**
Este documento e a decisão D-062.

### E1 — Fundação contabilística (concluída; ver D-063)
1. **Objectivos**: dar ao ERP um núcleo contabilístico de partidas dobradas, multiempresa, idempotente e auditável, pronto a
   receber lançamentos automáticos dos outros módulos.
2. **Funcionalidades**: plano de contas em árvore com modelo de classes do PGC; exercícios com períodos mensais, fecho e
   reabertura de período; diários; lançamentos manuais (rascunho → lançado → revertido); motor de lançamentos automáticos
   idempotente por `source_key`; regras de contabilização (evento + papel → conta); razão por conta com saldo acumulado;
   balancete por intervalo de datas.
3. **Ecrãs**: Contabilidade › Plano de contas · Exercícios e períodos · Diários · Lançamentos (lista, editor de linhas, detalhe)
   · Razão · Balancete · Regras de contabilização.
4. **Campos**: Conta (empresa, código, nome, natureza, tipo, conta-mãe, exige centro de custo, exige terceiro, activa);
   Exercício (empresa, código, início, fim); Período (número, início, fim, estado); Diário (empresa, código, nome, tipo);
   Lançamento (empresa, diário, data, descrição, linhas: conta, débito, crédito, descrição, centro de custo, terceiro);
   Regra (empresa, evento, papel, conta, diário).
5. **Entidades**: `ledger_accounts`, `fiscal_years`, `fiscal_periods`, `journals`, `journal_entries`, `journal_lines`,
   `posting_rules` (todas de tenant, por organização, FKs compostas, auditadas).
6. **Regras de negócio**: débitos = créditos e pelo menos duas linhas; cada linha só débito ou só crédito, positivo; só contas de
   movimento activas; centro de custo/terceiro quando a conta os exige; data dentro de um período **aberto** do exercício;
   numeração sequencial sem lacunas por diário e exercício atribuída só ao lançar; lançado é imutável (trigger) e só se anula
   por lançamento inverso numa data em período aberto; exercícios da mesma empresa não se sobrepõem; fechar período impede
   novos lançamentos nele; o mesmo `source_key` nunca gera dois lançamentos.
7. **Permissões**: `accounting.read` (consultar), `accounting.manage` (plano, exercícios, diários, regras), `journal.post`
   (criar e lançar), `journal.reverse` (reverter), `period.close` (fechar e reabrir períodos).
8. **APIs**: `/ledger-accounts`, `/fiscal-years`, `/fiscal-periods/:id/close|reopen`, `/journals`, `/journal-entries`,
   `/journal-entries/:id/post|reverse`, `/ledger?accountId&from&to`, `/trial-balance?organizationId&from&to`,
   `/posting-rules`; serviço público `accountingServices().posting.post(...)` para os outros módulos.
9. **Base de dados**: migration 39 com as 7 tabelas, triggers de imutabilidade e de equilíbrio (restrição diferida), exclusão
   de sobreposição de exercícios.
10. **Integrações**: só o motor e as regras nesta fase; os produtores entram em E2.
11. **Critérios de aceitação**: (a) lançamento desequilibrado nunca fica lançado, nem por SQL directo; (b) repetir a mesma
    origem não duplica o lançamento; (c) lançado não se altera e a reversão repõe o saldo; (d) período fechado recusa
    lançamentos; (e) balancete com totais de débito e crédito iguais e saldos iguais aos do razão.
12. **Testes**: unitários do domínio (equilíbrio, numeração, árvore, períodos); funcionais (fluxos, concorrência de numeração e
    de idempotência, permissões, isolamento, SQL directo contra os triggers); frontend; E2E.
13. **Dependências e riscos**: depende de C07 (organizações, centros de custo) e C08 (Party). Risco: o modelo de plano de contas
    não substitui a validação por um contabilista angolano.

### E2 — Contabilização automática dos módulos existentes
Produtores: factura emitida e nota de crédito (cliente, proveitos por linha, IVA), custo das vendas na expedição (existências
ao custo médio), recepção de compra (existências / fornecedores c/ facturas em recepção), factura de fornecedor validada,
pagamentos e recebimentos confirmados e revertidos, movimentos de tesouraria entre contas. Ecrã de pendências (`PENDING_RULE`).
Aceitação: os dois processos ponta a ponta da secção 5 produzem lançamentos equilibrados, uma só vez, com referência à origem.

### E3 — Completar Facturação, Compras e Inventário
Notas de débito, recibos, séries fiscais com hash encadeado (preparação SAF-T), descontos por linha/documento; pedidos de
cotação e comparação de propostas; números de série, níveis mínimos e alertas, relatório de valorização.

### E4 — Recursos humanos (núcleo)
Cargos, colaboradores (sobre Person, sem conta obrigatória), contratos com salário restrito, histórico laboral, documentos,
férias e licenças com livro de saldos, benefícios, recrutamento (vagas e candidaturas). Critérios da especificação M11.

### E5 — Assiduidade e Finanças avançadas
Horários e turnos (sobre S03), picagens, apuramento diário (faltas, atrasos, horas extraordinárias), justificações com
aprovação (C14), fecho mensal para salários; orçamentos (M10), compromissos, despesas, fluxo de caixa e projecções.

### E6 — Processamento salarial e Avaliação de desempenho
Rubricas configuráveis (fórmulas AST, sem código do tenant), processamento por período com recibos, aprovação, pagável de
salários e contabilização; ciclos, modelos versionados, critérios, competências, objectivos/KPI, auto e heteroavaliação, 360°,
calibração com motivo, planos de desenvolvimento e relatórios comparativos (critérios M12).

### E7 — Activos fixos, encerramento e demonstrações
Activos, planos de depreciação e lançamentos periódicos idempotentes, apuramento de resultados e encerramento do exercício,
balanço e demonstração de resultados, exportação SAF-T (verificação externa obrigatória antes de se declarar conforme).

### E8 — Experiência ERP
Sidebar recolhível agrupada por domínio, painel executivo com dados reais, pesquisa global no cabeçalho, dashboards por módulo,
revisão de acessibilidade e de responsividade.

---

## 9. O que existe, o que se altera e o que é novo (resumo)

| Estado | Itens |
| ------ | ----- |
| **Existe** | Multi-tenant e multiempresa, identidade, permissões, organização, Party, parâmetros, low-code, auditoria, notificações, documentos, relatórios, calendário, catálogo, inventário e logística de stock, vendas, facturação base, compras base, tesouraria e conciliação |
| **Alterar** | Facturação (notas de débito, recibos, séries fiscais), compras (cotações), inventário (séries, mínimos, valorização), relatórios (novos datasets), navegação (sidebar e painel executivo), parâmetros (contabilísticos) |
| **Novo** | Contabilidade, RH, assiduidade, processamento salarial, avaliação de desempenho, orçamentos e fluxo de caixa, activos fixos, demonstrações |

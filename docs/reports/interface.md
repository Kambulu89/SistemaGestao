# Interface profissional do ERP SaaS — relatório por bloco

## UI-1 — Design system "Corporate Blue", AppShell, navegação, paleta, favoritos e painel

**Ecrãs e peças**

- Identidade Corporate Blue nos dois temas (tokens em `frontend/src/styles.css`), Inter auto-alojada; teste de
  contraste alargado às cores de estado e à cor interactiva.
- AppShell: sidebar por domínios com secções e favoritos; barra superior com empresa, entidade legal/filial, pesquisa
  ("/"), paleta de comandos (Ctrl+K), centro de aprovações, notificações e conta; trilho com estrela de favorito.
- Paleta de comandos: favoritos, recentes, ecrãs autorizados, acções e registos do servidor.
- Painel personalizável: blocos visíveis e ordem por membro, com o bloco "Favoritos e recentes".
- Componentes novos: `Kpi` (KPIWidget/SummaryCard) e `AccessDenied`; ícones novos.

**APIs**

- Novas: `GET/PUT /api/v1/me/preferences/favorites`, `GET/PUT /api/v1/me/preferences/dashboard` (tabela
  `member_preferences`, migração `0021`).
- Usadas: `/dashboard`, `/me/tasks`, `/search`, contexto da empresa (permissões e funcionalidades).

**Testes e evidências**

- Backend: `tests/functional/preferences.spec.ts` (guardar/normalizar, valores inválidos 422, chave desconhecida 404,
  isolamento por membro e por empresa); `routes_protection` com justificação das rotas novas.
- Frontend: `navigation.spec.ts` (domínios, secções filtradas), `personal.spec.ts`, `dashboard-layout.spec.ts`,
  `command-palette.spec.ts`, `contrast.spec.ts`.
- Browser (Playwright, dev): fonte e tokens aplicados, sidebar por domínios, favorito persistido, paleta (pesquisa sem
  acentos, Enter, acção de tema, Escape), painel personalizado persistido após recarregar, gaveta em 390 px sem
  deslocamento horizontal; sem erros de consola.

**Pendências**

- Modelos de ecrã (EntityListPage, EntityCreatePage/EditPage, EntityDetailPage, ApprovalWorkflowPage, ReportPage,
  SettingsPage, WizardPage, CalendarPage, KanbanPage, DocumentPreviewPage) e a sua aplicação aos módulos existentes.
- Componentes ainda por criar ou alargar: SearchAndFilterBar, configuração de colunas e exportação no DataTable
  avançado, DetailDrawer, ApprovalTimeline dedicada, NotificationCenter em painel lateral, rascunhos de formulário.
- Domínios sem módulos (Operações Comerciais, Pessoas e Talento, Operações Empresariais, Inteligência e Automação)
  ficam fora da navegação até existirem backend e ecrãs reais.

## UI-2 — Modelos de ecrã, filtros, colunas, vista rápida e rascunhos

**Ecrãs**

- Membros e Lançamentos passam a EntityListPage: filtros e ordenação na URL, etiquetas de filtros, colunas
  configuráveis, exportação das colunas visíveis; Lançamentos ganha intervalo de datas, ordenação no servidor e vista
  rápida (gaveta) com as linhas.
- Criar registos organizacionais passa a EntityCreatePage com rascunho local e barra de acções fixa.
- Configurações da empresa passa a SettingsPage (índice de secções, barra de guardar fixa).
- Formulário de lançamento com rascunho local (recuperar/descartar).

**APIs**

- Alterada: `GET /api/v1/accounting/entries` aceita `dateFrom`, `dateTo`, `sort` (`entryDate`, `number`,
  `totalDebit`, `status`, `journalCode`) e `direction`; valores fora da lista são 422.
- Usadas: `members`, `accounting/entries`, `accounting/entries/:id`, `accounting/journals`, `organization/*`,
  `settings`.

**Correcção**

- O formulário de registos organizacionais pedia `members?limit=200` (máximo 100): com `members.read`, criar ou abrir
  departamentos, entidades e centros de custo falhava. Passou a 100.

**Testes e evidências**

- Backend: `accounting.spec.ts` (ordenação, intervalo de datas, 422 para campo ou data inválidos).
- Frontend: `list-state.spec.ts`, `templates.spec.ts` (colunas, etiquetas, rascunhos, valores).
- Browser: filtros/ordenação na URL e após recarregar, pesquisa com espera, colunas (esconder, persistir, obrigatória,
  repor), datas e ordenação nos lançamentos, gaveta com linhas e Escape, rascunho recuperado e descartado após
  recarregar, índice das configurações, 390 px sem deslocamento horizontal; sem erros de consola.

**Pendências**

- Modelos ApprovalWorkflowPage, ReportPage, WizardPage, CalendarPage, KanbanPage e DocumentPreviewPage (UI-3).
- Aplicar EntityListPage às restantes listas (organização, perfis, auditoria, contabilidade) e EntityFormPage aos
  restantes formulários; NotificationCenter em painel lateral; ApprovalTimeline dedicada.

## UI-3 — Aprovação, relatório, assistente, calendário, kanban, pré-visualização e centro de notificações

**Ecrãs**

- Pedido de aprovação (ApprovalWorkflowPage): resumo, decisão, etapas e linha temporal (criação, decisões com autor,
  delegação e comentário, conclusão ou etapa em espera).
- Balancete (ReportPage): estado vazio antes de gerar, metadados (parâmetros e hora) também na impressão, CSV e
  impressão/PDF.
- Encerramento do exercício (WizardPage): Verificação → Conta e diário → Rever e encerrar.
- Calendário da empresa (CalendarPage): mês com descanso, feriados e dias úteis calculados pelo servidor.
- Tarefas de fecho (KanbanPage): Por fazer / Feitas, por arrastar ou botões acessíveis.
- Anexos: Pré-visualizar (DocumentPreviewPage) para PDF, imagens e texto.
- Notificações: centro em gaveta lateral.

**APIs usadas** (sem rotas novas): `approvals/requests/:id`, `accounting/trial-balance`,
`accounting/fiscal-years/:id/close`, `accounting/periods/:id/tasks`, `accounting/close-tasks/:id`, `calendars/:id`,
`calendars/:id/working-days`, `attachments/:id/content`, `me/notifications` (`unread`), `me/notifications/:id/read`,
`me/notifications/read-all`.

**Testes e evidências**

- Frontend: `templates3.spec.ts` (grelha do mês, mudança de mês, tipos pré-visualizáveis, linha temporal).
- Browser: tarefa movida para Feitas e aviso da checklist resolvido; assistente bloqueia sem conta de resultado,
  revisão com os parâmetros e exercício encerrado; balancete com estado vazio e metadados; calendário de Novembro de
  2026 com feriado e 20 dias úteis; imagem carregada e pré-visualizada; linha temporal de um pedido; centro de
  notificações com separadores; sem erros de consola.

**Pendências**

- Aplicar ReportPage ao razão, analítica e demonstrações; KanbanPage a outros fluxos quando existirem estados com
  mais colunas (ex.: pedidos, futuros módulos comerciais).
- Aplicar EntityListPage/EntityFormPage às restantes listas e formulários.

## UI-4 — Modelos aplicados aos restantes ecrãs de administração e relatórios

**Ecrãs**

- EntityListPage (filtros e ordenação na URL, etiquetas, colunas configuráveis, exportação das colunas visíveis):
  entidades legais, filiais, departamentos, cargos, centros de custo (com o âmbito de trabalho e o organograma),
  câmbios, séries documentais, calendários, contas bancárias, perfis e auditoria (filtros de texto e datas, sem
  pesquisa livre porque a API não a tem).
- ReportPage: razão e analítica (estado vazio, metadados dos parâmetros também na impressão, CSV, imprimir).
- Botões "Nova …" da organização passam a "Criar …" (concordância com o tipo).

**APIs** (sem alterações): `organization/:kind`, `exchange-rates`, `document-series`, `calendars`, `bank-accounts`,
`roles`, `audit-events`, `accounting/ledger`, `accounting/analytics`.

**Correcção**: o `ListState` passa a ler a URL depois de o componente receber as entradas (a primeira leitura
acontecia durante a construção e falhava nos ecrãs que servem vários tipos).

**Testes e evidências**

- Frontend: `audit.spec.ts` (datas para ISO); restantes testes inalterados e verdes.
- Browser: filtro e ordenação da organização na URL e após recarregar, mudar de tipo começa sem filtros, filtro por
  tipo de documento nas séries, auditoria filtrada por acção e data, perfis com colunas, razão e analítica como
  relatório (analítica gerada com metadados); repetida a verificação do UI-2 (7/7); sem erros de consola.

**Pendências**

- Listas da contabilidade (diários, planos, exercícios, activos, regras, eventos, regularizações, provisões,
  modelos) e demonstrações financeiras ainda com o cabeçalho e filtros antigos; formulários de edição ainda com
  `PageDetail` sem barra fixa.

## UI-5 — Contabilidade nos modelos e barra de acções nos formulários de edição

**Ecrãs**

- EntityListPage (permissão e funcionalidade verificadas, colunas configuráveis): diários, planos de contas,
  exercícios, regras de contabilização, regularizações, provisões, modelos de demonstrações, classes de activos e
  chaves de repartição (listas completas com criação rápida na própria página).
- Activos fixos e eventos contabilísticos com `ListState`: pesquisa, estado (e classe) na URL, etiquetas, colunas e
  exportação das colunas visíveis.
- Demonstrações financeiras em ReportPage (estado vazio, metadados, "Exportar Excel", imprimir); as notas ficam abaixo.
- `FormActionBar` (barra fixa com alterações por guardar) em configurações da empresa, perfis, registos da organização
  e tabelas da empresa.

**APIs** (sem alterações): `accounting/journals`, `charts`, `fiscal-years`, `posting-rules`, `adjustment-schedules`,
`provisions`, `statement-templates`, `fixed-asset-classes`, `allocation-keys`, `fixed-assets`, `posting-events`,
`statements`, `settings`, `roles/:id`, `organization/:kind/:id`, tabelas da empresa.

**Testes e evidências**

- Frontend: `form-action-bar.spec.ts` (alterações por guardar, acções extra, sem submissão dupla).
- Browser: as 9 listas de configuração com colunas configuráveis; activos com estado na URL após recarregar; eventos
  com pesquisa e estado na URL; demonstrações com estado vazio; barra fixa nas configurações (alterações por guardar),
  num perfil editável, numa entidade legal e numa série documental; UI-2 e UI-4 repetidos sem falhas; sem erros de
  consola. Na base de desenvolvimento não há modelos de demonstração, por isso a geração não foi exercitada no browser
  (continua coberta pelos testes do backend do 6.8).

**Pendências**

- Formulário de lançamento e de regras de contabilização com as suas barras próprias (acções de fluxo); dimensões e
  depreciações/regularizações por período com layouts próprios.

## UI-6 — Últimas listas nos modelos e varredura de acessibilidade e responsividade

**Ecrãs**

- Centro de aprovações: "Para decidir" + pedidos em `DataTable` com estado na URL e colunas configuráveis.
- Workflows de aprovação, planos e empresas da plataforma (pesquisa na URL) em EntityListPage com `DataTable`.
- Notificações em EntityListPage: filtro "Só por ler" na URL, contador de por ler, abrir e marcar como lida.

**Varredura** (script Playwright, ambiente de desenvolvimento): os 47 ecrãs da navegação e formulários de criação, a
1366 px no tema claro e a 390 px no tema escuro, verificando um só `h1`, nome acessível em todos os campos, botões e
ligações, `alt` em imagens, ids únicos, ausência de deslocamento horizontal e de erros de consola.

- Encontrado e corrigido: 4 ecrãs com deslocamento horizontal a 390 px (chaves de repartição, modelos de
  demonstrações, a minha conta, novo lançamento). Causas: grelhas sem largura mínima zero e legendas `sr-only` das
  tabelas posicionadas fora do contentor com scroll. Correcção na base (`FormSection`, `PageDetail`, regra global de
  `table`) e em dois pontos (`fieldset` e fila de botões).
- Depois da correcção: sem problemas nas 94 combinações.

**APIs** (sem alterações): `approvals/requests`, `me/tasks`, `approvals/workflows`, `me/notifications`,
`platform/tenants`, `platform/plans`.

**Testes e evidências**: testes do frontend inalterados e verdes; browser: estado dos pedidos na URL (só cancelados),
workflows com colunas, notificações "só por ler" na URL, empresas com pesquisa e planos da plataforma; UI-2/UI-4/UI-5
continuam verdes.

**Pendências**: delegações, dimensões, depreciações e o formulário de lançamento mantêm layouts próprios (fluxos
específicos); a varredura não substitui uma auditoria com leitor de ecrã real.

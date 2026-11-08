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

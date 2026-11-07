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

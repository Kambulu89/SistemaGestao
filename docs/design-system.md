# Design system (Prompt 04; identidade "Corporate Blue")

Fonte de verdade dos tokens: `frontend/src/styles.css`. Componentes em `frontend/src/app/ui` (e a moldura em
`frontend/src/app/shell`). Alvo: WCAG 2.2 AA.

Identidade "Corporate Blue" (prompt de interface profissional): primária `#174EA6`, interactiva `#2563EB`, sucesso
`#0D9488`, aviso `#D97706`, erro `#DC2626`, fundo `#F6F8FB`, letra Inter (variável, auto-alojada via
`@fontsource-variable/inter`, sem pedidos a terceiros). As cores de estado são para preenchimentos, ícones e barras
(`bg-success`, `bg-warning`, `bg-danger`, ≥ 3:1 sobre `surface`); o texto de estado usa os pares `*-soft`/`*-text`,
mais escuros, para cumprir 4.5:1. No tema escuro a primária passa a `#2563EB` e as ligações/foco a `#7DA2F7`.

## Tokens

| Grupo           | Como se usa                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Notas                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Cor semântica   | `bg-bg`, `bg-surface`, `bg-surface-2`, `text-fg`, `text-muted`, `text-subtle`, `border-border`, `border-border-strong`, `bg-primary`/`text-on-primary`, `bg-primary-soft`/`text-on-primary-soft`, `text-link`, `text-interactive`, `outline-focus`, `bg-success`, `bg-warning`, `bg-danger`/`text-on-danger`, `bg-danger-soft`/`text-danger-text`, `bg-success-soft`/`text-success-text`, `bg-warning-soft`/`text-warning-text`, `bg-info-soft`/`text-info-text`, `bg-overlay` | Variáveis `--c-*`, redefinidas em `[data-theme=dark]`. Nunca cores do Tailwind (`slate-*`, `indigo-*`) nos componentes. |
| Tema            | `Preferences.theme`: claro, escuro, sistema                                                                                                                                                                                                                                                                                                                                                                                                                                    | Atributo `data-theme` no `<html>`; "sistema" segue `prefers-color-scheme`.                                              |
| Contraste       | `design/contrast.spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Texto ≥ 4.5:1; foco e limites de campos ≥ 3:1, nos dois temas. Mudar um token sem cumprir falha o teste.                |
| Tipografia      | `font-sans` (Inter Variable auto-alojada, depois sistema); escala do Tailwind (`text-xs`…`text-3xl`)                                                                                                                                                                                                                                                                                                                                                                           | Títulos de página `text-2xl font-semibold`; secções `font-semibold`.                                                    |
| Espaçamento     | escala do Tailwind (4 px)                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Cartões `p-4`, grelhas `gap-4`.                                                                                         |
| Raios e sombras | `rounded-control`, `rounded-card`, `shadow-card`, `--shadow-overlay`                                                                                                                                                                                                                                                                                                                                                                                                           |                                                                                                                         |
| Foco            | utilitário `focus-ring` (contorno 2 px `--c-focus`, deslocado)                                                                                                                                                                                                                                                                                                                                                                                                                 | Todos os controlos interactivos.                                                                                        |
| Densidade       | `Preferences.density`: confortável/compacto                                                                                                                                                                                                                                                                                                                                                                                                                                    | `--control-py` e `--cell-py` (campos, botões e linhas de tabela).                                                       |
| Movimento       | `--motion-fast` (120 ms), `--motion-base` (200 ms)                                                                                                                                                                                                                                                                                                                                                                                                                             | Zero com `prefers-reduced-motion`.                                                                                      |
| Breakpoints     | `sm` 640, `md` 768, `lg` 1024, `xl` 1280                                                                                                                                                                                                                                                                                                                                                                                                                                       | Mobile-first; a navegação passa a gaveta abaixo de `lg`.                                                                |

Classes base: `btn-primary`, `btn-secondary`, `btn-ghost`, `btn-danger`, `btn-link`, `label`, `input`, `field-error`,
`card`, `table`, `badge`, `skeleton`.

## Moldura (`shell/`)

- **Sidebar**: favoritos do membro no topo; depois os domínios do ERP (Início, Gestão Financeira, Administração e
  Plataforma, Integrações e Compliance; Plataforma só para o administrador da plataforma), recolhíveis e com secções
  (ex.: Gestão Financeira → Contabilidade, Relatórios financeiros, Activos e regularizações, Configuração financeira).
  Domínios sem módulos implementados (Operações Comerciais, Pessoas e Talento, Operações Empresariais, Inteligência e
  Automação) não aparecem. Estreita em ecrã largo (ícones com nome acessível) e gaveta em ecrã pequeno (foco dentro,
  Escape fecha e devolve o foco). Itens filtrados por permissão e funcionalidade (`navigation.ts`).
- **Barra superior**: troca de empresa (limpa contexto, permissões, âmbito e cache), âmbito de trabalho (entidade
  legal/filial, guardado por empresa), pesquisa de registos ("/"), paleta de comandos (Ctrl+K / ⌘K), centro de
  aprovações (com a funcionalidade), notificações e menu da conta (tema, densidade, sair).
- **Paleta de comandos** (`command-palette.ts`): favoritos, recentes, todos os ecrãs visíveis (pesquisa sem acentos,
  por nome, domínio ou secção), acções (tema, densidade, menu, perfil, mudar de empresa) e, com 2+ caracteres, os
  registos da pesquisa global do servidor. `<dialog>` nativo, combobox com ↑/↓/Enter, Escape fecha.
- **Favoritos e recentes** (`core/personal.ts`): a estrela junto ao trilho marca a página; os favoritos ficam no
  servidor (`GET/PUT /api/v1/me/preferences/favorites`, por membro e empresa, máx. 30); os recentes ficam no browser por
  utilizador e empresa (máx. 8, só caminho e título).
- **Trilho e títulos**: `title` em cada rota; o ecrã de detalhe troca o último elemento pelo nome do registo
  (`Breadcrumbs.setCurrent`). O separador do browser fica "<título> · Sistema de Gestão".
- "Saltar para o conteúdo" é o primeiro elemento focável.

## Componentes (`ui/`)

| Componente                                             | Uso                                                                                            | Acessibilidade                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `PageHeader`                                           | título, subtítulo, acções                                                                      | `h1` único por página                                           |
| `PageDetail`                                           | detalhe: cabeçalho com estado, conteúdo e coluna lateral (`<div aside>`)                       | coluna passa para baixo em ecrã pequeno                         |
| `DataTable` + `appCell`                                | listas com ordenação e paginação no servidor, esqueleto, vazio, erro com repetição, exportação | `caption`, `aria-sort`, `aria-busy`, contagem em `aria-live`    |
| `exportList` / `toCsv`                                 | CSV pela mesma API e permissões; `;`, BOM, neutralização de fórmulas; máximo 5000 linhas       | —                                                               |
| `FormSection`, `FormField` + `appControl`              | secções e campos com etiqueta, obrigatório, ajuda e erro do servidor                           | `for`/`id`, `aria-describedby`, `aria-invalid`, `aria-required` |
| `MoneyInput`                                           | valor monetário como texto decimal (`1234.50`), nunca `number`                                 | `inputmode=decimal`                                             |
| `DateInput`                                            | data AAAA-MM-DD com limites e limpar                                                           | nativo, na língua da página                                     |
| `Autocomplete`                                         | escolha com pesquisa na API                                                                    | padrão combobox + listbox, ↑/↓/Enter/Escape                     |
| `Dropdown`                                             | menus da barra superior                                                                        | `aria-expanded`, ↑/↓, Escape devolve o foco                     |
| `Modal` (e gaveta com `side`)                          | janelas                                                                                        | `<dialog>` nativo: foco preso, fundo inerte, Escape             |
| `ConfirmService`                                       | confirmação de acções com consequências                                                        | substitui `window.confirm`                                      |
| `Tabs`                                                 | separadores                                                                                    | `tablist`/`tab`, foco móvel com ←/→                             |
| `Stepper`                                              | etapas (aprovações)                                                                            | `aria-current="step"`, estado em texto                          |
| `StatusBadge`                                          | estados com texto (nunca só cor)                                                               | —                                                               |
| `EmptyState`, `ErrorState`, `Skeleton`, `AccessDenied` | estados de carregamento e acesso negado (permissão, funcionalidade ou âmbito)                  | erro em `role=alert`, com referência do pedido                  |
| `ToastService`                                         | resultado de acções                                                                            | `role=status` (erros `role=alert`)                              |
| `Attachments`                                          | anexos de um registo                                                                           | confirmação ao eliminar                                         |
| `AuditHistory`                                         | histórico do registo (só com `audit.read`)                                                     | lista cronológica                                               |
| `PermissionGate` (`*appCan`)                           | mostrar só com permissão/funcionalidade                                                        | apresentação; a API decide                                      |
| `Kpi` (KPIWidget/SummaryCard)                          | indicador com valor, detalhe, ligação e tom de estado; `null` mostra "—"                       | o tom nunca é a única informação                                |
| `BarChart`                                             | gráficos simples                                                                               | `role=img` com descrição e tabela equivalente                   |
| `unsavedChangesGuard` + `warnOnUnload`                 | aviso de alterações por guardar (navegação e fecho do separador)                               | confirmação acessível                                           |

## Padrões

- **Formulários**: etiquetas visíveis, obrigatórios marcados, validação do servidor junto do campo, botão desactivado
  e "A guardar…" durante o pedido (sem submissão dupla), aviso de alterações por guardar, conflito de versão
  explicado, histórico no detalhe.
- **Listagens**: título, pesquisa, filtros, colunas ordenáveis (só as que o servidor ordena), paginação no servidor,
  exportação autorizada, estados vazio/erro/carregamento.
- **Painel personalizável**: o membro escolhe os blocos visíveis e a ordem (`GET/PUT /api/v1/me/preferences/dashboard`);
  blocos novos aparecem no fim e ids desconhecidos são ignorados (`pages/dashboard-layout.ts`).
- **Painel e pesquisa**: só dados reais devolvidos pela API com as permissões do membro; secção sem acesso diz
  "sem acesso", API em falha diz "indisponível".

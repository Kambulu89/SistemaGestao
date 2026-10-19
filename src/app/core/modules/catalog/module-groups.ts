import type { ModuleGroup } from '../module.model';

const group = (
  order: number,
  id: string,
  name: string,
  icon: string,
  description: string,
): ModuleGroup => ({
  id,
  name,
  icon,
  description,
  order,
});

/** Grupos funcionais do catálogo, pela ordem de apresentação. */
export const MODULE_GROUPS: readonly ModuleGroup[] = [
  group(
    10,
    'core',
    'Platform Core',
    'cube',
    'Multi-tenancy, subscrições, feature flags e registo de módulos.',
  ),
  group(
    20,
    'iam',
    'Identidade e Acessos',
    'lock',
    'Autenticação, utilizadores, controlo de acesso e equipas.',
  ),
  group(
    30,
    'organization',
    'Organização',
    'building',
    'Estrutura da empresa, unidades e centros de custo.',
  ),
  group(40, 'crm', 'CRM', 'users', 'Clientes, contactos, oportunidades e campanhas.'),
  group(50, 'sales', 'Comercial', 'tag', 'Catálogo, preços, vendas, contratos e facturação.'),
  group(
    60,
    'procurement',
    'Compras',
    'truck',
    'Fornecedores, requisições, cotações e ordens de compra.',
  ),
  group(
    70,
    'inventory',
    'Inventário',
    'archive',
    'Armazéns, stock, movimentações e inventários físicos.',
  ),
  group(80, 'finance', 'Financeiro', 'card', 'Caixa, bancos, contas a pagar e receber, orçamento.'),
  group(
    90,
    'hr',
    'Recursos Humanos',
    'users',
    'Colaboradores, assiduidade, férias, avaliação e recrutamento.',
  ),
  group(100, 'projects', 'Projectos', 'clipboard', 'Projectos, tarefas, timesheets e custos.'),
  group(110, 'support', 'Atendimento', 'chat', 'Tickets, SLA e base de conhecimento.'),
  group(
    120,
    'documents',
    'Documentos',
    'folder',
    'Gestão documental, anexos, versões e templates.',
  ),
  group(130, 'communication', 'Comunicação', 'bell', 'Notificações.'),
  group(140, 'calendar', 'Agenda', 'calendar', 'Calendário e agendamentos.'),
  group(150, 'workflow', 'Workflow', 'bolt', 'Fluxos, aprovações, regras e automações.'),
  group(160, 'reporting', 'Reporting', 'chart', 'Dashboards, KPI, relatórios e exportação.'),
  group(170, 'integrations', 'Integrações', 'link', 'API, webhooks e importação de ERP.'),
  group(180, 'governance', 'Governance', 'shield', 'Auditoria, compliance, segurança e backup.'),
  group(
    190,
    'configuration',
    'Configuração',
    'settings',
    'Campos personalizados, formulários, numeração, idiomas, moedas e impostos.',
  ),
];

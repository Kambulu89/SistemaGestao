import { FOUNDATION_CAPABILITIES } from './core/modules/catalog/foundation';
import type { ModuleManifest } from './core/modules/module.model';
import { CALENDAR_MODULES } from './features/business/calendar/calendar.manifest';
import { CRM_MODULES } from './features/business/crm/crm.manifest';
import { DOCUMENTS_MODULES } from './features/business/documents/documents.manifest';
import { FINANCE_MODULES } from './features/business/finance/finance.manifest';
import { HR_MODULES } from './features/business/hr/hr.manifest';
import { INVENTORY_MODULES } from './features/business/inventory/inventory.manifest';
import { ORGANIZATION_MODULES } from './features/business/organization/organization.manifest';
import { PROCUREMENT_MODULES } from './features/business/procurement/procurement.manifest';
import { PROJECTS_MODULES } from './features/business/projects/projects.manifest';
import { SALES_MODULES } from './features/business/sales/sales.manifest';
import { SUPPORT_MODULES } from './features/business/support/support.manifest';
import { DYNAMIC_CORE_MODULES } from './features/dynamic-core/dynamic-core.manifest';
import { CONFIGURATION_MODULES } from './features/dynamic/configuration/configuration.manifest';
import { INTEGRATIONS_MODULES } from './features/dynamic/integrations/integrations.manifest';
import { REPORTING_MODULES } from './features/dynamic/reporting/reporting.manifest';
import { WORKFLOW_MODULES } from './features/dynamic/workflow/workflow.manifest';
import { GOVERNANCE_MODULES } from './features/tenant/governance/governance.manifest';
import { TEAMS_MODULES } from './features/tenant/teams/teams.manifest';

/**
 * Raiz de composição do catálogo: o único ficheiro que conhece todos os módulos.
 * Para acrescentar um módulo: criar o seu manifesto na feature e adicioná-lo aqui.
 * Remover um módulo é o inverso. O core não muda.
 */
export const ALL_MODULE_MANIFESTS: readonly ModuleManifest[] = [
  ...FOUNDATION_CAPABILITIES,
  ...TEAMS_MODULES,
  ...ORGANIZATION_MODULES,
  ...CRM_MODULES,
  ...SALES_MODULES,
  ...PROCUREMENT_MODULES,
  ...INVENTORY_MODULES,
  ...FINANCE_MODULES,
  ...HR_MODULES,
  ...PROJECTS_MODULES,
  ...SUPPORT_MODULES,
  ...DOCUMENTS_MODULES,
  ...CALENDAR_MODULES,
  ...WORKFLOW_MODULES,
  ...REPORTING_MODULES,
  ...INTEGRATIONS_MODULES,
  ...GOVERNANCE_MODULES,
  ...DYNAMIC_CORE_MODULES,
  ...CONFIGURATION_MODULES,
];

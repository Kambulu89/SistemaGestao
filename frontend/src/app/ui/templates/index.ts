/**
 * Modelos de ecrã (prompt de interface). EntityDetailPage é o `PageDetail` (cabeçalho com estado e acções, conteúdo e
 * coluna lateral), usado com `Tabs`, `Attachments` e `AuditHistory`.
 */
export { EntityListPage } from './entity-list-page';
export { EntityFormPage } from './entity-form-page';
export { SettingsPage, type SettingsSection } from './settings-page';
export { PageDetail as EntityDetailPage } from '../page-detail';
export { ApprovalWorkflowPage } from './approval-workflow-page';
export { ReportPage } from './report-page';
export { Wizard as WizardPage, type WizardStep } from './wizard-page';
export {
  KanbanBoard as KanbanPage,
  KanbanCard,
  type KanbanColumn,
  type KanbanMove,
} from './kanban-page';
export {
  CalendarMonth as CalendarPage,
  type CalendarEvent,
  monthGrid,
  shiftMonth,
} from './calendar-page';
export { DocumentPreviewPage, previewKind } from './document-preview-page';

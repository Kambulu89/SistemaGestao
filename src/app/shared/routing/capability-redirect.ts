import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { moduleId } from '../../core/modules/define-module';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { LoadingState } from '../ui/loading-state/loading-state';

/**
 * Capacidades do catálogo cuja funcionalidade já existe numa página própria do tenant (porque não dependem da
 * contratação de um módulo): em vez do ecrã provisório, levam à página real. A página de destino aplica as suas
 * próprias permissões.
 */
export const CAPABILITY_TARGETS: Readonly<Record<string, string>> = {
  [moduleId('iam.teams')]: 'organization',
  [moduleId('organization.cost-centers')]: 'organization',
  [moduleId('workflow.flows')]: 'approvals',
  [moduleId('workflow.rules')]: 'automations',
  [moduleId('configuration.forms')]: 'entities',
  [moduleId('configuration.localization')]: 'settings',
  [moduleId('crm.campaigns')]: 'crm/pipeline',
  [moduleId('documents.versioning')]: 'documents/dms',
  [moduleId('reporting.reports')]: 'reporting/dashboards',
  [moduleId('finance.receivables-payables')]: 'finance/cash-banks',
  [moduleId('finance.payments-budget')]: 'finance/cash-banks',
};

@Component({
  selector: 'app-capability-redirect',
  imports: [LoadingState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-loading-state label="A abrir…" />`,
})
export class CapabilityRedirect {
  constructor() {
    const route = inject(ActivatedRoute);
    const router = inject(Router);
    const slug = inject(TenantContextService).tenant()?.slug;
    const id = route.snapshot.data['moduleId'] as string | undefined;
    const target = id ? CAPABILITY_TARGETS[id] : undefined;
    if (slug && target)
      void router.navigate(['/t', slug, ...target.split('/')], { replaceUrl: true });
    else void router.navigate(['/']);
  }
}

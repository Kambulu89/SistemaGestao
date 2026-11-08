import { Component, input } from '@angular/core';
import { ApprovalTimeline, type TimelineEvent } from '../approval-timeline';
import { StatusBadge } from '../status-badge';
import { type StepItem, Stepper } from '../stepper';

/**
 * ApprovalWorkflowPage: cabeçalho com estado, resumo do pedido, painel de decisão (só para quem pode decidir,
 * projectado em `[decision]`), etapas (Stepper), linha temporal (ApprovalTimeline) e coluna lateral (`[aside]`:
 * cancelar, anexos…). Quem decide e o que se pode fazer vem sempre da API.
 */
@Component({
  selector: 'app-approval-workflow-page',
  imports: [StatusBadge, Stepper, ApprovalTimeline],
  template: `
    <div class="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h1 class="flex flex-wrap items-center gap-2 text-2xl font-semibold">
          <span>{{ title() }}</span>
          <app-status-badge [status]="status()" />
        </h1>
        @if (subtitle()) {
          <p class="mt-1 text-sm text-muted">{{ subtitle() }}</p>
        }
      </div>
      <div class="flex flex-wrap gap-2"><ng-content select="[actions]" /></div>
    </div>
    <div class="grid gap-4 lg:grid-cols-3">
      <div class="space-y-4 lg:col-span-2">
        <ng-content select="[summary]" />
        <ng-content select="[decision]" />
        <div class="grid gap-4 md:grid-cols-2">
          <section class="card" aria-labelledby="awp-steps">
            <h2 id="awp-steps" class="mb-3 font-semibold">Etapas</h2>
            <app-stepper label="Etapas do pedido" [steps]="steps()" />
          </section>
          <section class="card" aria-labelledby="awp-timeline">
            <h2 id="awp-timeline" class="mb-3 font-semibold">Linha temporal</h2>
            <app-approval-timeline [events]="timeline()" />
          </section>
        </div>
      </div>
      <div class="space-y-4"><ng-content select="[aside]" /></div>
    </div>
  `,
})
export class ApprovalWorkflowPage {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  readonly status = input.required<string>();
  readonly steps = input<StepItem[]>([]);
  readonly timeline = input<TimelineEvent[]>([]);
}

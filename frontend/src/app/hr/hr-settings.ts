import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { ErrorAlert } from '../ui/error-alert';
import { ErrorState, Skeleton } from '../ui/states';
import { SettingsPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';

interface HrSettings {
  requisitionWorkflowId: string | null;
  offerWorkflowId: string | null;
  version: number;
}
interface Workflow {
  id: string;
  code: string;
  name: string;
  subjectType: string;
  status: string;
}

/**
 * Configuração dos recursos humanos: workflows de aprovação das vagas e das propostas. Sem workflow, a decisão é
 * directa por quem tem `hr.recruitment.approve` no âmbito (nunca quem preparou).
 */
@Component({
  selector: 'app-hr-settings',
  imports: [
    FormsModule,
    RouterLink,
    SettingsPage,
    FormSection,
    FormField,
    FieldControl,
    ErrorAlert,
    ErrorState,
    Skeleton,
  ],
  template: `
    <app-settings-page
      title="Configuração de RH"
      subtitle="Como se aprovam as vagas e as propostas de contratação."
      [sections]="[{ id: 'hr-approvals', label: 'Aprovações do recrutamento' }]"
    >
      @if (loadError()) {
        <app-error-state [error]="loadError()" (retry)="load()" />
      } @else if (!settings()) {
        <div class="card"><app-skeleton /></div>
      } @else {
        <form id="hr-approvals" tabindex="-1" class="space-y-4" (ngSubmit)="save()" novalidate>
          <app-error-alert [error]="action.error()" />
          <app-form-section
            title="Aprovações do recrutamento"
            description="Escolha um workflow publicado do tipo certo, ou deixe em branco para decisão directa."
            [columns]="1"
          >
            <app-field
              label="Vagas (requisições de pessoal)"
              [error]="action.field('requisitionWorkflowId')"
            >
              <select
                appControl
                class="input"
                data-testid="wf-requisition"
                [(ngModel)]="requisitionWorkflowId"
                [ngModelOptions]="{ standalone: true }"
              >
                <option [ngValue]="null">Decisão directa</option>
                @for (w of byType('job_requisition'); track w.id) {
                  <option [ngValue]="w.id">{{ w.code }} — {{ w.name }}</option>
                }
              </select>
            </app-field>
            <app-field label="Propostas de contratação" [error]="action.field('offerWorkflowId')">
              <select
                appControl
                class="input"
                data-testid="wf-offer"
                [(ngModel)]="offerWorkflowId"
                [ngModelOptions]="{ standalone: true }"
              >
                <option [ngValue]="null">Decisão directa</option>
                @for (w of byType('job_offer'); track w.id) {
                  <option [ngValue]="w.id">{{ w.code }} — {{ w.name }}</option>
                }
              </select>
            </app-field>
          </app-form-section>
          <p class="text-sm text-muted">
            Os workflows criam-se em
            <a class="link" routerLink="/aprovacoes/workflows">Aprovações → Workflows</a>, com o
            tipo de assunto "Vaga" ou "Proposta de contratação".
          </p>
          <div class="flex justify-end">
            <button type="submit" class="btn-primary" [disabled]="action.busy()">Guardar</button>
          </div>
        </form>
      }
    </app-settings-page>
  `,
})
export class HrSettingsPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  protected readonly settings = signal<HrSettings | null>(null);
  protected readonly workflows = signal<Workflow[]>([]);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected requisitionWorkflowId: string | null = null;
  protected offerWorkflowId: string | null = null;

  constructor() {
    void this.load();
  }

  protected byType(type: string) {
    return this.workflows().filter((w) => w.subjectType === type && w.status === 'ACTIVE');
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const [s, w] = await Promise.all([
        this.api.get<HrSettings>('hr/settings'),
        this.api.get<Workflow[]>('approvals/workflows').catch(() => [] as Workflow[]),
      ]);
      this.settings.set(s);
      this.workflows.set(w);
      this.requisitionWorkflowId = s.requisitionWorkflowId;
      this.offerWorkflowId = s.offerWorkflowId;
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected async save() {
    const s = this.settings()!;
    const result = await this.action.run(() =>
      this.api.put<HrSettings>('hr/settings', {
        requisitionWorkflowId: this.requisitionWorkflowId,
        offerWorkflowId: this.offerWorkflowId,
        expectedVersion: s.version,
      }),
    );
    if (!result) return;
    this.settings.set(result);
    this.toasts.show('Configuração guardada.');
  }
}

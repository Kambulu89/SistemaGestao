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
  compensationWorkflowId: string | null;
  loanMaxInstallmentPercent: string | null;
  loanMaxInstallments: number | null;
  loanPolicyReference: string | null;
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
 * Configuração dos recursos humanos: workflows de aprovação das vagas e das propostas (sem workflow, a decisão é
 * directa por quem tem a permissão de aprovar no âmbito, nunca quem preparou) e limites dos adiantamentos e
 * empréstimos, sempre com a fonte (regulamento interno ou norma legal confirmada); nada vem pré-definido.
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
      subtitle="Como se aprovam vagas e propostas, e os limites dos adiantamentos e empréstimos."
      [sections]="[
        { id: 'hr-approvals', label: 'Aprovações' },
        { id: 'hr-loans', label: 'Adiantamentos e empréstimos' },
      ]"
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
            <app-field
              label="Propostas de compensação"
              [error]="action.field('compensationWorkflowId')"
            >
              <select
                appControl
                class="input"
                data-testid="wf-compensation"
                [(ngModel)]="compensationWorkflowId"
                [ngModelOptions]="{ standalone: true }"
              >
                <option [ngValue]="null">Decisão directa</option>
                @for (w of byType('compensation_proposal'); track w.id) {
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
          <div id="hr-loans" tabindex="-1">
            <app-form-section
              title="Adiantamentos e empréstimos"
              description="Limites verificados ao submeter e ao aprovar. Sem limites, só se exige contrato em cada mês de desconto. Indique sempre a fonte (regulamento interno ou norma legal confirmada)."
              [columns]="2"
            >
              <app-field
                label="Prestação máxima (% do salário base por mês)"
                hint="Soma das prestações de todos os empréstimos activos no mesmo mês."
                [error]="action.field('loanMaxInstallmentPercent')"
              >
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  data-testid="loan-max-pct"
                  [(ngModel)]="loanMaxInstallmentPercent"
                  [ngModelOptions]="{ standalone: true }"
                />
              </app-field>
              <app-field
                label="Número máximo de prestações"
                [error]="action.field('loanMaxInstallments')"
              >
                <input
                  appControl
                  class="input"
                  type="number"
                  min="1"
                  max="120"
                  data-testid="loan-max-count"
                  [(ngModel)]="loanMaxInstallments"
                  [ngModelOptions]="{ standalone: true }"
                />
              </app-field>
              <app-field
                class="sm:col-span-2"
                label="Fonte dos limites"
                [required]="!!loanMaxInstallmentPercent || !!loanMaxInstallments"
                [error]="action.field('loanPolicyReference')"
              >
                <input
                  appControl
                  class="input"
                  data-testid="loan-policy"
                  [(ngModel)]="loanPolicyReference"
                  [ngModelOptions]="{ standalone: true }"
                />
              </app-field>
            </app-form-section>
          </div>
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
  protected compensationWorkflowId: string | null = null;
  protected loanMaxInstallmentPercent = '';
  protected loanMaxInstallments: number | null = null;
  protected loanPolicyReference = '';

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
      this.compensationWorkflowId = s.compensationWorkflowId;
      this.loanMaxInstallmentPercent = s.loanMaxInstallmentPercent?.replace(/\.?0+$/, '') ?? '';
      this.loanMaxInstallments = s.loanMaxInstallments;
      this.loanPolicyReference = s.loanPolicyReference ?? '';
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
        compensationWorkflowId: this.compensationWorkflowId,
        loanMaxInstallmentPercent: this.loanMaxInstallmentPercent.trim().replace(',', '.') || null,
        loanMaxInstallments:
          this.loanMaxInstallments === null || (this.loanMaxInstallments as unknown) === ''
            ? null
            : Number(this.loanMaxInstallments),
        loanPolicyReference: this.loanPolicyReference.trim() || null,
        expectedVersion: s.version,
      }),
    );
    if (!result) return;
    this.settings.set(result);
    this.loanMaxInstallmentPercent = result.loanMaxInstallmentPercent?.replace(/\.?0+$/, '') ?? '';
    this.toasts.show('Configuração guardada.');
  }
}

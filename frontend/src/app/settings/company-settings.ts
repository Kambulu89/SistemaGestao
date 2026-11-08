import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Workspace } from '../core/workspace';
import { AuditHistory } from '../ui/audit-history';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { SettingsPage, type SettingsSection } from '../ui/templates';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';

export interface TenantSettings {
  amountScale: number;
  quantityScale: number;
  priceScale: number;
  roundingMode: 'HALF_UP' | 'HALF_EVEN';
  invitationTtlDays: number;
  notifyApprovalPending: boolean;
  notifyApprovalDecided: boolean;
  bankAccountWorkflowId: string | null;
  version: number;
}

const KEYS = [
  'amountScale',
  'quantityScale',
  'priceScale',
  'roundingMode',
  'invitationTtlDays',
  'notifyApprovalPending',
  'notifyApprovalDecided',
  'bankAccountWorkflowId',
] as const;

/** Só os valores que mudaram (números convertidos). */
export function settingsPayload(form: Record<string, unknown>, original: TenantSettings) {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) {
    let v = form[k];
    if (k.endsWith('Scale') || k === 'invitationTtlDays') v = v === '' || v == null ? v : Number(v);
    if (v === undefined) continue;
    if (v !== original[k]) out[k] = v;
  }
  return out;
}

interface Workflow {
  id: string;
  code: string;
  name: string;
  subjectType: string;
  status: string;
}

/**
 * Configurações gerais da empresa (SettingsPage): precisões e arredondamento (contrato para os módulos de valores), validade dos
 * convites, notificações de aprovação e workflow de aprovação de contas bancárias. Sem cálculo fiscal nem tesouraria.
 */
@Component({
  selector: 'app-company-settings',
  imports: [
    FormsModule,
    RouterLink,
    SettingsPage,
    ErrorAlert,
    ErrorState,
    Skeleton,
    FormSection,
    FormField,
    FieldControl,
    AuditHistory,
  ],
  template: `
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else if (!settings()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      <app-settings-page
        title="Configurações da empresa"
        subtitle="Regras gerais usadas por todos os módulos desta empresa."
        [sections]="sections"
      >
        <form class="space-y-4" (ngSubmit)="save()" novalidate>
          <app-error-alert [error]="action.error()" [showDetails]="false" />
          <app-form-section
            id="precisao"
            tabindex="-1"
            title="Precisão e arredondamento"
            description="Casas decimais usadas pelos módulos de valores (facturação, compras, inventário…)."
          >
            <app-field
              label="Valores (casas decimais)"
              hint="0 a 6."
              [error]="action.field('amountScale')"
            >
              <input
                appControl
                type="number"
                min="0"
                max="6"
                class="input"
                name="amountScale"
                [disabled]="!canManage()"
                [(ngModel)]="form['amountScale']"
              />
            </app-field>
            <app-field
              label="Quantidades (casas decimais)"
              hint="0 a 6."
              [error]="action.field('quantityScale')"
            >
              <input
                appControl
                type="number"
                min="0"
                max="6"
                class="input"
                name="quantityScale"
                [disabled]="!canManage()"
                [(ngModel)]="form['quantityScale']"
              />
            </app-field>
            <app-field
              label="Preços unitários (casas decimais)"
              hint="0 a 8."
              [error]="action.field('priceScale')"
            >
              <input
                appControl
                type="number"
                min="0"
                max="8"
                class="input"
                name="priceScale"
                [disabled]="!canManage()"
                [(ngModel)]="form['priceScale']"
              />
            </app-field>
            <app-field label="Arredondamento" [error]="action.field('roundingMode')">
              <select
                appControl
                class="input"
                name="roundingMode"
                [disabled]="!canManage()"
                [(ngModel)]="form['roundingMode']"
              >
                <option value="HALF_UP">Meio para cima (0,5 → 1)</option>
                <option value="HALF_EVEN">Meio para o par (bancário)</option>
              </select>
            </app-field>
          </app-form-section>
          <app-form-section
            id="seguranca"
            tabindex="-1"
            title="Segurança"
            description="Convites para novos membros."
          >
            <app-field
              label="Validade dos convites (dias)"
              hint="1 a 30."
              [error]="action.field('invitationTtlDays')"
            >
              <input
                appControl
                type="number"
                min="1"
                max="30"
                class="input"
                name="invitationTtlDays"
                [disabled]="!canManage()"
                [(ngModel)]="form['invitationTtlDays']"
              />
            </app-field>
          </app-form-section>
          <app-form-section
            id="notificacoes"
            tabindex="-1"
            title="Notificações"
            description="As tarefas de aprovação existem sempre; aqui decide-se se também há aviso."
          >
            <label class="flex items-center gap-2 text-sm md:col-span-2">
              <input
                type="checkbox"
                name="notifyApprovalPending"
                [disabled]="!canManage()"
                [(ngModel)]="form['notifyApprovalPending']"
              />
              Avisar os aprovadores quando há uma aprovação pendente
            </label>
            <label class="flex items-center gap-2 text-sm md:col-span-2">
              <input
                type="checkbox"
                name="notifyApprovalDecided"
                [disabled]="!canManage()"
                [(ngModel)]="form['notifyApprovalDecided']"
              />
              Avisar quem pediu quando o pedido é aprovado ou rejeitado
            </label>
          </app-form-section>
          <app-form-section
            id="contas-bancarias"
            tabindex="-1"
            title="Aprovação de contas bancárias"
            description="Com um workflow escolhido, cada conta nova fica pendente até ser aprovada."
          >
            <app-field
              label="Workflow"
              [error]="action.field('bankAccountWorkflowId')"
              class="md:col-span-2"
            >
              <select
                appControl
                class="input"
                name="bankAccountWorkflowId"
                [disabled]="!canManage()"
                [(ngModel)]="form['bankAccountWorkflowId']"
              >
                <option [ngValue]="null">Sem aprovação (contas activas de imediato)</option>
                @if (form['bankAccountWorkflowId'] && !known(form['bankAccountWorkflowId'])) {
                  <option [ngValue]="form['bankAccountWorkflowId']">Workflow configurado</option>
                }
                @for (w of workflows(); track w.id) {
                  <option [ngValue]="w.id">{{ w.code }} — {{ w.name }}</option>
                }
              </select>
            </app-field>
            @if (workspace.has('approvals') && workspace.can('approvals.manage')) {
              <p class="text-xs text-muted md:col-span-2">
                Só aparecem workflows publicados do tipo "conta bancária".
                <a class="btn-link" routerLink="/aprovacoes/workflows">Gerir workflows</a>
              </p>
            }
          </app-form-section>
          @if (canManage()) {
            <div
              class="no-print sticky bottom-0 z-20 flex items-center gap-3 border-t border-border bg-surface py-3"
            >
              <button type="submit" class="btn-primary" [disabled]="action.busy()">
                {{ action.busy() ? 'A guardar…' : 'Guardar configurações' }}
              </button>
              @if (hasUnsavedChanges()) {
                <span class="text-sm text-muted" role="status">Alterações por guardar</span>
              }
            </div>
          }
        </form>
        <section id="historico" tabindex="-1" aria-label="Histórico de alterações">
          <app-audit-history
            entityType="tenant_settings"
            [entityId]="workspace.tenantId() ?? ''"
            [refreshKey]="settings()!.version"
          />
        </section>
      </app-settings-page>
    }
  `,
})
export class CompanySettingsPage implements HasUnsavedChanges {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  protected readonly workspace = inject(Workspace);
  protected readonly canManage = computed(() => this.workspace.can('settings.manage'));
  protected readonly settings = signal<TenantSettings | null>(null);
  protected readonly workflows = signal<Workflow[]>([]);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly sections: SettingsSection[] = [
    { id: 'precisao', label: 'Precisão e arredondamento' },
    { id: 'seguranca', label: 'Segurança' },
    { id: 'notificacoes', label: 'Notificações' },
    { id: 'contas-bancarias', label: 'Contas bancárias' },
    { id: 'historico', label: 'Histórico' },
  ];
  protected form: Record<string, unknown> = {};
  private initial = '';

  constructor() {
    warnOnUnload(this);
    void this.load();
  }

  protected known(id: unknown) {
    return this.workflows().some((w) => w.id === id);
  }

  hasUnsavedChanges() {
    return !!this.settings() && this.canManage() && snapshot(this.form) !== this.initial;
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.apply(await this.api.get<TenantSettings>('settings'));
    } catch (error) {
      this.loadError.set(ApiError.from(error));
      return;
    }
    if (this.workspace.has('approvals') && this.workspace.can('approvals.manage'))
      try {
        const page = await this.api.page<Workflow>('approvals/workflows', { limit: 200 });
        this.workflows.set(
          page.items.filter((w) => w.subjectType === 'bank_account' && w.status === 'ACTIVE'),
        );
      } catch {
        this.workflows.set([]);
      }
  }

  private apply(s: TenantSettings) {
    this.settings.set(s);
    this.form = { ...s };
    this.initial = snapshot(this.form);
  }

  protected async save() {
    const original = this.settings()!;
    const body = settingsPayload(this.form, original);
    if (Object.keys(body).length === 0) {
      this.toasts.show('Nada para guardar.', 'info');
      return;
    }
    const result = await this.action.run(() =>
      this.api.put<TenantSettings>('settings', { ...body, expectedVersion: original.version }),
    );
    if (!result) return;
    this.apply(result);
    this.toasts.show('Configurações guardadas.');
  }
}

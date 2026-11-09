import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Workspace } from '../core/workspace';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { ToastService } from '../ui/toasts';
import {
  emptyTerminationForm,
  TerminationFields,
  type TerminationForm,
  terminationPayload,
} from './termination-fields';
import {
  TERMINATION_REASON,
  TERMINATION_STATUS,
  type Termination,
  terminationTone,
} from './termination-model';

/** Cessação na ficha: o processo em curso (ou concluído) e, para quem gere, iniciar um novo. */
@Component({
  selector: 'app-termination-card',
  imports: [RouterLink, Modal, ErrorAlert, TerminationFields],
  template: `
    @if (visible() && items(); as list) {
      <section class="card" aria-labelledby="tc-title" data-testid="termination">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="tc-title" class="font-semibold">Cessação</h2>
          @if (canStart()) {
            <button type="button" class="btn-secondary" data-testid="tc-open" (click)="open()">
              Iniciar cessação
            </button>
          }
        </div>
        @if (!list.length) {
          <p class="text-sm text-muted">Sem processos de cessação.</p>
        }
        <ul class="text-sm">
          @for (t of list; track t.id) {
            <li class="flex flex-wrap justify-between gap-2 py-1">
              <a class="link" [routerLink]="['/rh/cessacoes', t.id]"
                >{{ t.code }} · {{ reason(t) }} · último dia {{ date(t.lastWorkingDay) }}</a
              >
              <span class="badge" [class]="tone(t.status)">{{ status(t) }}</span>
            </li>
          }
        </ul>
      </section>
    }

    <app-modal title="Iniciar cessação" [open]="opened()" (closed)="opened.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <p class="mb-3 text-sm text-muted">
        Os dias de aviso e a indemnização são indicados pela empresa com a fonte; confirme as normas
        em vigor antes de submeter.
      </p>
      <app-termination-fields [form]="form" [action]="action" [cases]="cases()" />
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="opened.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="tc-confirm"
          [disabled]="action.busy()"
          (click)="save()"
        >
          Criar rascunho
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class TerminationCard {
  readonly employeeId = input.required<string>();
  /** Estado da ficha: um colaborador que já cessou funções não abre novo processo. */
  readonly employeeStatus = input<string>('ACTIVE');
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly workspace = inject(Workspace);
  protected readonly items = signal<Termination[] | null>(null);
  protected readonly cases = signal<{ id: string; label: string }[]>([]);
  protected readonly opened = signal(false);
  protected readonly action = new Action();
  protected form: TerminationForm = emptyTerminationForm();
  protected readonly visible = computed(() =>
    ['hr.terminations.read', 'hr.terminations.manage', 'hr.terminations.approve'].some((p) =>
      this.workspace.canAny(p),
    ),
  );
  protected readonly canStart = computed(
    () =>
      this.workspace.canAny('hr.terminations.manage') &&
      this.employeeStatus() !== 'TERMINATED' &&
      !(this.items() ?? []).some((t) => t.status !== 'CANCELLED'),
  );
  protected readonly date = formatDate;
  protected readonly tone = terminationTone;
  protected readonly status = (t: Termination) => TERMINATION_STATUS[t.status];
  protected readonly reason = (t: Termination) => TERMINATION_REASON[t.reason];

  constructor() {
    effect(() => {
      const id = this.employeeId();
      const show = this.visible();
      untracked(() => {
        if (show) void this.load(id);
      });
    });
  }

  private async load(id: string) {
    try {
      const page = await this.api.page<Termination>('hr/terminations', {
        employeeId: id,
        limit: 20,
      });
      this.items.set(page.items);
    } catch {
      this.items.set(null);
    }
  }

  protected async open() {
    this.action.error.set(null);
    this.form = emptyTerminationForm();
    this.opened.set(true);
    // Processos disciplinares só para quem tem esse acesso restrito (a API valida de qualquer forma).
    if (
      this.workspace.canAny('hr.discipline.read') ||
      this.workspace.canAny('hr.discipline.manage')
    )
      try {
        const page = await this.api.page<{ id: string; code: string; summary: string }>(
          'hr/discipline/cases',
          { employeeId: this.employeeId(), limit: 50 },
        );
        this.cases.set(page.items.map((c) => ({ id: c.id, label: `${c.code} · ${c.summary}` })));
      } catch {
        this.cases.set([]);
      }
  }

  protected async save() {
    const result = await this.action.run(() =>
      this.api.post<Termination>(
        `hr/employees/${this.employeeId()}/terminations`,
        terminationPayload(this.form),
      ),
    );
    if (!result) return;
    this.opened.set(false);
    this.toasts.show('Cessação criada em rascunho.');
    await this.router.navigate(['/rh/cessacoes', result.id]);
  }
}

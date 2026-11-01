import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import {
  AccountingApi,
  type FiscalYearDto,
  type JournalType,
  type PeriodDto,
} from './accounting.api';
import { JOURNAL_TYPE_LABEL, accountingError } from './accounting-model';

const TYPE_OPTIONS: readonly SelectOption[] = (
  Object.keys(JOURNAL_TYPE_LABEL) as JournalType[]
).map((value) => ({ value, label: JOURNAL_TYPE_LABEL[value] }));

/** Exercícios (com os seus períodos mensais, que se fecham e reabrem) e diários da empresa. */
@Component({
  selector: 'app-periods-tab',
  imports: [FormsModule, Alert, Badge, Button, Card, Dialog, EmptyState, Input, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block" data-testid="periods-error">{{ text }}</app-alert>
    }
    <div class="mb-3 flex items-center justify-between">
      <h3 class="text-sm font-semibold">Exercícios</h3>
      @if (canManage()) {
        <app-button size="sm" (click)="openYear()">Novo exercício</app-button>
      }
    </div>
    @if (years.hasValue() && years.value(); as list) {
      @if (list.length === 0) {
        <app-empty-state icon="calendar" title="Sem exercícios: crie o primeiro" />
      }
      <div class="space-y-3" data-testid="years">
        @for (year of list; track year.id) {
          <app-card [title]="'Exercício ' + year.code">
            <p class="mb-2 text-xs text-fg-muted">
              {{ year.startsOn }} a {{ year.endsOn }} ·
              <app-badge [tone]="year.status === 'OPEN' ? 'success' : 'neutral'">{{
                year.status === 'OPEN' ? 'Aberto' : 'Encerrado'
              }}</app-badge>
            </p>
            <div class="flex flex-wrap gap-2">
              @for (p of year.periods; track p.id) {
                <span
                  class="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs"
                  [attr.data-testid]="'period-' + p.number"
                >
                  {{ p.number }} · {{ p.startsOn.slice(5) }}
                  <app-badge [tone]="p.status === 'OPEN' ? 'success' : 'neutral'">{{
                    p.status === 'OPEN' ? 'aberto' : 'fechado'
                  }}</app-badge>
                  @if (canClose() && year.status === 'OPEN') {
                    <button type="button" class="underline" (click)="togglePeriod(p)">
                      {{ p.status === 'OPEN' ? 'Fechar' : 'Reabrir' }}
                    </button>
                  }
                </span>
              }
            </div>
            @if (canClose() && year.status === 'OPEN') {
              <app-button size="sm" variant="ghost" class="mt-2" (click)="closeYear(year)"
                >Encerrar exercício</app-button
              >
            }
          </app-card>
        }
      </div>
    }

    <div class="mb-3 mt-6 flex items-center justify-between">
      <h3 class="text-sm font-semibold">Diários</h3>
      @if (canManage()) {
        <app-button size="sm" (click)="openJournal()">Novo diário</app-button>
      }
    </div>
    <ul class="grid gap-2 sm:grid-cols-2" data-testid="journals">
      @for (j of journals.hasValue() ? journals.value() : []; track j.id) {
        <li class="rounded-md border border-line p-2 text-sm">
          <span class="font-mono">{{ j.code }}</span> {{ j.name }}
          <span class="block text-xs text-fg-muted"
            >{{ typeLabel(j.type) }}{{ j.active ? '' : ' · inactivo' }}</span
          >
        </li>
      }
    </ul>

    <app-dialog [open]="yearOpen()" title="Novo exercício" (closed)="yearOpen.set(false)">
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block" data-testid="year-error">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="year-form">
        <app-input label="Código" [ngModel]="code()" (ngModelChange)="code.set($event ?? '')" />
        <div class="grid gap-3 sm:grid-cols-2">
          <app-input
            label="Início"
            type="date"
            [ngModel]="startsOn()"
            (ngModelChange)="startsOn.set($event ?? '')"
          />
          <app-input
            label="Fim"
            type="date"
            [ngModel]="endsOn()"
            (ngModelChange)="endsOn.set($event ?? '')"
          />
        </div>
        <p class="text-xs text-fg-muted">
          Os períodos mensais criam-se sozinhos (até 24 meses, para exercícios irregulares).
        </p>
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="yearOpen.set(false)">Cancelar</app-button>
        <app-button (click)="createYear()">Criar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog [open]="journalOpen()" title="Novo diário" (closed)="journalOpen.set(false)">
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3">
        <app-input label="Código" [ngModel]="code()" (ngModelChange)="code.set($event ?? '')" />
        <app-input label="Nome" [ngModel]="name()" (ngModelChange)="name.set($event ?? '')" />
        <app-select
          label="Tipo"
          [options]="typeOptions"
          [ngModel]="type()"
          (ngModelChange)="type.set(($event ?? 'GENERAL') + '')"
        />
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="journalOpen.set(false)">Cancelar</app-button>
        <app-button (click)="createJournal()">Criar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class PeriodsTab {
  private readonly api = inject(AccountingApi);
  private readonly permissions = inject(PermissionService);

  readonly organizationId = input.required<string>();

  protected readonly typeOptions = TYPE_OPTIONS;
  protected readonly canManage = computed(() => this.permissions.can('accounting.manage'));
  protected readonly canClose = computed(() => this.permissions.can('period.close'));
  private readonly tick = signal(0);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);

  protected readonly years = rxResource({
    params: () => ({ organizationId: this.organizationId(), tick: this.tick() }),
    stream: ({ params }) => this.api.fiscalYears(params.organizationId),
  });
  protected readonly journals = rxResource({
    params: () => ({ organizationId: this.organizationId(), tick: this.tick() }),
    stream: ({ params }) => this.api.journals(params.organizationId),
  });

  protected readonly yearOpen = signal(false);
  protected readonly journalOpen = signal(false);
  protected readonly code = signal('');
  protected readonly name = signal('');
  protected readonly type = signal<string>('GENERAL');
  protected readonly startsOn = signal('');
  protected readonly endsOn = signal('');

  protected typeLabel = (t: JournalType) => JOURNAL_TYPE_LABEL[t];

  private run<T>(call: Observable<T>, message: string, close: () => void): void {
    this.actionError.set(null);
    this.formError.set(null);
    call.subscribe({
      next: () => {
        close();
        this.notice.set(message);
        this.tick.update((t) => t + 1);
      },
      error: (e: unknown) => {
        const text = accountingError(e, 'A operação falhou.');
        if (this.yearOpen() || this.journalOpen()) this.formError.set(text);
        else this.actionError.set(text);
      },
    });
  }

  protected openYear(): void {
    const next = new Date().getFullYear() + 1;
    this.formError.set(null);
    this.code.set(String(next));
    this.startsOn.set(`${next}-01-01`);
    this.endsOn.set(`${next}-12-31`);
    this.yearOpen.set(true);
  }

  protected createYear(): void {
    this.run(
      this.api.createFiscalYear({
        organizationId: this.organizationId(),
        code: this.code(),
        startsOn: this.startsOn(),
        endsOn: this.endsOn(),
      }),
      'Exercício criado com os períodos mensais.',
      () => this.yearOpen.set(false),
    );
  }

  protected openJournal(): void {
    this.formError.set(null);
    this.code.set('');
    this.name.set('');
    this.type.set('GENERAL');
    this.journalOpen.set(true);
  }

  protected createJournal(): void {
    this.run(
      this.api.createJournal({
        organizationId: this.organizationId(),
        code: this.code(),
        name: this.name(),
        type: this.type() as JournalType,
      }),
      'Diário criado.',
      () => this.journalOpen.set(false),
    );
  }

  protected togglePeriod(period: PeriodDto): void {
    const open = period.status === 'CLOSED';
    this.run(
      this.api.setPeriod(period.id, open),
      open ? 'Período reaberto.' : 'Período fechado: já não aceita lançamentos.',
      () => undefined,
    );
  }

  protected closeYear(year: FiscalYearDto): void {
    this.run(this.api.closeFiscalYear(year.id), 'Exercício encerrado.', () => undefined);
  }
}

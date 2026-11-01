import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Card } from '../../../shared/ui/card/card';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { AccountingApi, type RuleDto } from './accounting.api';
import { ROLE_LABEL, accountingError } from './accounting-model';

/**
 * Regras de contabilização: para cada evento dos outros módulos, que conta e diário usar em cada papel. Sem regra, o
 * lançamento automático não se faz (fica pendente na fase E2): nunca se adivinham contas.
 */
@Component({
  selector: 'app-rules-tab',
  imports: [FormsModule, Alert, Card, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="mb-3 text-sm text-fg-muted">
      As regras ligam os eventos dos outros módulos às contas desta empresa. A contabilização
      automática desses eventos entra na fase seguinte (E2); as regras configuram-se já.
    </p>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    @if (error(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <div class="space-y-3" data-testid="rules">
      @for (event of events.hasValue() ? events.value() : []; track event.code) {
        <app-card [title]="event.label">
          <div class="space-y-2">
            @for (role of event.roles; track role) {
              <div class="grid items-end gap-2 sm:grid-cols-[14rem_1fr_12rem]">
                <span class="text-sm">{{ roleLabel(role) }}</span>
                <app-select
                  [label]="'Conta — ' + roleLabel(role)"
                  placeholder="(sem regra)"
                  [disabled]="!canManage()"
                  [options]="accountOptions()"
                  [ngModel]="ruleOf(event.code, role)?.accountId ?? ''"
                  (ngModelChange)="save(event.code, role, $event, null)"
                />
                <app-select
                  [label]="'Diário — ' + roleLabel(role)"
                  [disabled]="!canManage()"
                  [options]="journalOptions()"
                  [ngModel]="ruleOf(event.code, role)?.journalId ?? defaultJournal()"
                  (ngModelChange)="save(event.code, role, null, $event)"
                />
              </div>
            }
          </div>
        </app-card>
      }
    </div>
  `,
})
export class RulesTab {
  private readonly api = inject(AccountingApi);
  private readonly permissions = inject(PermissionService);

  readonly organizationId = input.required<string>();

  protected readonly canManage = computed(() => this.permissions.can('accounting.manage'));
  private readonly tick = signal(0);
  protected readonly notice = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly events = rxResource({ stream: () => this.api.postingEvents() });
  private readonly rules = rxResource({
    params: () => ({ organizationId: this.organizationId(), tick: this.tick() }),
    stream: ({ params }) => this.api.rules(params.organizationId),
  });
  private readonly accounts = rxResource({
    params: () => ({ organizationId: this.organizationId() }),
    stream: ({ params }) => this.api.accounts(params.organizationId),
  });
  private readonly journals = rxResource({
    params: () => ({ organizationId: this.organizationId() }),
    stream: ({ params }) => this.api.journals(params.organizationId),
  });
  protected readonly accountOptions = computed<readonly SelectOption[]>(() =>
    (this.accounts.hasValue() ? this.accounts.value() : [])
      .filter((a) => a.kind === 'POSTING' && a.active)
      .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
  );
  protected readonly journalOptions = computed<readonly SelectOption[]>(() =>
    (this.journals.hasValue() ? this.journals.value() : []).map((j) => ({
      value: j.id,
      label: `${j.code} — ${j.name}`,
    })),
  );
  protected readonly defaultJournal = computed(() => this.journalOptions()[0]?.value ?? '');

  protected roleLabel = (role: string) => ROLE_LABEL[role] ?? role;

  protected ruleOf(eventType: string, role: string): RuleDto | undefined {
    return (this.rules.hasValue() ? this.rules.value() : []).find(
      (r) => r.eventType === eventType && r.role === role,
    );
  }

  /** Guarda ao escolher: a conta é obrigatória; o diário fica o da regra ou o primeiro. */
  protected save(eventType: string, role: string, accountId: unknown, journalId: unknown): void {
    const current = this.ruleOf(eventType, role);
    const account = (typeof accountId === 'string' && accountId) || current?.accountId;
    const journal =
      (typeof journalId === 'string' && journalId) || current?.journalId || this.defaultJournal();
    if (!account || !journal) return;
    this.error.set(null);
    this.api
      .saveRule({
        organizationId: this.organizationId(),
        eventType,
        role,
        accountId: account,
        journalId: journal,
      })
      .subscribe({
        next: () => {
          this.notice.set('Regra guardada.');
          this.tick.update((t) => t + 1);
        },
        error: (e: unknown) =>
          this.error.set(accountingError(e, 'Não foi possível guardar a regra.')),
      });
  }
}

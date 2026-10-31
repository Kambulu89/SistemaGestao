import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { AccountingApi, type AccountDto } from './accounting.api';
import { NATURE_LABEL, accountingError, suggestParent, treeOf } from './accounting-model';

/** Plano de contas da empresa em árvore: cabeçalhos agregam, contas de movimento recebem lançamentos. */
@Component({
  selector: 'app-chart-tab',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Checkbox,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Select,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <p class="text-sm text-fg-muted">
        O modelo cria as oito classes do PGC angolano e os diários habituais; as subcontas
        definem-se aqui, validadas por quem conhece a empresa.
      </p>
      @if (canManage()) {
        <div class="ml-auto flex gap-2">
          <app-button variant="secondary" (click)="applyTemplate()">Aplicar modelo PGC</app-button>
          <app-button (click)="openForm(null)">Nova conta</app-button>
        </div>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (accounts.isLoading() && !accounts.hasValue()) {
        <app-loading-state label="A carregar o plano de contas…" />
      } @else if (accounts.error()) {
        <div class="p-5">
          <app-alert tone="danger">{{ describe(accounts.error()) }}</app-alert>
        </div>
      } @else if (tree().length === 0) {
        <app-empty-state icon="document" title="Plano de contas vazio: aplique o modelo" />
      } @else {
        <table class="w-full text-sm" data-testid="chart">
          <caption class="sr-only">
            Plano de contas
          </caption>
          <thead>
            <tr class="border-b border-line text-left text-xs text-fg-muted">
              <th class="p-2">Código</th>
              <th class="p-2">Nome</th>
              <th class="p-2">Natureza</th>
              <th class="p-2">Tipo</th>
              <th class="p-2"></th>
            </tr>
          </thead>
          <tbody>
            @for (row of tree(); track row.account.id) {
              <tr
                class="border-b border-line"
                [class.font-semibold]="row.account.kind === 'HEADER'"
                [class.opacity-60]="!row.account.active"
              >
                <td class="p-2 font-mono" [style.padding-left.rem]="0.5 + row.depth * 1.25">
                  {{ row.account.code }}
                </td>
                <td class="p-2">
                  {{ row.account.name }}
                  @if (row.account.requiresCostCenter) {
                    <app-badge tone="neutral" class="ml-1">centro de custo</app-badge>
                  }
                  @if (row.account.requiresParty) {
                    <app-badge tone="neutral" class="ml-1">terceiro</app-badge>
                  }
                </td>
                <td class="p-2">{{ natureLabel[row.account.nature] }}</td>
                <td class="p-2">
                  {{ row.account.kind === 'HEADER' ? 'Agregadora' : 'Movimento' }}
                </td>
                <td class="p-2 text-right">
                  @if (canManage()) {
                    <button type="button" class="text-xs underline" (click)="openForm(row.account)">
                      Editar
                    </button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </app-card>

    <app-dialog
      [open]="formOpen()"
      [title]="editing() ? 'Editar conta' : 'Nova conta'"
      (closed)="formOpen.set(false)"
    >
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block" data-testid="account-error">{{
          text
        }}</app-alert>
      }
      <div class="space-y-3" data-testid="account-form">
        @if (!editing()) {
          <app-input
            label="Código"
            hint="Algarismos e pontos, por exemplo 31.1.2"
            [ngModel]="code()"
            (ngModelChange)="setCode($event ?? '')"
          />
          <app-select
            label="Conta-mãe"
            placeholder="(nenhuma)"
            [options]="parentOptions()"
            [ngModel]="parentId()"
            (ngModelChange)="parentId.set($event ?? '')"
          />
        }
        <app-input label="Nome" [ngModel]="name()" (ngModelChange)="name.set($event ?? '')" />
        @if (!editing()) {
          <div class="grid gap-3 sm:grid-cols-2">
            <app-select
              label="Natureza"
              [options]="natureOptions"
              [ngModel]="nature()"
              (ngModelChange)="nature.set(($event ?? 'DEBIT') + '')"
            />
            <app-select
              label="Tipo"
              [options]="kindOptions"
              [ngModel]="kind()"
              (ngModelChange)="kind.set(($event ?? 'POSTING') + '')"
            />
          </div>
        }
        <app-checkbox
          label="Exige centro de custo"
          [ngModel]="requiresCostCenter()"
          (ngModelChange)="requiresCostCenter.set($event === true)"
        />
        <app-checkbox
          label="Exige terceiro (cliente, fornecedor…)"
          [ngModel]="requiresParty()"
          (ngModelChange)="requiresParty.set($event === true)"
        />
        @if (editing()) {
          <app-checkbox
            label="Activa"
            [ngModel]="active()"
            (ngModelChange)="active.set($event === true)"
          />
        }
      </div>
      <ng-container dialogActions>
        @if (editing(); as account) {
          <app-button variant="ghost" (click)="remove(account)">Apagar</app-button>
        }
        <app-button variant="secondary" (click)="formOpen.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="save()">Guardar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class ChartTab {
  private readonly api = inject(AccountingApi);
  private readonly permissions = inject(PermissionService);

  readonly organizationId = input.required<string>();

  protected readonly natureLabel = NATURE_LABEL;
  protected readonly natureOptions: readonly SelectOption[] = [
    { value: 'DEBIT', label: 'Devedora' },
    { value: 'CREDIT', label: 'Credora' },
  ];
  protected readonly kindOptions: readonly SelectOption[] = [
    { value: 'POSTING', label: 'Movimento (recebe lançamentos)' },
    { value: 'HEADER', label: 'Agregadora (só soma subcontas)' },
  ];
  protected readonly canManage = computed(() => this.permissions.can('accounting.manage'));
  private readonly tick = signal(0);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  protected readonly accounts = rxResource({
    params: () => ({ organizationId: this.organizationId(), tick: this.tick() }),
    stream: ({ params }) => this.api.accounts(params.organizationId),
  });
  private readonly list = computed<readonly AccountDto[]>(() =>
    this.accounts.hasValue() ? this.accounts.value() : [],
  );
  protected readonly tree = computed(() => treeOf(this.list()));
  protected readonly parentOptions = computed<readonly SelectOption[]>(() =>
    this.list()
      .filter((a) => a.kind === 'HEADER')
      .map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
  );

  protected readonly formOpen = signal(false);
  protected readonly editing = signal<AccountDto | null>(null);
  protected readonly code = signal('');
  protected readonly parentId = signal('');
  protected readonly name = signal('');
  protected readonly nature = signal<string>('DEBIT');
  protected readonly kind = signal<string>('POSTING');
  protected readonly requiresCostCenter = signal(false);
  protected readonly requiresParty = signal(false);
  protected readonly active = signal(true);
  protected readonly formError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected describe = (e: unknown) => accountingError(e, 'Pedido falhado.');

  /** Ao escrever o código, sugere-se a conta-mãe e a natureza dela. */
  protected setCode(value: string): void {
    this.code.set(value);
    const parent = suggestParent(this.list(), value.trim());
    if (parent) {
      this.parentId.set(parent.id);
      this.nature.set(parent.nature);
    }
  }

  protected openForm(account: AccountDto | null): void {
    this.formError.set(null);
    this.editing.set(account);
    this.code.set(account?.code ?? '');
    this.parentId.set(account?.parentId ?? '');
    this.name.set(account?.name ?? '');
    this.nature.set(account?.nature ?? 'DEBIT');
    this.kind.set(account?.kind ?? 'POSTING');
    this.requiresCostCenter.set(account?.requiresCostCenter ?? false);
    this.requiresParty.set(account?.requiresParty ?? false);
    this.active.set(account?.active ?? true);
    this.formOpen.set(true);
  }

  private run<T>(call: Observable<T>, message: string, close: boolean): void {
    this.busy.set(true);
    this.actionError.set(null);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        if (close) this.formOpen.set(false);
        this.notice.set(message);
        this.tick.update((t) => t + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        if (this.formOpen()) this.formError.set(this.describe(e));
        else this.actionError.set(this.describe(e));
      },
    });
  }

  protected save(): void {
    const account = this.editing();
    if (account) {
      this.run(
        this.api.updateAccount(account.id, {
          version: account.version,
          name: this.name(),
          requiresCostCenter: this.requiresCostCenter(),
          requiresParty: this.requiresParty(),
          active: this.active(),
        }),
        'Conta actualizada.',
        true,
      );
      return;
    }
    this.run(
      this.api.createAccount({
        organizationId: this.organizationId(),
        code: this.code().trim(),
        name: this.name(),
        nature: this.nature() as 'DEBIT' | 'CREDIT',
        kind: this.kind() as 'HEADER' | 'POSTING',
        parentId: this.parentId() || null,
        requiresCostCenter: this.requiresCostCenter(),
        requiresParty: this.requiresParty(),
      }),
      'Conta criada.',
      true,
    );
  }

  protected remove(account: AccountDto): void {
    this.run(this.api.deleteAccount(account.id), 'Conta apagada.', true);
  }

  protected applyTemplate(): void {
    this.busy.set(true);
    this.actionError.set(null);
    this.api.applyTemplate(this.organizationId()).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.notice.set(
          r.accounts + r.journals === 0
            ? 'O modelo já estava aplicado: nada mudou.'
            : `Modelo aplicado: ${r.accounts} classes e ${r.journals} diários criados.`,
        );
        this.tick.update((t) => t + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.actionError.set(this.describe(e));
      },
    });
  }
}

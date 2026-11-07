import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ConfirmService } from '../ui/confirm';
import { formatDate } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  ASSET_STATUS,
  type AssetClass,
  assetActions,
  type FixedAsset,
  lifeText,
  METHOD_LABELS,
  MOVEMENT_LABELS,
  normalizeAmount,
} from './model';
import { accountingDeps, entityReferences, moneyText } from './shared';
import { ApiError } from '../core/api';

interface Option {
  id: string;
  label: string;
}
type Dialog = 'acquire' | 'transfer' | 'dispose' | 'reverseAcquisition' | 'reverseDisposal';

const DIALOG_TITLES: Record<Dialog, string> = {
  acquire: 'Contabilizar aquisição',
  transfer: 'Transferir',
  dispose: 'Abater',
  reverseAcquisition: 'Anular aquisição',
  reverseDisposal: 'Anular abate',
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Ficha do activo fixo. Por contabilizar, tudo se altera; em uso, só os dados descritivos (a localização muda por
 * transferência). As acções que mexem no razão abrem uma janela com os dados do lançamento.
 */
@Component({
  selector: 'app-asset-detail',
  imports: [
    FormsModule,
    RouterLink,
    PageHeader,
    ErrorAlert,
    ErrorState,
    Skeleton,
    FormSection,
    FormField,
    FieldControl,
    Modal,
  ],
  template: `
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="reload()" />
    } @else if (!loaded()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      <app-page-header
        [title]="asset() ? asset()!.number + ' — ' + asset()!.name : 'Novo activo'"
        [subtitle]="
          asset()
            ? statusText() + (asset()!.class ? ' · ' + asset()!.class!.name : '')
            : 'Registe a ficha; a aquisição é contabilizada a seguir.'
        "
      >
        <a class="btn-secondary" routerLink="/contabilidade/activos">Voltar</a>
        @if (actions().acquire) {
          <button type="button" class="btn-primary" (click)="open('acquire')">
            Contabilizar aquisição
          </button>
        }
        @if (actions().transfer) {
          <button type="button" class="btn-secondary" (click)="open('transfer')">Transferir</button>
        }
        @if (actions().dispose) {
          <button type="button" class="btn-secondary" (click)="open('dispose')">Abater</button>
        }
        @if (actions().reverseAcquisition) {
          <button type="button" class="btn-secondary" (click)="open('reverseAcquisition')">
            Anular aquisição
          </button>
        }
        @if (actions().reverseDisposal) {
          <button type="button" class="btn-secondary" (click)="open('reverseDisposal')">
            Anular abate
          </button>
        }
        @if (actions().remove) {
          <button type="button" class="btn-danger" (click)="remove()">Apagar</button>
        }
      </app-page-header>

      @if (asset(); as a) {
        @if (a.status !== 'DRAFT') {
          <dl
            class="card mb-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4"
            data-testid="fa-summary"
          >
            <div>
              <dt class="text-muted">Custo</dt>
              <dd class="font-semibold">{{ money(a.cost) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Depreciação acumulada</dt>
              <dd class="font-semibold">{{ money(a.accumulated) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Valor líquido</dt>
              <dd class="font-semibold" data-testid="fa-book-value">{{ money(a.bookValue) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Método e vida útil</dt>
              <dd>{{ methodText(a) }} · {{ life(a.usefulLifeMonths) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Localização</dt>
              <dd>{{ a.location ?? '—' }} · {{ centerName(a.costCenterId) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Aquisição</dt>
              <dd>
                {{ date(a.acquisitionDate) }}
                @if (a.acquisitionEntryId) {
                  ·
                  <a
                    class="btn-link"
                    [routerLink]="['/contabilidade/lancamentos', a.acquisitionEntryId]"
                    >{{ a.acquisitionEntryNumber }}</a
                  >
                }
              </dd>
            </div>
            @if (a.disposalDate) {
              <div>
                <dt class="text-muted">Abate</dt>
                <dd>
                  {{ date(a.disposalDate) }} · venda {{ money(a.disposalProceeds) }} ·
                  <a
                    class="btn-link"
                    [routerLink]="['/contabilidade/lancamentos', a.disposalEntryId]"
                    >{{ a.disposalEntryNumber }}</a
                  >
                </dd>
              </div>
            }
          </dl>
        }
      }

      @if (canEdit()) {
        <form
          class="space-y-3"
          (ngSubmit)="save()"
          [attr.aria-label]="asset() ? 'Ficha do activo' : 'Novo activo'"
        >
          <app-error-alert [error]="action.error()" [showDetails]="true" />
          <app-form-section title="Identificação">
            <app-field label="Classe" [required]="true" [error]="action.field('classId')">
              <select
                appControl
                class="input"
                name="class"
                [disabled]="locked()"
                [(ngModel)]="form.classId"
                (ngModelChange)="classChanged()"
              >
                <option [ngValue]="null">—</option>
                @for (c of classes(); track c.id) {
                  <option [ngValue]="c.id">{{ c.code }} — {{ c.name }}</option>
                }
              </select>
            </app-field>
            <app-field label="N.º de inventário" [required]="true" [error]="action.field('number')">
              <input
                appControl
                class="input"
                name="number"
                [disabled]="locked()"
                [(ngModel)]="form.number"
              />
            </app-field>
            <app-field label="Designação" [required]="true" [error]="action.field('name')">
              <input appControl class="input" name="name" [(ngModel)]="form.name" />
            </app-field>
            <app-field
              label="N.º de série"
              hint="Único por entidade: bloqueia registos em duplicado."
              [error]="action.field('serialNumber')"
            >
              <input appControl class="input" name="serial" [(ngModel)]="form.serialNumber" />
            </app-field>
            <app-field label="Fornecedor" [error]="action.field('supplierName')">
              <input appControl class="input" name="supplier" [(ngModel)]="form.supplierName" />
            </app-field>
            <app-field label="Documento de aquisição" [error]="action.field('acquisitionDocument')">
              <input appControl class="input" name="doc" [(ngModel)]="form.acquisitionDocument" />
            </app-field>
            <div class="md:col-span-2">
              <app-field label="Descrição" [error]="action.field('description')">
                <textarea
                  appControl
                  class="input"
                  rows="2"
                  name="description"
                  [(ngModel)]="form.description"
                ></textarea>
              </app-field>
            </div>
          </app-form-section>
          @if (!locked()) {
            <app-form-section
              title="Aquisição e depreciação"
              description="Mês inteiro no mês de início; nada no mês do abate. Vida útil e método vêm da classe, mas podem mudar aqui."
            >
              <app-field
                label="Data de aquisição"
                [required]="true"
                [error]="action.field('acquisitionDate')"
              >
                <input
                  appControl
                  class="input"
                  type="date"
                  name="acqDate"
                  [(ngModel)]="form.acquisitionDate"
                />
              </app-field>
              <app-field
                label="Custo de aquisição"
                [required]="true"
                [error]="action.field('cost')"
              >
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  name="cost"
                  [(ngModel)]="form.cost"
                />
              </app-field>
              <app-field label="Valor residual" [error]="action.field('residualValue')">
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  name="residual"
                  [(ngModel)]="form.residualValue"
                />
              </app-field>
              <app-field
                label="Início da depreciação"
                hint="Por omissão, o mês da aquisição."
                [error]="action.field('depreciationStart')"
              >
                <input
                  appControl
                  class="input"
                  type="month"
                  name="start"
                  [(ngModel)]="form.depreciationStart"
                />
              </app-field>
              <app-field label="Método" [error]="action.field('method')">
                <select appControl class="input" name="method" [(ngModel)]="form.method">
                  <option value="STRAIGHT_LINE">Linha recta</option>
                  <option value="DECLINING_BALANCE">Degressivo</option>
                </select>
              </app-field>
              <app-field
                label="Vida útil (meses)"
                [required]="true"
                [hint]="life(form.usefulLifeMonths)"
                [error]="action.field('usefulLifeMonths')"
              >
                <input
                  appControl
                  class="input"
                  type="number"
                  min="1"
                  max="1200"
                  name="life"
                  [(ngModel)]="form.usefulLifeMonths"
                />
              </app-field>
              @if (form.method === 'DECLINING_BALANCE') {
                <app-field
                  label="Coeficiente degressivo"
                  hint="Entre 1,00 e 4,00."
                  [error]="action.field('decliningFactor')"
                >
                  <input
                    appControl
                    class="input"
                    inputmode="decimal"
                    name="factor"
                    [(ngModel)]="form.decliningFactor"
                  />
                </app-field>
              }
              <app-field label="Localização" [error]="action.field('location')">
                <input appControl class="input" name="location" [(ngModel)]="form.location" />
              </app-field>
              <app-field label="Centro de custo" [error]="action.field('costCenterId')">
                <select appControl class="input" name="cc" [(ngModel)]="form.costCenterId">
                  <option [ngValue]="null">—</option>
                  @for (c of centers(); track c.id) {
                    <option [ngValue]="c.id">{{ c.label }}</option>
                  }
                </select>
              </app-field>
            </app-form-section>
          }
          <button type="submit" class="btn-primary" [disabled]="action.busy()">
            {{ asset() ? 'Guardar ficha' : 'Criar activo' }}
          </button>
        </form>
      }

      @if (asset()?.schedule?.length) {
        <section class="card mt-4 overflow-x-auto p-0" aria-labelledby="fa-schedule">
          <h2 id="fa-schedule" class="p-3 font-semibold">Mapa de depreciação</h2>
          <table class="w-full min-w-[36rem] text-sm">
            <thead>
              <tr class="border-b border-border text-left">
                <th scope="col" class="p-2">Mês</th>
                <th scope="col" class="p-2 text-right">Quota</th>
                <th scope="col" class="p-2 text-right">Acumulado</th>
                <th scope="col" class="p-2 text-right">Valor líquido</th>
                <th scope="col" class="p-2">Lançamento</th>
              </tr>
            </thead>
            <tbody>
              @for (s of asset()!.schedule; track s.month) {
                <tr class="border-b border-border" [class.text-muted]="!s.posted">
                  <td class="p-2">{{ s.month }}</td>
                  <td class="p-2 text-right">{{ money(s.amount) }}</td>
                  <td class="p-2 text-right">{{ money(s.accumulated) }}</td>
                  <td class="p-2 text-right">{{ money(s.bookValue) }}</td>
                  <td class="p-2">
                    @if (s.entryId) {
                      <a
                        class="btn-link"
                        [routerLink]="['/contabilidade/lancamentos', s.entryId]"
                        >{{ s.entryNumber }}</a
                      >
                    } @else {
                      previsto
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }

      @if (asset()?.movements?.length) {
        <section class="card mt-4" aria-labelledby="fa-moves">
          <h2 id="fa-moves" class="mb-2 font-semibold">Movimentos</h2>
          <ul class="divide-y divide-border text-sm" data-testid="fa-movements">
            @for (m of asset()!.movements; track m.id) {
              <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <strong>{{ movementText(m.type) }}</strong> · {{ date(m.date) }}
                  @if (m.type === 'TRANSFER') {
                    · {{ m.fromLocation ?? '—' }} → {{ m.toLocation ?? '—' }}
                    @if (m.fromCostCenterId !== m.toCostCenterId) {
                      ({{ centerName(m.fromCostCenterId) }} → {{ centerName(m.toCostCenterId) }})
                    }
                  }
                  @if (m.notes) {
                    <span class="text-muted"> — {{ m.notes }}</span>
                  }
                </span>
                @if (m.entryId) {
                  <a class="btn-link" [routerLink]="['/contabilidade/lancamentos', m.entryId]">{{
                    m.entryNumber
                  }}</a>
                }
              </li>
            }
          </ul>
        </section>
      }

      @if (dialog(); as d) {
        <app-modal [title]="dialogTitle(d)" [open]="true" (closed)="dialog.set(null)">
          <form id="fa-dialog" class="space-y-3" (ngSubmit)="submit(d)">
            <app-error-alert [error]="dialogAction.error()" [showDetails]="true" />
            <app-field label="Data" [required]="true" [error]="dialogAction.field('date')">
              <input appControl class="input" type="date" name="date" [(ngModel)]="dlg.date" />
            </app-field>
            @if (d === 'acquire') {
              <app-field
                label="Conta de contrapartida"
                [required]="true"
                hint="Fornecedor, banco ou imobilizado em curso."
                [error]="dialogAction.field('counterpartAccountId')"
              >
                <select appControl class="input" name="counterpart" [(ngModel)]="dlg.accountId">
                  <option [ngValue]="null">—</option>
                  @for (o of accounts(); track o.id) {
                    <option [ngValue]="o.id">{{ o.label }}</option>
                  }
                </select>
              </app-field>
              <app-field
                label="Terceiro"
                hint="Se a conta o exigir."
                [error]="dialogAction.field('thirdPartyRef')"
              >
                <input appControl class="input" name="third" [(ngModel)]="dlg.thirdPartyRef" />
              </app-field>
            }
            @if (d === 'transfer') {
              <app-field label="Nova localização" [error]="dialogAction.field('location')">
                <input appControl class="input" name="location" [(ngModel)]="dlg.location" />
              </app-field>
              <app-field label="Novo centro de custo" [error]="dialogAction.field('costCenterId')">
                <select appControl class="input" name="cc" [(ngModel)]="dlg.costCenterId">
                  <option [ngValue]="null">—</option>
                  @for (c of centers(); track c.id) {
                    <option [ngValue]="c.id">{{ c.label }}</option>
                  }
                </select>
              </app-field>
            }
            @if (d === 'dispose') {
              <app-field
                label="Valor de venda"
                hint="Zero para abate sem venda."
                [error]="dialogAction.field('proceeds')"
              >
                <input
                  appControl
                  class="input"
                  inputmode="decimal"
                  name="proceeds"
                  [(ngModel)]="dlg.proceeds"
                />
              </app-field>
              @if (hasProceeds()) {
                <app-field
                  label="Conta do valor de venda"
                  [required]="true"
                  [error]="dialogAction.field('proceedsAccountId')"
                >
                  <select
                    appControl
                    class="input"
                    name="proceedsAccount"
                    [(ngModel)]="dlg.accountId"
                  >
                    <option [ngValue]="null">—</option>
                    @for (o of accounts(); track o.id) {
                      <option [ngValue]="o.id">{{ o.label }}</option>
                    }
                  </select>
                </app-field>
              }
            }
            @if (d !== 'acquire') {
              <app-field
                [label]="d === 'transfer' ? 'Notas' : 'Motivo'"
                [required]="d === 'dispose'"
                [error]="dialogAction.field('reason')"
              >
                <input appControl class="input" name="reason" [(ngModel)]="dlg.reason" />
              </app-field>
            }
            @if (d === 'reverseAcquisition' || d === 'reverseDisposal') {
              <p class="text-sm text-muted">
                É feito um estorno do lançamento nesta data (com período aberto); o original não se
                altera.
              </p>
            }
          </form>
          <ng-container actions>
            <button type="button" class="btn-secondary" (click)="dialog.set(null)">Cancelar</button>
            <button
              type="submit"
              form="fa-dialog"
              class="btn-primary"
              [disabled]="dialogAction.busy()"
            >
              {{ dialogTitle(d) }}
            </button>
          </ng-container>
        </app-modal>
      }
    }
  `,
})
export class AssetDetail {
  readonly id = input.required<string>();
  private readonly deps = accountingDeps();
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly asset = signal<FixedAsset | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly classes = signal<AssetClass[]>([]);
  protected readonly accounts = signal<Option[]>([]);
  protected readonly centers = signal<Option[]>([]);
  protected readonly dialog = signal<Dialog | null>(null);
  protected readonly action = new Action();
  protected readonly dialogAction = new Action();
  protected form = this.blank();
  protected dlg = this.blankDialog();
  private refRequest = 0;
  protected readonly actions = computed(() => {
    const a = this.asset();
    const can = (p: string) => this.deps.workspace.can(p);
    return a
      ? assetActions(a, can)
      : {
          edit: can('fixed_assets.manage'),
          remove: false,
          acquire: false,
          transfer: false,
          dispose: false,
          reverseAcquisition: false,
          reverseDisposal: false,
        };
  });
  protected readonly canEdit = computed(() => this.actions().edit);
  /** Em uso: só os dados descritivos mudam. */
  protected readonly locked = computed(() => !!this.asset() && this.asset()!.status !== 'DRAFT');
  protected readonly statusText = computed(() =>
    this.asset() ? ASSET_STATUS[this.asset()!.status] : '',
  );
  private readonly centerNames = computed(
    () => new Map(this.centers().map((c) => [c.id, c.label])),
  );

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  protected reload() {
    void this.load(this.id());
  }

  private blank() {
    return {
      classId: null as string | null,
      number: '',
      name: '',
      description: '',
      serialNumber: '',
      supplierName: '',
      acquisitionDocument: '',
      acquisitionDate: today(),
      cost: '',
      residualValue: '0',
      depreciationStart: '',
      method: 'STRAIGHT_LINE' as FixedAsset['method'],
      usefulLifeMonths: 60 as number | null,
      decliningFactor: '2.00',
      location: '',
      costCenterId: null as string | null,
    };
  }

  private blankDialog() {
    return {
      date: today(),
      accountId: null as string | null,
      thirdPartyRef: '',
      location: '',
      costCenterId: null as string | null,
      proceeds: '0',
      reason: '',
    };
  }

  private async load(id: string) {
    this.loaded.set(false);
    this.loadError.set(null);
    try {
      const classes = (
        await this.deps.api.page<AssetClass>('accounting/fixed-asset-classes', { limit: 200 })
      ).items;
      const asset =
        id === 'novo' ? null : await this.deps.api.get<FixedAsset>(`accounting/fixed-assets/${id}`);
      this.classes.set(classes.filter((c) => c.status === 'ACTIVE' || c.id === asset?.classId));
      this.setAsset(asset);
      await this.loadRefs();
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private setAsset(a: FixedAsset | null) {
    this.asset.set(a);
    if (!a) {
      this.form = this.blank();
      if (this.classes().length === 1) {
        this.form.classId = this.classes()[0].id;
        this.applyClass();
      }
      return;
    }
    this.form = {
      classId: a.classId,
      number: a.number,
      name: a.name,
      description: a.description ?? '',
      serialNumber: a.serialNumber ?? '',
      supplierName: a.supplierName ?? '',
      acquisitionDocument: a.acquisitionDocument ?? '',
      acquisitionDate: a.acquisitionDate,
      cost: a.cost,
      residualValue: a.residualValue,
      depreciationStart: a.depreciationStart,
      method: a.method,
      usefulLifeMonths: a.usefulLifeMonths,
      decliningFactor: a.decliningFactor ?? '2.00',
      location: a.location ?? '',
      costCenterId: a.costCenterId,
    };
  }

  private entityId() {
    return (
      this.asset()?.legalEntityId ??
      this.classes().find((c) => c.id === this.form.classId)?.legalEntityId ??
      null
    );
  }

  private async loadRefs() {
    const le = this.entityId();
    const request = ++this.refRequest;
    if (!le) {
      this.accounts.set([]);
      this.centers.set([]);
      return;
    }
    const refs = await entityReferences(this.deps.api, this.deps.workspace, le);
    if (request !== this.refRequest) return;
    this.accounts.set(refs.accounts);
    this.centers.set(refs.centers);
  }

  private applyClass() {
    const c = this.classes().find((x) => x.id === this.form.classId);
    if (!c) return;
    this.form.method = c.method;
    this.form.usefulLifeMonths = c.usefulLifeMonths;
    this.form.decliningFactor = c.decliningFactor ?? '2.00';
  }

  protected classChanged() {
    this.applyClass();
    this.form.costCenterId = null;
    void this.loadRefs();
  }

  protected money(v: string | null) {
    return moneyText(v);
  }
  protected date(v: string | null) {
    return v ? formatDate(v) : '—';
  }
  protected life(m: number | null) {
    return m ? lifeText(Number(m)) : null;
  }
  protected methodText(a: FixedAsset) {
    return METHOD_LABELS[a.method] + (a.decliningFactor ? ` (${a.decliningFactor})` : '');
  }
  protected movementText(t: string) {
    return MOVEMENT_LABELS[t] ?? t;
  }
  protected centerName(id: string | null) {
    return id ? (this.centerNames().get(id) ?? 'centro de custo') : 'sem centro';
  }
  protected dialogTitle(d: Dialog) {
    return DIALOG_TITLES[d];
  }
  protected hasProceeds() {
    // Qualquer dígito diferente de zero: há valor de venda (sem converter para float).
    return /[1-9]/.test(normalizeAmount(this.dlg.proceeds));
  }

  protected async save() {
    const a = this.asset();
    const f = this.form;
    const descriptive = {
      name: f.name,
      description: f.description,
      serialNumber: f.serialNumber,
      supplierName: f.supplierName,
      acquisitionDocument: f.acquisitionDocument,
    };
    const full = {
      ...descriptive,
      classId: f.classId,
      number: f.number,
      acquisitionDate: f.acquisitionDate,
      cost: normalizeAmount(f.cost),
      residualValue: normalizeAmount(f.residualValue || '0'),
      depreciationStart: f.depreciationStart || undefined,
      method: f.method,
      usefulLifeMonths: Number(f.usefulLifeMonths),
      decliningFactor:
        f.method === 'DECLINING_BALANCE' ? normalizeAmount(f.decliningFactor) : undefined,
      location: f.location,
      costCenterId: f.costCenterId,
    };
    const result = await this.action.run(() =>
      a
        ? this.deps.api.patch<FixedAsset>(`accounting/fixed-assets/${a.id}`, {
            expectedVersion: a.version,
            ...(a.status === 'DRAFT' ? full : descriptive),
          })
        : this.deps.api.post<FixedAsset>('accounting/fixed-assets', full),
    );
    if (!result) return;
    this.toasts.show(a ? 'Ficha guardada.' : 'Activo criado.');
    if (!a) await this.router.navigate(['/contabilidade/activos', result.id]);
    else this.setAsset(result);
  }

  protected open(d: Dialog) {
    const a = this.asset()!;
    this.dlg = this.blankDialog();
    if (d === 'acquire') this.dlg.date = a.acquisitionDate;
    if (d === 'transfer') {
      this.dlg.location = a.location ?? '';
      this.dlg.costCenterId = a.costCenterId;
    }
    this.dialogAction.error.set(null);
    this.dialog.set(d);
  }

  protected async submit(d: Dialog) {
    const a = this.asset()!;
    const base = { expectedVersion: a.version, date: this.dlg.date };
    const routes: Record<Dialog, [string, Record<string, unknown>]> = {
      acquire: [
        'acquire',
        {
          ...base,
          counterpartAccountId: this.dlg.accountId,
          thirdPartyRef: this.dlg.thirdPartyRef,
        },
      ],
      transfer: [
        'transfer',
        {
          ...base,
          location: this.dlg.location,
          costCenterId: this.dlg.costCenterId,
          notes: this.dlg.reason,
        },
      ],
      dispose: [
        'dispose',
        {
          ...base,
          proceeds: normalizeAmount(this.dlg.proceeds || '0'),
          proceedsAccountId: this.hasProceeds() ? this.dlg.accountId : undefined,
          reason: this.dlg.reason,
        },
      ],
      reverseAcquisition: ['reverse-acquisition', { ...base, reason: this.dlg.reason }],
      reverseDisposal: ['reverse-disposal', { ...base, reason: this.dlg.reason }],
    };
    const [path, body] = routes[d];
    const result = await this.dialogAction.run(() =>
      this.deps.api.post<FixedAsset>(`accounting/fixed-assets/${a.id}/${path}`, body),
    );
    if (!result) return;
    this.dialog.set(null);
    this.setAsset(result);
    this.toasts.show(`${DIALOG_TITLES[d]}: feito.`);
  }

  protected async remove() {
    const a = this.asset()!;
    const ok = await this.confirm.ask({
      title: 'Apagar activo',
      message: `Apagar a ficha ${a.number}? Só fichas por contabilizar se apagam.`,
      confirmLabel: 'Apagar',
      danger: true,
    });
    if (!ok) return;
    const done = await this.action.run(() =>
      this.deps.api.delete(`accounting/fixed-assets/${a.id}`),
    );
    if (done === undefined && this.action.error()) return;
    this.toasts.show('Activo apagado.');
    await this.router.navigate(['/contabilidade/activos']);
  }
}

import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { AuditHistory } from '../ui/audit-history';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  ACCESS_LEVEL,
  childLevel,
  LEVEL,
  type LocationLevel,
  locationRows,
  seriesPreview,
  type Warehouse,
  type WarehouseLocation,
  WAREHOUSE_TYPE,
} from './warehouse-model';

interface Option {
  id: string;
  code?: string;
  name?: string;
  legalName?: string;
  legalEntityId?: string;
}
interface Candidate {
  membershipId: string;
  name: string;
  email: string;
}

const emptyForm = () => ({
  code: '',
  name: '',
  legalEntityId: '',
  branchId: '',
  managerMembershipId: '',
  warehouseType: 'MAIN',
  addressLine: '',
  city: '',
  province: '',
  countryCode: 'AO',
  accessMode: 'OPEN' as 'OPEN' | 'RESTRICTED',
  status: 'ACTIVE',
});

/**
 * Armazém: dados (entidade legal fixa depois de criado), localizações zona → corredor → estante → posição (código e
 * superior fixos; inactivar de baixo para cima), geração de posições em série e lista de acesso dos restritos.
 */
@Component({
  selector: 'app-warehouse-form',
  imports: [
    FormsModule,
    EntityFormPage,
    FormSection,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    AuditHistory,
  ],
  template: `
    <app-entity-form-page
      [title]="isNew() ? 'Novo armazém' : (w()?.code ?? '') + ' — ' + (w()?.name ?? '')"
      [subtitle]="isNew() ? 'A entidade legal não muda depois de criado.' : typeLabel()"
      formId="warehouse-form"
      [loading]="!loaded()"
      [loadError]="loadError()"
      [saveError]="action.error()"
      [busy]="action.busy()"
      [dirty]="hasUnsavedChanges()"
      [saveLabel]="isNew() ? 'Criar armazém' : 'Guardar'"
      (save)="save()"
      (cancelled)="cancel()"
      (retry)="load()"
    >
      <app-form-section
        title="Armazém"
        description="Código único, entidade legal, filial da mesma entidade e responsável."
      >
        <app-field label="Código" [required]="true" [error]="action.field('code')">
          <input
            appControl
            class="input uppercase"
            data-testid="wf-code"
            name="code"
            [(ngModel)]="f.code"
            [disabled]="!isNew()"
          />
        </app-field>
        <app-field label="Nome" [required]="true" [error]="action.field('name')">
          <input
            appControl
            class="input"
            data-testid="wf-name"
            name="name"
            [(ngModel)]="f.name"
            [disabled]="!canManage()"
          />
        </app-field>
        <app-field label="Entidade legal" [required]="true" [error]="action.field('legalEntityId')">
          <select
            appControl
            class="input"
            data-testid="wf-le"
            name="legalEntityId"
            [(ngModel)]="f.legalEntityId"
            [disabled]="!isNew()"
            (ngModelChange)="f.branchId = ''"
          >
            <option value="">—</option>
            @for (e of entities(); track e.id) {
              <option [value]="e.id">{{ e.code }} — {{ e.legalName }}</option>
            }
          </select>
        </app-field>
        <app-field label="Filial" [error]="action.field('branchId')">
          <select
            appControl
            class="input"
            data-testid="wf-branch"
            name="branchId"
            [(ngModel)]="f.branchId"
            [disabled]="!canManage()"
          >
            <option value="">—</option>
            @for (b of branchOptions(); track b.id) {
              <option [value]="b.id">{{ b.code }} — {{ b.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Tipo" [required]="true" [error]="action.field('warehouseType')">
          <select
            appControl
            class="input"
            data-testid="wf-type"
            name="warehouseType"
            [(ngModel)]="f.warehouseType"
            [disabled]="!canManage()"
          >
            @for (t of types; track t[0]) {
              <option [value]="t[0]">{{ t[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Responsável" [error]="action.field('managerMembershipId')">
          <select
            appControl
            class="input"
            data-testid="wf-manager"
            name="managerMembershipId"
            [(ngModel)]="f.managerMembershipId"
            [disabled]="!canManage()"
          >
            <option value="">—</option>
            @for (c of candidates(); track c.membershipId) {
              <option [value]="c.membershipId">{{ c.name }} ({{ c.email }})</option>
            }
          </select>
        </app-field>
        @if (!isNew()) {
          <app-field label="Estado" [error]="action.field('status')">
            <select
              appControl
              class="input"
              name="status"
              [(ngModel)]="f.status"
              [disabled]="!canManage()"
            >
              <option value="ACTIVE">Activo</option>
              <option value="INACTIVE">Inactivo</option>
            </select>
          </app-field>
        }
      </app-form-section>

      <app-form-section title="Morada">
        <app-field label="Morada" [error]="action.field('addressLine')">
          <input
            appControl
            class="input"
            name="addressLine"
            [(ngModel)]="f.addressLine"
            [disabled]="!canManage()"
          />
        </app-field>
        <app-field label="Cidade" [error]="action.field('city')">
          <input
            appControl
            class="input"
            name="city"
            [(ngModel)]="f.city"
            [disabled]="!canManage()"
          />
        </app-field>
        <app-field label="Província" [error]="action.field('province')">
          <input
            appControl
            class="input"
            name="province"
            [(ngModel)]="f.province"
            [disabled]="!canManage()"
          />
        </app-field>
        <app-field label="País (ISO)" [error]="action.field('countryCode')">
          <input
            appControl
            class="input uppercase"
            maxlength="2"
            name="countryCode"
            [(ngModel)]="f.countryCode"
            [disabled]="!canManage()"
          />
        </app-field>
      </app-form-section>

      <app-form-section
        title="Acesso"
        description="Aberto: quem tem as permissões de inventário no âmbito. Restrito: só quem gere e os membros da lista."
      >
        <app-field label="Modo de acesso" [error]="action.field('accessMode')">
          <select
            appControl
            class="input"
            data-testid="wf-mode"
            name="accessMode"
            [(ngModel)]="f.accessMode"
            [disabled]="!canManage()"
          >
            <option value="OPEN">Aberto</option>
            <option value="RESTRICTED">Restrito</option>
          </select>
        </app-field>
      </app-form-section>

      @if (w(); as x) {
        <section class="card" aria-labelledby="wf-locs">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="wf-locs" class="font-semibold">
              Localizações ({{ x.locations?.length ?? 0 }})
            </h2>
            @if (canManage()) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="wf-add-zone"
                (click)="openLocation(null)"
              >
                Nova zona
              </button>
            }
          </div>
          @if (!rows().length) {
            <p class="text-sm text-muted">Sem localizações: o stock fica no armazém sem posição.</p>
          }
          <ul class="divide-y divide-border text-sm" data-testid="wf-tree">
            @for (l of rows(); track l.id) {
              <li
                class="flex flex-wrap items-center justify-between gap-2 py-1.5"
                [style.padding-left.rem]="l.depth * 1.25"
              >
                <span [class.text-muted]="l.status !== 'ACTIVE'">
                  <span class="font-mono">{{ l.pathCode }}</span>
                  <span class="text-xs text-muted">
                    · {{ level(l.level) }}{{ l.name ? ' · ' + l.name : ''
                    }}{{ l.holdsStock ? ' · guarda stock' : ''
                    }}{{ l.status !== 'ACTIVE' ? ' · inactiva' : '' }}</span
                  >
                </span>
                @if (canManage()) {
                  <span class="flex gap-3">
                    @if (l.status === 'ACTIVE' && next(l.level)) {
                      <button
                        type="button"
                        class="link"
                        [attr.aria-label]="'Adicionar abaixo de ' + l.pathCode"
                        (click)="openLocation(l)"
                      >
                        + {{ level(next(l.level)!) }}
                      </button>
                    }
                    <button
                      type="button"
                      class="link"
                      [attr.aria-label]="
                        (l.status === 'ACTIVE' ? 'Inactivar ' : 'Reactivar ') + l.pathCode
                      "
                      (click)="toggle(l)"
                    >
                      {{ l.status === 'ACTIVE' ? 'Inactivar' : 'Reactivar' }}
                    </button>
                  </span>
                }
              </li>
            }
          </ul>
        </section>

        @if (x.members !== null && x.members !== undefined) {
          <section class="card" aria-labelledby="wf-access" data-testid="wf-access">
            <h2 id="wf-access" class="mb-1 font-semibold">Lista de acesso</h2>
            <p class="mb-3 text-xs text-muted">
              {{
                x.accessMode === 'RESTRICTED'
                  ? 'Só estes membros (e quem gere) vêem o armazém.'
                  : 'Usada quando o armazém for restrito.'
              }}
            </p>
            <ul class="divide-y divide-border text-sm">
              @for (m of x.members; track m.id) {
                <li class="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span
                    >{{ m.name }} <span class="text-xs text-muted">{{ m.email }}</span></span
                  >
                  <span class="flex items-center gap-3">
                    <span class="badge bg-info-soft text-info-text">{{
                      accessLabel(m.level)
                    }}</span>
                    <button
                      type="button"
                      class="link"
                      [attr.aria-label]="'Retirar ' + m.name"
                      (click)="setAccess(m.membershipId, null)"
                    >
                      Retirar
                    </button>
                  </span>
                </li>
              } @empty {
                <li class="py-1.5 text-muted">Ninguém na lista.</li>
              }
            </ul>
            <div class="mt-3 flex flex-wrap items-end gap-2">
              <label class="text-sm">
                <span class="label">Membro</span>
                <select
                  class="input w-64"
                  data-testid="wf-acc-member"
                  [(ngModel)]="acc.membershipId"
                  [ngModelOptions]="{ standalone: true }"
                >
                  <option value="">—</option>
                  @for (c of candidates(); track c.membershipId) {
                    <option [value]="c.membershipId">{{ c.name }}</option>
                  }
                </select>
              </label>
              <label class="text-sm">
                <span class="label">Acesso</span>
                <select
                  class="input w-36"
                  data-testid="wf-acc-level"
                  [(ngModel)]="acc.level"
                  [ngModelOptions]="{ standalone: true }"
                >
                  <option value="VIEW">Consultar</option>
                  <option value="OPERATE">Operar</option>
                </select>
              </label>
              <button
                type="button"
                class="btn-secondary"
                data-testid="wf-acc-add"
                [disabled]="!acc.membershipId"
                (click)="setAccess(acc.membershipId, acc.level)"
              >
                Dar acesso
              </button>
            </div>
          </section>
        }

        <section class="card" aria-labelledby="wf-history">
          <h2 id="wf-history" class="mb-3 font-semibold">Histórico</h2>
          <app-audit-history entityType="warehouse" [entityId]="x.id" [refreshKey]="x.version" />
        </section>
      }
    </app-entity-form-page>

    <app-modal
      [title]="
        'Nova ' + level(loc.level).toLowerCase() + (loc.parent ? ' em ' + loc.parent.pathCode : '')
      "
      [open]="locOpen()"
      (closed)="locOpen.set(false)"
    >
      <app-error-alert [error]="locAction.error()" [showDetails]="false" />
      <div class="space-y-3">
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="lc-series"
            [(ngModel)]="loc.series"
            [ngModelOptions]="{ standalone: true }"
          />
          Gerar em série
        </label>
        @if (!loc.series) {
          <app-field
            label="Código"
            [required]="true"
            hint="Letras maiúsculas, dígitos ou _; não muda depois."
            [error]="locAction.field('code')"
          >
            <input
              appControl
              class="input uppercase"
              data-testid="lc-code"
              [(ngModel)]="loc.code"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Nome" [error]="locAction.field('name')">
            <input
              appControl
              class="input"
              [(ngModel)]="loc.name"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        } @else {
          <div class="grid gap-3 sm:grid-cols-4">
            <app-field label="Prefixo">
              <input
                appControl
                class="input uppercase"
                data-testid="lc-prefix"
                [(ngModel)]="loc.prefix"
                [ngModelOptions]="{ standalone: true }"
              />
            </app-field>
            <app-field label="De">
              <input
                appControl
                class="input"
                type="number"
                data-testid="lc-from"
                [(ngModel)]="loc.from"
                [ngModelOptions]="{ standalone: true }"
              />
            </app-field>
            <app-field label="Até">
              <input
                appControl
                class="input"
                type="number"
                data-testid="lc-to"
                [(ngModel)]="loc.to"
                [ngModelOptions]="{ standalone: true }"
              />
            </app-field>
            <app-field label="Dígitos">
              <input
                appControl
                class="input"
                type="number"
                [(ngModel)]="loc.width"
                [ngModelOptions]="{ standalone: true }"
              />
            </app-field>
          </div>
          <p class="text-sm text-muted" data-testid="lc-preview">
            {{ preview() ?? 'Série inválida (até 200).' }}
          </p>
          @if (locAction.field('series')) {
            <p class="text-sm text-danger-text" role="alert">{{ locAction.field('series') }}</p>
          }
        }
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="lc-holds"
            [(ngModel)]="loc.holdsStock"
            [ngModelOptions]="{ standalone: true }"
          />
          Guarda stock
        </label>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="locOpen.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="lc-save"
          [disabled]="locAction.busy()"
          (click)="saveLocation()"
        >
          Criar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class WarehouseFormPage implements HasUnsavedChanges {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly w = signal<Warehouse | null>(null);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly entities = signal<Option[]>([]);
  protected readonly branches = signal<Option[]>([]);
  protected readonly candidates = signal<Candidate[]>([]);
  protected readonly action = new Action();
  protected readonly locAction = new Action();
  protected readonly locOpen = signal(false);
  protected f = emptyForm();
  private initial = snapshot(this.f);
  protected loc = this.emptyLoc(null);
  protected acc = { membershipId: '', level: 'VIEW' as 'VIEW' | 'OPERATE' };
  protected readonly types = Object.entries(WAREHOUSE_TYPE);
  protected readonly isNew = computed(() => !this.id() || this.id() === 'novo');
  protected readonly canManage = computed(() => this.isNew() || !!this.w()?.access?.manage);
  protected readonly rows = computed(() => locationRows(this.w()?.locations ?? []));
  protected readonly typeLabel = computed(() => {
    const x = this.w();
    return x
      ? `${WAREHOUSE_TYPE[x.warehouseType] ?? x.warehouseType} · ${x.legalEntity.code}${x.branch ? ' · ' + x.branch.name : ''}`
      : '';
  });
  protected readonly level = (l: LocationLevel) => LEVEL[l];
  protected readonly next = childLevel;
  protected readonly accessLabel = (l: 'VIEW' | 'OPERATE') => ACCESS_LEVEL[l];

  constructor() {
    warnOnUnload(this);
    void this.loadOptions();
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  hasUnsavedChanges() {
    return this.loaded() && this.canManage() && snapshot(this.f) !== this.initial;
  }

  protected branchOptions() {
    return this.branches().filter((b) => b.legalEntityId === this.f.legalEntityId);
  }

  protected preview() {
    return seriesPreview(
      this.loc.prefix,
      Number(this.loc.from),
      Number(this.loc.to),
      Number(this.loc.width),
    );
  }

  private async loadOptions() {
    await Promise.all([
      this.api.page<Option>('organization/legal-entities', { limit: 200 }).then(
        (p) => this.entities.set(p.items),
        () => undefined,
      ),
      this.api.page<Option>('organization/branches', { limit: 200 }).then(
        (p) => this.branches.set(p.items),
        () => undefined,
      ),
      this.api.get<Candidate[]>('inventory/warehouses/candidates').then(
        (c) => this.candidates.set(c),
        () => undefined,
      ),
    ]);
  }

  protected async load() {
    this.loadError.set(null);
    if (this.isNew()) {
      this.w.set(null);
      this.f = emptyForm();
      this.initial = snapshot(this.f);
      this.loaded.set(true);
      return;
    }
    this.loaded.set(false);
    try {
      const x = await this.api.get<Warehouse>(`inventory/warehouses/${this.id()}`);
      this.apply(x);
      this.breadcrumbs.setCurrent(x.code);
      this.loaded.set(true);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private apply(x: Warehouse) {
    this.w.set(x);
    this.f = {
      code: x.code,
      name: x.name,
      legalEntityId: x.legalEntity.id,
      branchId: x.branch?.id ?? '',
      managerMembershipId: x.manager?.membershipId ?? '',
      warehouseType: x.warehouseType,
      addressLine: x.addressLine ?? '',
      city: x.city ?? '',
      province: x.province ?? '',
      countryCode: x.countryCode ?? '',
      accessMode: x.accessMode,
      status: x.status,
    };
    this.initial = snapshot(this.f);
  }

  protected async save() {
    const x = this.w();
    const f = this.f;
    const body: Record<string, unknown> = {
      name: f.name.trim(),
      branchId: f.branchId || null,
      managerMembershipId: f.managerMembershipId || null,
      warehouseType: f.warehouseType,
      addressLine: f.addressLine.trim() || null,
      city: f.city.trim() || null,
      province: f.province.trim() || null,
      countryCode: f.countryCode.trim() || null,
      accessMode: f.accessMode,
    };
    const r = await this.action.run(() =>
      x
        ? this.api.patch<Warehouse>(`inventory/warehouses/${x.id}`, {
            ...body,
            status: f.status,
            expectedVersion: x.version,
          })
        : this.api.post<Warehouse>('inventory/warehouses', {
            ...body,
            code: f.code.trim(),
            legalEntityId: f.legalEntityId || null,
          }),
    );
    if (!r) return;
    this.apply(r);
    this.toasts.show(x ? 'Armazém guardado.' : 'Armazém criado.');
    if (!x) await this.router.navigate(['/inventario/armazens', r.id], { replaceUrl: true });
  }

  protected cancel() {
    void this.router.navigate(['/inventario/armazens']);
  }

  private emptyLoc(parent: WarehouseLocation | null) {
    const level = childLevel(parent?.level ?? null) ?? 'BIN';
    return {
      parent,
      level,
      series: false,
      code: '',
      name: '',
      prefix: level === 'BIN' ? 'P' : '',
      from: 1,
      to: 10,
      width: 2,
      holdsStock: level === 'BIN',
    };
  }

  protected openLocation(parent: WarehouseLocation | null) {
    this.locAction.error.set(null);
    this.loc = this.emptyLoc(parent);
    this.locOpen.set(true);
  }

  protected async saveLocation() {
    const x = this.w()!;
    const l = this.loc;
    const body: Record<string, unknown> = {
      parentId: l.parent?.id ?? null,
      holdsStock: l.holdsStock,
    };
    if (l.series)
      body['series'] = {
        prefix: l.prefix,
        from: Number(l.from),
        to: Number(l.to),
        width: Number(l.width),
      };
    else Object.assign(body, { code: l.code, name: l.name || null });
    const r = await this.locAction.run(() =>
      this.api.post<Warehouse>(`inventory/warehouses/${x.id}/locations`, body),
    );
    if (!r) return;
    this.locOpen.set(false);
    this.w.set(r);
    this.toasts.show('Localizações criadas.');
  }

  protected async toggle(l: WarehouseLocation) {
    const r = await this.locAction.run(() =>
      this.api.patch<Warehouse>(`inventory/warehouse-locations/${l.id}`, {
        status: l.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
        expectedVersion: l.version,
      }),
    );
    if (!r) {
      this.toasts.show(this.locAction.error()?.message ?? 'Não foi possível.', 'error');
      return;
    }
    this.w.set(r);
    this.toasts.show(l.status === 'ACTIVE' ? 'Localização inactivada.' : 'Localização reactivada.');
  }

  protected async setAccess(membershipId: string, level: 'VIEW' | 'OPERATE' | null) {
    const x = this.w()!;
    const r = await this.locAction.run(() =>
      this.api.put<Warehouse>(`inventory/warehouses/${x.id}/access`, { membershipId, level }),
    );
    if (!r) {
      this.toasts.show(this.locAction.error()?.message ?? 'Não foi possível.', 'error');
      return;
    }
    this.w.set(r);
    this.acc = { membershipId: '', level: 'VIEW' };
    this.toasts.show(level ? 'Acesso dado.' : 'Acesso retirado.');
  }
}

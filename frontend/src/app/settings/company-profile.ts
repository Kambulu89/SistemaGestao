import { Component, computed, inject, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Workspace } from '../core/workspace';
import { type Attachment, Attachments } from '../ui/attachments';
import { AuditHistory } from '../ui/audit-history';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';

export interface CompanyProfile extends Record<string, unknown> {
  version: number;
  logoAttachmentId: string | null;
  tenant: {
    name: string;
    code: string;
    locale: string;
    timezone: string;
    defaultCurrency: string;
    countryCode: string;
  };
}

interface ProfileField {
  key: string;
  label: string;
  type?: 'email' | 'tel' | 'url';
  section: 'id' | 'contacts' | 'address';
  hint?: string;
}

export const PROFILE_FIELDS: ProfileField[] = [
  { key: 'displayName', label: 'Nome a apresentar', section: 'id' },
  {
    key: 'legalNameRef',
    label: 'Denominação de referência',
    section: 'id',
    hint: 'A identidade fiscal de cada entidade legal fica na própria entidade.',
  },
  { key: 'taxIdRef', label: 'NIF de referência', section: 'id' },
  { key: 'sector', label: 'Sector de actividade', section: 'id' },
  { key: 'countryCode', label: 'País (ISO, ex.: AO)', section: 'id' },
  { key: 'email', label: 'Email', type: 'email', section: 'contacts' },
  { key: 'phone', label: 'Telefone', type: 'tel', section: 'contacts' },
  { key: 'website', label: 'Sítio web', type: 'url', section: 'contacts' },
  { key: 'addressLine', label: 'Endereço', section: 'address' },
  { key: 'neighbourhood', label: 'Bairro', section: 'address' },
  { key: 'commune', label: 'Comuna', section: 'address' },
  { key: 'municipality', label: 'Município', section: 'address' },
  { key: 'province', label: 'Província', section: 'address' },
  { key: 'postalCode', label: 'Código postal', section: 'address' },
];

export const LOCALES = [
  { value: 'pt-AO', label: 'Português (Angola)' },
  { value: 'pt-PT', label: 'Português (Portugal)' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'en-US', label: 'English (US)' },
];
export const TIMEZONES = ['Africa/Luanda', 'Europe/Lisbon', 'America/Sao_Paulo', 'UTC'];

/** Valores alterados do perfil (strings aparadas; vazio → null) mais idioma, fuso e moeda da empresa. */
export function profilePayload(form: Record<string, unknown>, original: CompanyProfile) {
  const out: Record<string, unknown> = {};
  for (const f of PROFILE_FIELDS) {
    let v = form[f.key];
    if (typeof v === 'string') v = v.trim();
    if (v === '' || v === undefined) v = null;
    if (v !== (original[f.key] ?? null)) out[f.key] = v;
  }
  if ((form['logoAttachmentId'] ?? null) !== original.logoAttachmentId)
    out['logoAttachmentId'] = form['logoAttachmentId'] ?? null;
  for (const k of ['locale', 'timezone', 'defaultCurrency'] as const) {
    const v = typeof form[k] === 'string' ? (form[k] as string).trim() : form[k];
    if (v && v !== original.tenant[k]) out[k] = v;
  }
  return out;
}

const SECTIONS = [
  { id: 'id', title: 'Identificação', description: 'Como a empresa se apresenta no sistema.' },
  { id: 'contacts', title: 'Contactos', description: 'Contactos institucionais.' },
  { id: 'address', title: 'Morada', description: 'Sede ou endereço principal.' },
] as const;

/** Perfil da empresa (separado da identidade fiscal das entidades legais), logótipo, idioma, fuso e moeda. */
@Component({
  selector: 'app-company-profile',
  imports: [
    FormsModule,
    PageDetail,
    ErrorAlert,
    ErrorState,
    Skeleton,
    FormSection,
    FormField,
    FieldControl,
    Attachments,
    AuditHistory,
  ],
  template: `
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else if (!profile()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      <app-page-detail
        [title]="$any(profile()!['displayName']) ?? profile()!.tenant.name"
        [subtitle]="'Código da empresa: ' + profile()!.tenant.code"
      >
        <form class="space-y-4" (ngSubmit)="save()" novalidate>
          <app-error-alert [error]="action.error()" [showDetails]="false" />
          @for (s of sections; track s.id) {
            <app-form-section [title]="s.title" [description]="s.description">
              @for (f of fieldsOf(s.id); track f.key) {
                <app-field [label]="f.label" [hint]="f.hint ?? null" [error]="action.field(f.key)">
                  <input
                    appControl
                    class="input"
                    [type]="f.type ?? 'text'"
                    [name]="f.key"
                    [disabled]="!canManage()"
                    [(ngModel)]="form[f.key]"
                  />
                </app-field>
              }
            </app-form-section>
          }
          <app-form-section
            title="Regionalização"
            description="Idioma, fuso horário e moeda por omissão da empresa."
          >
            <app-field label="Idioma" [error]="action.field('locale')">
              <select
                appControl
                class="input"
                name="locale"
                [disabled]="!canManage()"
                [(ngModel)]="form['locale']"
              >
                @for (l of locales; track l.value) {
                  <option [value]="l.value">{{ l.label }}</option>
                }
              </select>
            </app-field>
            <app-field label="Fuso horário" [error]="action.field('timezone')">
              <select
                appControl
                class="input"
                name="timezone"
                [disabled]="!canManage()"
                [(ngModel)]="form['timezone']"
              >
                @for (t of timezones; track t) {
                  <option [value]="t">{{ t }}</option>
                }
              </select>
            </app-field>
            <app-field
              label="Moeda por omissão"
              hint="ISO 4217 (ex.: AOA)."
              [error]="action.field('defaultCurrency')"
            >
              <input
                appControl
                class="input"
                name="defaultCurrency"
                [disabled]="!canManage()"
                [(ngModel)]="form['defaultCurrency']"
              />
            </app-field>
          </app-form-section>
          <app-form-section
            title="Logótipo"
            description="Escolha uma imagem anexada a este perfil (PNG, JPG ou WebP)."
          >
            <app-field label="Imagem" [error]="action.field('logoAttachmentId')">
              <select
                appControl
                class="input"
                name="logo"
                [disabled]="!canManage()"
                [(ngModel)]="form['logoAttachmentId']"
              >
                <option [ngValue]="null">Sem logótipo</option>
                @for (a of images(); track a.id) {
                  <option [ngValue]="a.id">{{ a.fileName }}</option>
                }
              </select>
            </app-field>
            @if (logoUrl(); as url) {
              <img
                [src]="url"
                alt="Logótipo da empresa"
                class="max-h-24 rounded-md border border-border bg-surface p-2"
              />
            }
          </app-form-section>
          @if (canManage()) {
            <div class="flex items-center gap-3">
              <button type="submit" class="btn-primary" [disabled]="action.busy()">
                {{ action.busy() ? 'A guardar…' : 'Guardar perfil' }}
              </button>
              @if (hasUnsavedChanges()) {
                <span class="text-sm text-muted" role="status">Alterações por guardar</span>
              }
            </div>
          }
        </form>
        <div aside>
          <app-attachments
            subjectType="tenant_profile"
            [subjectId]="tenantId()"
            [canWrite]="canManage()"
          />
          <button type="button" class="btn-secondary w-full" (click)="loadImages()">
            Actualizar lista de imagens
          </button>
          <app-audit-history
            entityType="tenant_profile"
            [entityId]="tenantId()"
            [refreshKey]="profile()!.version"
          />
        </div>
      </app-page-detail>
    }
  `,
})
export class CompanyProfilePage implements HasUnsavedChanges, OnDestroy {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly workspace = inject(Workspace);
  protected readonly sections = SECTIONS;
  protected readonly locales = LOCALES;
  protected readonly timezones = TIMEZONES;
  protected readonly canManage = computed(() => this.workspace.can('settings.manage'));
  protected readonly tenantId = computed(() => this.workspace.tenantId() ?? '');
  protected readonly profile = signal<CompanyProfile | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly images = signal<Attachment[]>([]);
  protected readonly logoUrl = signal<string | null>(null);
  protected readonly action = new Action();
  protected form: Record<string, unknown> = {};
  private initial = '';

  constructor() {
    warnOnUnload(this);
    void this.load();
  }

  ngOnDestroy() {
    this.setLogoUrl(null);
  }

  hasUnsavedChanges() {
    return !!this.profile() && this.canManage() && snapshot(this.form) !== this.initial;
  }

  protected fieldsOf(section: string) {
    return PROFILE_FIELDS.filter((f) => f.section === section);
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.apply(await this.api.get<CompanyProfile>('company/profile'));
      void this.loadImages();
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private apply(p: CompanyProfile) {
    this.profile.set(p);
    this.form = {
      ...p,
      locale: p.tenant.locale,
      timezone: p.tenant.timezone,
      defaultCurrency: p.tenant.defaultCurrency,
    };
    this.initial = snapshot(this.form);
    void this.loadLogo(p.logoAttachmentId);
  }

  protected async loadImages() {
    try {
      const list = await this.api.get<Attachment[]>('attachments', {
        subjectType: 'tenant_profile',
        subjectId: this.tenantId(),
      });
      this.images.set(list.filter((a) => a.contentType.startsWith('image/')));
    } catch {
      this.images.set([]);
    }
  }

  private async loadLogo(id: string | null) {
    if (!id) return this.setLogoUrl(null);
    try {
      const { blob } = await this.api.download(`attachments/${id}/content`);
      this.setLogoUrl(URL.createObjectURL(blob));
    } catch {
      this.setLogoUrl(null);
    }
  }

  private setLogoUrl(url: string | null) {
    const previous = this.logoUrl();
    if (previous) URL.revokeObjectURL(previous);
    this.logoUrl.set(url);
  }

  protected async save() {
    const original = this.profile()!;
    const body = profilePayload(this.form, original);
    if (Object.keys(body).length === 0) {
      this.toasts.show('Nada para guardar.', 'info');
      return;
    }
    const result = await this.action.run(() =>
      this.api.put<CompanyProfile>('company/profile', {
        ...body,
        expectedVersion: original.version,
      }),
    );
    if (!result) {
      if (this.action.error()?.code === 'VERSION_CONFLICT')
        this.toasts.show('Outra pessoa alterou o perfil. Recarregue a página.', 'error', 0);
      return;
    }
    this.apply(result);
    this.workspace.invalidate('');
    this.toasts.show('Perfil guardado.');
  }
}

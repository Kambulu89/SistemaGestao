import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { Textarea } from '../../../shared/ui/textarea/textarea';
import {
  DocumentsApi,
  type TemplateChannel,
  type TemplateDto,
  type TemplateVersionDto,
  type VariableDef,
  type VariableType,
  type Visibility,
} from './documents.api';
import {
  CHANNEL,
  declareUsed,
  documentError,
  TEMPLATE_STATUS,
  VARIABLE_TYPES,
  VISIBILITY,
} from './documents-model';

const CHANNEL_OPTIONS: readonly SelectOption[] = (Object.keys(CHANNEL) as TemplateChannel[]).map(
  (value) => ({ value, label: CHANNEL[value] }),
);
const TYPE_OPTIONS: readonly SelectOption[] = VARIABLE_TYPES.map((t) => ({
  value: t.value,
  label: t.label,
}));
const VISIBILITY_OPTIONS: readonly SelectOption[] = (['PRIVATE', 'TENANT'] as const).map(
  (value) => ({ value, label: VISIBILITY[value] }),
);

interface Selected {
  readonly template: TemplateDto;
  readonly versions: readonly TemplateVersionDto[];
}

/**
 * Modelos: o corpo só admite `{{variáveis}}` declaradas (sem funções, includes nem URLs), a pré-visualização usa dados
 * de teste e escapa HTML, e publicar torna a versão imutável. Gerar guarda o PDF e a versão do modelo usada.
 */
@Component({
  selector: 'app-documents-templates',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
    Textarea,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex items-center justify-between">
      <p class="text-sm text-fg-muted">
        Um modelo só usa variáveis declaradas, como <code>{{ '{{' }}cliente{{ '}}' }}</code>. Uma
        versão publicada nunca muda; os documentos já emitidos guardam a versão que usaram.
      </p>
      @if (canManage()) {
        <app-button (click)="openCreate()">Novo modelo</app-button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (templates.isLoading() && !templates.hasValue()) {
        <app-loading-state label="A carregar modelos…" />
      } @else if (templates.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar os modelos">
            {{ describe(templates.error()) }}
          </app-alert>
        </div>
      } @else if (templates.hasValue() && templates.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state icon="document" title="Sem modelos" />
        } @else {
          <app-table caption="Modelos" [columns]="columns" [rows]="list">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('name') {
                  <span class="font-medium">{{ row.name }}</span>
                  <span class="block text-xs text-fg-muted">{{ row.code }}</span>
                }
                @case ('channel') {
                  {{ channelLabel(row.channel) }}
                }
                @case ('published') {
                  {{ row.publishedRevision ? 'v' + row.publishedRevision : '—' }}
                }
                @case ('latest') {
                  {{ row.latestRevision ? 'v' + row.latestRevision : '—' }}
                }
                @case ('actions') {
                  <span class="flex justify-end">
                    <app-button size="sm" variant="secondary" (click)="open(row)">Abrir</app-button>
                  </span>
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    @if (selected(); as detail) {
      <h3 class="mb-2 mt-6 text-sm font-semibold" data-testid="versions-title">
        Versões de {{ detail.template.name }}
      </h3>
      <app-card [flush]="true">
        <ul class="divide-y divide-line" data-testid="template-versions">
          @for (v of detail.versions; track v.id) {
            <li class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <span>
                <span class="font-medium">v{{ v.revision }}</span> · {{ v.locale }}
                <app-badge [tone]="versionStatus(v).tone">{{ versionStatus(v).label }}</app-badge>
              </span>
              <span class="flex flex-wrap gap-1">
                <app-button size="sm" variant="secondary" (click)="openPreview(v)"
                  >Pré-visualizar</app-button
                >
                @if (canManage()) {
                  <app-button size="sm" variant="secondary" (click)="openEditor(v)">{{
                    v.status === 'DRAFT' ? 'Editar' : 'Nova versão a partir desta'
                  }}</app-button>
                }
                @if (canManage() && v.status === 'DRAFT') {
                  <app-button size="sm" variant="secondary" (click)="discard(v)"
                    >Apagar rascunho</app-button
                  >
                }
                @if (canPublish() && v.status === 'DRAFT') {
                  <app-button size="sm" (click)="publish(v)">Publicar</app-button>
                }
              </span>
            </li>
          }
        </ul>
        <div class="flex flex-wrap gap-2 border-t border-line p-3">
          @if (canManage()) {
            <app-button size="sm" variant="secondary" (click)="openEditor(null)"
              >Nova versão em branco</app-button
            >
          }
          @if (canManage() && detail.template.channel === 'DOCUMENT' && published(); as pub) {
            <app-button size="sm" (click)="openGenerate(pub)">Gerar documento (PDF)</app-button>
          }
        </div>
      </app-card>
    }

    <app-dialog [open]="creating()" title="Novo modelo" (closed)="creating.set(false)">
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="template-form">
        <app-input label="Código" [ngModel]="code()" (ngModelChange)="code.set($event ?? '')" />
        <app-input label="Nome" [ngModel]="name()" (ngModelChange)="name.set($event ?? '')" />
        <app-select
          label="Canal"
          [options]="channelOptions"
          [ngModel]="channel()"
          (ngModelChange)="channel.set($event ?? 'DOCUMENT')"
        />
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="create()">Criar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="editing()"
      [wide]="true"
      title="Versão do modelo"
      (closed)="editing.set(false)"
    >
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="template-editor">
        <app-textarea
          label="Corpo"
          [rows]="8"
          [ngModel]="body()"
          (ngModelChange)="body.set($event ?? '')"
        />
        <app-input label="Língua" [ngModel]="locale()" (ngModelChange)="locale.set($event ?? '')" />
        <div>
          <div class="mb-1 flex items-center justify-between">
            <span class="text-sm font-medium text-fg">Variáveis</span>
            <span class="flex gap-1">
              <app-button size="sm" variant="secondary" (click)="declareFromBody()"
                >Declarar as usadas no corpo</app-button
              >
              <app-button size="sm" variant="secondary" (click)="addVariable()"
                >Acrescentar</app-button
              >
            </span>
          </div>
          <ul class="space-y-2" data-testid="variables">
            @for (v of variables(); track $index; let i = $index) {
              <li class="grid items-end gap-2 sm:grid-cols-[1fr_1fr_9rem_auto_auto]">
                <app-input
                  label="Nome"
                  [ngModel]="v.name"
                  (ngModelChange)="patchVariable(i, { name: $event ?? '' })"
                />
                <app-input
                  label="Rótulo"
                  [ngModel]="v.label"
                  (ngModelChange)="patchVariable(i, { label: $event ?? '' })"
                />
                <app-select
                  label="Tipo"
                  [options]="typeOptions"
                  [ngModel]="v.type"
                  (ngModelChange)="patchVariable(i, { type: ($event ?? 'string') + '' })"
                />
                <label class="flex items-center gap-1 pb-2 text-sm">
                  <input
                    type="checkbox"
                    [checked]="v.required"
                    (change)="patchVariable(i, { required: !v.required })"
                  />
                  Obrigatória
                </label>
                <app-button size="sm" variant="ghost" (click)="removeVariable(i)"
                  >Remover</app-button
                >
              </li>
            }
          </ul>
        </div>
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="editing.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="saveVersion()">Guardar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="previewing() !== null"
      [wide]="true"
      title="Pré-visualização com dados de teste"
      (closed)="previewing.set(null)"
    >
      @if (previewing(); as version) {
        @if (formError(); as text) {
          <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
        }
        <div class="grid gap-3 sm:grid-cols-2" data-testid="preview-form">
          @for (v of version.variableSchema.variables; track v.name) {
            <app-input
              [label]="v.label + ' (' + v.name + ')'"
              [ngModel]="values()[v.name] ?? ''"
              (ngModelChange)="setValue(v.name, $event ?? '')"
            />
          }
        </div>
        @if (preview(); as shown) {
          <h3 class="mb-1 mt-4 text-sm font-semibold">Texto</h3>
          <pre
            class="whitespace-pre-wrap rounded-lg bg-surface-muted p-3 text-xs"
            data-testid="preview-text"
            >{{ shown.text }}</pre>
          <h3 class="mb-1 mt-3 text-sm font-semibold">HTML (escapado)</h3>
          <pre
            class="whitespace-pre-wrap rounded-lg bg-surface-muted p-3 text-xs"
            data-testid="preview-html"
            >{{ shown.html }}</pre>
        }
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="previewing.set(null)">Fechar</app-button>
        <app-button [loading]="busy()" (click)="runPreview()">Pré-visualizar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="generating() !== null"
      [wide]="true"
      title="Gerar documento"
      (closed)="generating.set(null)"
    >
      @if (generating(); as version) {
        @if (formError(); as text) {
          <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
        }
        <div class="space-y-3" data-testid="generate-form">
          <app-input
            label="Título do documento"
            [ngModel]="genTitle()"
            (ngModelChange)="genTitle.set($event ?? '')"
          />
          <div class="grid gap-3 sm:grid-cols-2">
            @for (v of version.variableSchema.variables; track v.name) {
              <app-input
                [label]="v.label"
                [ngModel]="values()[v.name] ?? ''"
                (ngModelChange)="setValue(v.name, $event ?? '')"
              />
            }
          </div>
          <app-select
            label="Visibilidade"
            [options]="visibilityOptions"
            [ngModel]="genVisibility()"
            (ngModelChange)="genVisibility.set($event ?? 'PRIVATE')"
          />
        </div>
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="generating.set(null)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="generate()">Gerar PDF</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class TemplatesTab {
  private readonly api = inject(DocumentsApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('template.manage'));
  protected readonly canPublish = computed(() => this.permissions.can('template.publish'));
  protected readonly channelOptions = CHANNEL_OPTIONS;
  protected readonly typeOptions = TYPE_OPTIONS;
  protected readonly visibilityOptions = VISIBILITY_OPTIONS;
  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Modelo' },
    { key: 'channel', label: 'Canal' },
    { key: 'published', label: 'Publicada', align: 'end' },
    { key: 'latest', label: 'Última', align: 'end' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly tick = signal(0);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly templates = rxResource({
    params: () => {
      const t = this.tenantId();
      return t ? { tenantId: t.id, tick: this.tick() } : undefined;
    },
    stream: () => this.api.templates(),
  });

  protected readonly selected = signal<Selected | null>(null);
  protected readonly published = computed(
    () => this.selected()?.versions.find((v) => v.status === 'PUBLISHED') ?? null,
  );

  // --- novo modelo
  protected readonly creating = signal(false);
  protected readonly code = signal('');
  protected readonly name = signal('');
  protected readonly channel = signal<string>('DOCUMENT');

  // --- editor
  protected readonly editing = signal(false);
  private editingDraft: TemplateVersionDto | null = null;
  protected readonly body = signal('');
  protected readonly locale = signal('pt-AO');
  protected readonly variables = signal<readonly VariableDef[]>([]);

  // --- pré-visualização e geração
  protected readonly previewing = signal<TemplateVersionDto | null>(null);
  protected readonly preview = signal<{ text: string; html: string } | null>(null);
  protected readonly values = signal<Readonly<Record<string, string>>>({});
  protected readonly generating = signal<TemplateVersionDto | null>(null);
  protected readonly genTitle = signal('');
  protected readonly genVisibility = signal<string>('PRIVATE');

  protected describe = (e: unknown) => documentError(e, 'Pedido falhado.');
  protected channelLabel = (c: TemplateChannel) => CHANNEL[c];
  protected versionStatus = (v: TemplateVersionDto) => TEMPLATE_STATUS[v.status];

  protected open(template: TemplateDto): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.load(template.id);
  }

  private load(id: string): void {
    this.api.template(id).subscribe({
      next: (detail) => this.selected.set({ template: detail.template, versions: detail.versions }),
      error: (e: unknown) =>
        this.actionError.set(documentError(e, 'Não foi possível abrir o modelo.')),
    });
  }

  protected openCreate(): void {
    this.notice.set(null);
    this.formError.set(null);
    this.code.set('');
    this.name.set('');
    this.channel.set('DOCUMENT');
    this.creating.set(true);
  }

  protected create(): void {
    if (!this.code().trim() || !this.name().trim()) {
      this.formError.set('Indique o código e o nome.');
      return;
    }
    this.run(
      this.api.createTemplate({
        code: this.code().trim(),
        name: this.name().trim(),
        channel: this.channel() as TemplateChannel,
      }),
      'Modelo criado.',
      () => this.creating.set(false),
    );
  }

  protected openEditor(from: TemplateVersionDto | null): void {
    this.formError.set(null);
    this.editingDraft = from?.status === 'DRAFT' ? from : null;
    this.body.set(from?.body ?? '');
    this.locale.set(from?.locale ?? 'pt-AO');
    this.variables.set(from ? [...from.variableSchema.variables] : []);
    this.editing.set(true);
  }

  protected addVariable(): void {
    this.variables.update((list) => [
      ...list,
      { name: '', label: '', type: 'string', required: true },
    ]);
  }

  protected removeVariable(index: number): void {
    this.variables.update((list) => list.filter((_, i) => i !== index));
  }

  protected patchVariable(
    index: number,
    patch: Partial<{ name: string; label: string; type: string; required: boolean }>,
  ): void {
    this.variables.update((list) =>
      list.map((v, i): VariableDef => {
        if (i !== index) return v;
        const { type, ...rest } = patch;
        return { ...v, ...rest, ...(type ? { type: type as VariableType } : {}) };
      }),
    );
  }

  protected declareFromBody(): void {
    this.variables.set(declareUsed(this.body(), this.variables()));
  }

  protected saveVersion(): void {
    const detail = this.selected();
    if (!detail) return;
    const content = {
      body: this.body(),
      variableSchema: { variables: this.variables() },
      locale: this.locale().trim() || 'pt-AO',
    };
    const draft = this.editingDraft;
    this.run(
      draft
        ? this.api.updateTemplateDraft(detail.template.id, draft.id, {
            version: draft.version,
            ...content,
          })
        : this.api.addTemplateVersion(detail.template.id, content),
      'Versão guardada como rascunho.',
      () => {
        this.editing.set(false);
        this.load(detail.template.id);
      },
    );
  }

  protected discard(version: TemplateVersionDto): void {
    const detail = this.selected();
    if (!detail) return;
    this.run(
      this.api.deleteTemplateDraft(detail.template.id, version.id),
      'Rascunho apagado.',
      () => this.load(detail.template.id),
    );
  }

  protected publish(version: TemplateVersionDto): void {
    const detail = this.selected();
    if (!detail) return;
    this.run(
      this.api.publishTemplate(detail.template.id, version.id),
      'Versão publicada: passa a ser imutável.',
      () => this.load(detail.template.id),
    );
  }

  protected openPreview(version: TemplateVersionDto): void {
    this.formError.set(null);
    this.preview.set(null);
    this.values.set({});
    this.previewing.set(version);
  }

  protected setValue(name: string, value: string): void {
    this.values.update((v) => ({ ...v, [name]: value }));
  }

  protected runPreview(): void {
    const detail = this.selected();
    const version = this.previewing();
    if (!detail || !version) return;
    this.formError.set(null);
    this.busy.set(true);
    this.api.previewTemplate(detail.template.id, version.id, { ...this.values() }).subscribe({
      next: (shown) => {
        this.busy.set(false);
        this.preview.set(shown);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.formError.set(documentError(e, 'Não foi possível pré-visualizar.'));
      },
    });
  }

  protected openGenerate(version: TemplateVersionDto): void {
    this.formError.set(null);
    this.values.set({});
    this.genTitle.set('');
    this.genVisibility.set('PRIVATE');
    this.generating.set(version);
  }

  protected generate(): void {
    const detail = this.selected();
    if (!detail) return;
    if (!this.genTitle().trim()) {
      this.formError.set('Indique o título do documento.');
      return;
    }
    this.run(
      this.api.generate(detail.template.id, {
        title: this.genTitle().trim(),
        variables: { ...this.values() },
        visibility: this.genVisibility() as Visibility,
      }),
      'Documento gerado: já está na biblioteca.',
      () => this.generating.set(null),
    );
  }

  private run(call: Observable<unknown>, message: string, after: () => void): void {
    this.formError.set(null);
    this.actionError.set(null);
    this.busy.set(true);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        this.notice.set(message);
        this.tick.update((n) => n + 1);
        after();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.formError.set(documentError(e, 'Não foi possível concluir a operação.'));
      },
    });
  }
}

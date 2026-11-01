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
import {
  DocumentsApi,
  type AttachmentDto,
  type DocumentDto,
  type DocumentVersionDto,
  type Visibility,
} from './documents.api';
import { documentError, formatSize, STATUS, VISIBILITY } from './documents-model';
import { UploadBox } from './upload-box';

const VISIBILITY_OPTIONS: readonly SelectOption[] = (['PRIVATE', 'TENANT'] as const).map(
  (value) => ({ value, label: VISIBILITY[value] }),
);

/**
 * Biblioteca de documentos: pesquisa, categorias, versões imutáveis e descarga por URL curta. Cada pessoa vê só o que
 * a visibilidade e o acesso ao recurso permitem; um ficheiro em quarentena nunca se descarrega.
 */
@Component({
  selector: 'app-documents-library',
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
    UploadBox,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div class="flex flex-wrap items-end gap-3">
        <div class="w-64">
          <app-input
            label="Pesquisar"
            placeholder="Título do documento"
            [ngModel]="search()"
            (ngModelChange)="search.set($event ?? '')"
          />
        </div>
        <div class="w-48">
          <app-input
            label="Categoria"
            placeholder="ex.: contratos"
            [ngModel]="category()"
            (ngModelChange)="category.set($event ?? '')"
          />
        </div>
      </div>
      @if (canManage()) {
        <app-button (click)="openCreate()">Novo documento</app-button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (documents.isLoading() && !documents.hasValue()) {
        <app-loading-state label="A carregar documentos…" />
      } @else if (documents.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar os documentos">
            {{ describe(documents.error()) }}
          </app-alert>
        </div>
      } @else if (documents.hasValue() && documents.value(); as page) {
        @if (page.items.length === 0) {
          <app-empty-state icon="document" title="Sem documentos" />
        } @else {
          <app-table caption="Documentos" [columns]="columns" [rows]="page.items">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('title') {
                  <span class="font-medium">{{ row.title }}</span>
                  @if (row.current; as current) {
                    <span class="block text-xs text-fg-muted"
                      >{{ current.fileName }} · v{{ current.revision }}</span
                    >
                  }
                }
                @case ('category') {
                  {{ row.categoryCode }}
                }
                @case ('visibility') {
                  {{ visibilityLabel(row.visibility) }}
                  @if (row.legalHold) {
                    <app-badge tone="warning">Retenção legal</app-badge>
                  }
                }
                @case ('size') {
                  {{ row.current ? size(row.current.sizeBytes) : '—' }}
                }
                @case ('status') {
                  @if (row.current; as current) {
                    <app-badge [tone]="statusOf(current.status).tone">{{
                      statusOf(current.status).label
                    }}</app-badge>
                  }
                }
                @case ('actions') {
                  <span class="flex justify-end gap-1">
                    <app-button size="sm" variant="secondary" (click)="open(row)">Abrir</app-button>
                    @if (row.current?.status === 'AVAILABLE') {
                      <app-button size="sm" (click)="download(row.current.attachmentId)"
                        >Descarregar</app-button
                      >
                    }
                  </span>
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    <app-dialog [open]="creating()" title="Novo documento" (closed)="creating.set(false)">
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="document-form">
        <app-upload-box (attachmentChange)="attachment.set($event)" />
        <app-input label="Título" [ngModel]="title()" (ngModelChange)="title.set($event ?? '')" />
        <app-input
          label="Categoria"
          [ngModel]="categoryCode()"
          (ngModelChange)="categoryCode.set($event ?? '')"
        />
        <app-select
          label="Visibilidade"
          [options]="visibilityOptions"
          [ngModel]="visibility()"
          (ngModelChange)="visibility.set($event ?? 'PRIVATE')"
        />
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" [disabled]="!attachment()" (click)="create()"
          >Criar</app-button
        >
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="selected() !== null"
      [wide]="true"
      [title]="selected()?.document?.title ?? 'Documento'"
      (closed)="selected.set(null)"
    >
      @if (selected(); as detail) {
        @if (formError(); as text) {
          <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
        }
        <div class="space-y-4" data-testid="document-detail">
          @if (canManage()) {
            <div class="grid gap-3 sm:grid-cols-2">
              <app-input
                label="Título"
                [ngModel]="editTitle()"
                (ngModelChange)="editTitle.set($event ?? '')"
              />
              <app-input
                label="Categoria"
                [ngModel]="editCategory()"
                (ngModelChange)="editCategory.set($event ?? '')"
              />
              <app-select
                label="Visibilidade"
                [options]="visibilityOptions"
                [disabled]="detail.document.visibility === 'RESOURCE'"
                [ngModel]="editVisibility()"
                (ngModelChange)="editVisibility.set($event ?? 'PRIVATE')"
              />
              <app-input
                label="Retido até (AAAA-MM-DD)"
                [ngModel]="editRetention()"
                (ngModelChange)="editRetention.set($event ?? '')"
              />
            </div>
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" [checked]="editHold()" (change)="editHold.set(!editHold())" />
              Retenção legal (impede apagar)
            </label>
          }
          <div>
            <h3 class="mb-2 text-sm font-semibold">Versões</h3>
            <ul class="divide-y divide-line rounded-lg border border-line" data-testid="versions">
              @for (v of detail.versions; track v.id) {
                <li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span>
                    <span class="font-medium">v{{ v.revision }}</span> · {{ v.fileName }}
                    <span class="text-fg-muted">({{ size(v.sizeBytes) }})</span>
                    @if (v.changeNote) {
                      <span class="block text-xs text-fg-muted">{{ v.changeNote }}</span>
                    }
                  </span>
                  <span class="flex items-center gap-2">
                    <app-badge [tone]="statusOf(v.status).tone">{{
                      statusOf(v.status).label
                    }}</app-badge>
                    @if (v.status === 'AVAILABLE') {
                      <app-button size="sm" variant="secondary" (click)="download(v.attachmentId)"
                        >Descarregar</app-button
                      >
                    }
                  </span>
                </li>
              }
            </ul>
          </div>
          @if (canManage()) {
            <div class="rounded-lg border border-line p-3">
              <h3 class="mb-2 text-sm font-semibold">Nova versão</h3>
              <app-upload-box (attachmentChange)="versionAttachment.set($event)" />
              <div class="mt-2">
                <app-input
                  label="Nota da alteração"
                  [ngModel]="changeNote()"
                  (ngModelChange)="changeNote.set($event ?? '')"
                />
              </div>
              <div class="mt-2">
                <app-button
                  size="sm"
                  [loading]="busy()"
                  [disabled]="!versionAttachment()"
                  (click)="addVersion()"
                  >Acrescentar versão</app-button
                >
              </div>
            </div>
          }
        </div>
      }
      <ng-container dialogActions>
        @if (canManage() && confirmDelete()) {
          <app-button variant="danger" [loading]="busy()" (click)="remove()"
            >Confirmar: apagar</app-button
          >
        } @else if (canManage()) {
          <app-button variant="secondary" (click)="confirmDelete.set(true)">Apagar</app-button>
        }
        <app-button variant="secondary" (click)="selected.set(null)">Fechar</app-button>
        @if (canManage()) {
          <app-button [loading]="busy()" (click)="save()">Guardar</app-button>
        }
      </ng-container>
    </app-dialog>
  `,
})
export class LibraryTab {
  private readonly api = inject(DocumentsApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('document.manage'));
  protected readonly visibilityOptions = VISIBILITY_OPTIONS;
  protected readonly columns: readonly TableColumn[] = [
    { key: 'title', label: 'Documento' },
    { key: 'category', label: 'Categoria' },
    { key: 'visibility', label: 'Visibilidade' },
    { key: 'size', label: 'Tamanho', align: 'end' },
    { key: 'status', label: 'Estado' },
    { key: 'actions', label: '', align: 'end' },
  ];

  protected readonly search = signal('');
  protected readonly category = signal('');
  private readonly tick = signal(0);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly documents = rxResource({
    params: () => {
      const t = this.tenantId();
      return t
        ? {
            tenantId: t.id,
            search: this.search().trim(),
            category: this.category().trim(),
            tick: this.tick(),
          }
        : undefined;
    },
    stream: ({ params }) =>
      this.api.documents({
        search: params.search,
        categoryCode: params.category,
        limit: 100,
      }),
  });

  // --- novo documento
  protected readonly creating = signal(false);
  protected readonly attachment = signal<AttachmentDto | null>(null);
  protected readonly title = signal('');
  protected readonly categoryCode = signal('general');
  protected readonly visibility = signal<string>('PRIVATE');

  // --- detalhe
  protected readonly selected = signal<{
    document: DocumentDto;
    versions: readonly DocumentVersionDto[];
  } | null>(null);
  protected readonly editTitle = signal('');
  protected readonly editCategory = signal('');
  protected readonly editVisibility = signal<string>('PRIVATE');
  protected readonly editRetention = signal('');
  protected readonly editHold = signal(false);
  protected readonly versionAttachment = signal<AttachmentDto | null>(null);
  protected readonly changeNote = signal('');
  protected readonly confirmDelete = signal(false);

  protected describe = (e: unknown) => documentError(e, 'Pedido falhado.');
  protected size = formatSize;
  protected statusOf = (s: keyof typeof STATUS) => STATUS[s];
  protected visibilityLabel = (v: Visibility) => VISIBILITY[v];

  protected openCreate(): void {
    this.notice.set(null);
    this.formError.set(null);
    this.attachment.set(null);
    this.title.set('');
    this.categoryCode.set('general');
    this.visibility.set('PRIVATE');
    this.creating.set(true);
  }

  protected create(): void {
    const attachment = this.attachment();
    if (!attachment || !this.title().trim()) {
      this.formError.set('Escolha o ficheiro, espere pela verificação e indique o título.');
      return;
    }
    this.formError.set(null);
    this.busy.set(true);
    this.api
      .createDocument({
        title: this.title().trim(),
        attachmentId: attachment.id,
        categoryCode: this.categoryCode().trim() || 'general',
        visibility: this.visibility() as Visibility,
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.creating.set(false);
          this.notice.set('Documento criado.');
          this.tick.update((n) => n + 1);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.formError.set(documentError(e, 'Não foi possível criar o documento.'));
        },
      });
  }

  protected open(doc: DocumentDto): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.load(doc.id);
  }

  private load(id: string): void {
    this.api.document(id).subscribe({
      next: (detail) => {
        this.formError.set(null);
        this.confirmDelete.set(false);
        this.versionAttachment.set(null);
        this.changeNote.set('');
        this.editTitle.set(detail.document.title);
        this.editCategory.set(detail.document.categoryCode);
        this.editVisibility.set(detail.document.visibility);
        this.editRetention.set(detail.document.retentionUntil ?? '');
        this.editHold.set(detail.document.legalHold);
        this.selected.set({ document: detail.document, versions: detail.versions });
      },
      error: (e: unknown) =>
        this.actionError.set(documentError(e, 'Não foi possível abrir o documento.')),
    });
  }

  protected save(): void {
    const detail = this.selected();
    if (!detail) return;
    const retention = this.editRetention().trim();
    if (retention && !/^\d{4}-\d{2}-\d{2}$/.test(retention)) {
      this.formError.set('A data de retenção tem de ser AAAA-MM-DD.');
      return;
    }
    this.run(
      this.api.updateDocument(detail.document.id, {
        version: detail.document.version,
        title: this.editTitle().trim(),
        categoryCode: this.editCategory().trim(),
        ...(detail.document.visibility === 'RESOURCE'
          ? {}
          : { visibility: this.editVisibility() as Visibility }),
        retentionUntil: retention || null,
        legalHold: this.editHold(),
      }),
      'Documento guardado.',
      () => this.load(detail.document.id),
    );
  }

  protected addVersion(): void {
    const detail = this.selected();
    const attachment = this.versionAttachment();
    if (!detail || !attachment) return;
    this.run(
      this.api.addVersion(detail.document.id, {
        attachmentId: attachment.id,
        ...(this.changeNote().trim() ? { changeNote: this.changeNote().trim() } : {}),
      }),
      'Versão acrescentada.',
      () => this.load(detail.document.id),
    );
  }

  protected remove(): void {
    const detail = this.selected();
    if (!detail) return;
    this.run(this.api.deleteDocument(detail.document.id), 'Documento apagado.', () =>
      this.selected.set(null),
    );
  }

  /** Pede uma URL curta (autorizada agora) e segue-a: o browser descarrega com a mesma sessão. */
  protected download(attachmentId: string): void {
    this.actionError.set(null);
    this.api.downloadUrl(attachmentId).subscribe({
      next: (url) => window.open(url, '_blank', 'noopener'),
      error: (e: unknown) =>
        this.actionError.set(documentError(e, 'Não foi possível descarregar.')),
    });
  }

  private run(call: Observable<unknown>, message: string, after: () => void): void {
    this.formError.set(null);
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

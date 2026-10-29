import { HttpClient, HttpEventType, HttpHeaders } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { concat, defer, filter, from, map, type Observable, of, switchMap } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';
import { APP_ENVIRONMENT } from '../../../core/config/app-environment';

export type AttachmentStatus = 'PENDING' | 'QUARANTINED' | 'AVAILABLE' | 'REJECTED' | 'DELETED';
export type Visibility = 'PRIVATE' | 'TENANT' | 'RESOURCE';
export type TemplateChannel = 'DOCUMENT' | 'EMAIL' | 'SMS' | 'WHATSAPP' | 'PUSH';
export type TemplateStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
export type VariableType = 'string' | 'number' | 'date' | 'decimal';

export interface AttachmentDto {
  readonly id: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly status: AttachmentStatus;
  readonly rejectCode: string | null;
  readonly scannedAt: string | null;
  readonly createdAt: string;
  readonly downloadable: boolean;
}

export interface DocumentDto {
  readonly id: string;
  readonly title: string;
  readonly categoryCode: string;
  readonly ownerMembershipId: string;
  readonly visibility: Visibility;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly retentionUntil: string | null;
  readonly legalHold: boolean;
  readonly version: number;
  readonly current: {
    readonly versionId: string;
    readonly revision: number;
    readonly attachmentId: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly status: AttachmentStatus;
  } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentVersionDto {
  readonly id: string;
  readonly revision: number;
  readonly attachmentId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly status: AttachmentStatus;
  readonly changeNote: string | null;
  readonly templateVersionId: string | null;
  readonly createdAt: string;
}

export interface VariableDef {
  readonly name: string;
  readonly label: string;
  readonly type: VariableType;
  readonly required: boolean;
}

export interface TemplateDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly channel: TemplateChannel;
  readonly resourceType: string | null;
  readonly publishedRevision: number | null;
  readonly latestRevision: number | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface TemplateVersionDto {
  readonly id: string;
  readonly revision: number;
  readonly body: string;
  readonly variableSchema: { readonly variables: readonly VariableDef[] };
  readonly status: TemplateStatus;
  readonly locale: string;
  readonly publishedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/** Estado do envio de um ficheiro, para a barra de progresso e a indicação de quarentena. */
export type UploadState =
  | { readonly stage: 'hashing' | 'preparing' | 'verifying' }
  | { readonly stage: 'uploading'; readonly percent: number }
  | { readonly stage: 'done'; readonly attachment: AttachmentDto };

/** SHA-256 em hexadecimal; o servidor compara-o com o que recebeu. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const clean = (params: Record<string, unknown>): Record<string, string | number | boolean> =>
  Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as Record<string, string | number | boolean>;

/** Documentos, anexos e modelos (S01) sobre a API real. */
@Injectable({ providedIn: 'root' })
export class DocumentsApi {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly apiUrl = inject(APP_ENVIRONMENT).apiUrl;

  // --- documentos --------------------------------------------------------------------------------

  documents(filterBy: { search?: string; categoryCode?: string; limit?: number; offset?: number }) {
    return this.api
      .getWithMeta<readonly DocumentDto[]>('documents', { params: clean(filterBy) })
      .pipe(
        map((r): Page<DocumentDto> => ({
          items: r.data,
          total: Number(r.meta['total'] ?? r.data.length),
        })),
      );
  }

  document(
    id: string,
  ): Observable<{ document: DocumentDto; versions: readonly DocumentVersionDto[] }> {
    return this.api.get(`documents/${id}`);
  }

  createDocument(body: {
    title: string;
    attachmentId: string;
    categoryCode?: string;
    visibility?: Visibility;
    changeNote?: string;
  }): Observable<DocumentDto> {
    return this.api.post('documents', body);
  }

  updateDocument(
    id: string,
    body: {
      version: number;
      title?: string;
      categoryCode?: string;
      visibility?: Visibility;
      retentionUntil?: string | null;
      legalHold?: boolean;
    },
  ): Observable<DocumentDto> {
    return this.api.patch(`documents/${id}`, body);
  }

  deleteDocument(id: string): Observable<void> {
    return this.api.delete(`documents/${id}`);
  }

  addVersion(
    id: string,
    body: { attachmentId: string; changeNote?: string },
  ): Observable<DocumentVersionDto> {
    return this.api.post(`documents/${id}/versions`, body);
  }

  // --- anexos ------------------------------------------------------------------------------------

  prepare(body: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    checksum: string;
  }): Observable<AttachmentDto> {
    return this.api.post('attachments/prepare', body);
  }

  complete(id: string): Observable<AttachmentDto> {
    return this.api.post(`attachments/${id}/complete`, {});
  }

  attachment(id: string): Observable<AttachmentDto> {
    return this.api.get(`attachments/${id}`);
  }

  /** URL absoluta de uma descarga curta; abre-se na mesma sessão (o browser envia o cookie). */
  downloadUrl(id: string): Observable<string> {
    return this.api
      .post<{ url: string }>(`attachments/${id}/download-url`, {})
      .pipe(map((r) => new URL(r.url, new URL(this.apiUrl, window.location.href)).toString()));
  }

  /**
   * Carrega um ficheiro: SHA-256 → pedido → conteúdo em bruto com progresso → conclusão (tipo real e análise no
   * servidor). Cancelar é anular a subscrição (aborta o envio); repetir é subscrever de novo.
   */
  upload(file: File): Observable<UploadState> {
    const progress = (stage: 'hashing' | 'preparing' | 'verifying'): Observable<UploadState> =>
      of({ stage });
    return concat(
      progress('hashing'),
      defer(() => from(sha256Hex(file))).pipe(
        switchMap((checksum) =>
          concat(
            progress('preparing'),
            this.prepare({
              fileName: file.name,
              mimeType: file.type || 'application/octet-stream',
              sizeBytes: file.size,
              checksum,
            }).pipe(
              switchMap((prepared) =>
                concat(
                  this.send(prepared, file),
                  progress('verifying'),
                  this.complete(prepared.id).pipe(
                    map((attachment): UploadState => ({ stage: 'done', attachment })),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  private send(prepared: AttachmentDto, file: File): Observable<UploadState> {
    return this.http
      .put(`${this.apiUrl}/attachments/${prepared.id}/content`, file, {
        headers: new HttpHeaders({ 'Content-Type': 'application/octet-stream' }),
        observe: 'events',
        reportProgress: true,
      })
      .pipe(
        map((event): UploadState | null =>
          event.type === HttpEventType.UploadProgress
            ? {
                stage: 'uploading',
                percent: event.total ? Math.round((100 * event.loaded) / event.total) : 0,
              }
            : null,
        ),
        filter((state): state is UploadState => state !== null),
      );
  }

  // --- modelos -----------------------------------------------------------------------------------

  templates(): Observable<readonly TemplateDto[]> {
    return this.api.get('templates');
  }

  template(
    id: string,
  ): Observable<{ template: TemplateDto; versions: readonly TemplateVersionDto[] }> {
    return this.api.get(`templates/${id}`);
  }

  createTemplate(body: {
    code: string;
    name: string;
    channel: TemplateChannel;
  }): Observable<TemplateDto> {
    return this.api.post('templates', body);
  }

  addTemplateVersion(
    id: string,
    body: { body: string; variableSchema: { variables: readonly VariableDef[] }; locale?: string },
  ): Observable<TemplateVersionDto> {
    return this.api.post(`templates/${id}/versions`, body);
  }

  updateTemplateDraft(
    id: string,
    versionId: string,
    body: {
      version: number;
      body: string;
      variableSchema: { variables: readonly VariableDef[] };
      locale?: string;
    },
  ): Observable<TemplateVersionDto> {
    return this.api.put(`templates/${id}/versions/${versionId}`, body);
  }

  deleteTemplateDraft(id: string, versionId: string): Observable<void> {
    return this.api.delete(`templates/${id}/versions/${versionId}`);
  }

  publishTemplate(id: string, versionId: string): Observable<TemplateVersionDto> {
    return this.api.post(`templates/${id}/versions/${versionId}/publish`, {});
  }

  previewTemplate(
    id: string,
    versionId: string,
    variables: Record<string, string>,
  ): Observable<{ text: string; html: string }> {
    return this.api.post(`templates/${id}/versions/${versionId}/preview`, { variables });
  }

  generate(
    id: string,
    body: {
      title: string;
      variables: Record<string, string>;
      categoryCode?: string;
      visibility?: Visibility;
    },
  ): Observable<DocumentDto> {
    return this.api.post(`templates/${id}/generate`, body);
  }
}

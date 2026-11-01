import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';
import type { FormDto, FormSectionDto } from '../../../core/dynamic/http/dynamic-dto';

export interface FormBody {
  readonly name: string;
  readonly description: string | null;
  readonly modes: readonly ('create' | 'edit' | 'read')[];
  readonly isDefault: boolean;
  readonly sections: readonly FormSectionDto[];
}

export interface FormPreviewDto {
  readonly issues: readonly {
    readonly path: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly publishable: boolean;
  readonly entityRevision: number | null;
}

const PATH = 'forms';

/** Formulários de uma entidade (C11) sobre a API real. O servidor valida, publica e verifica. */
@Injectable({ providedIn: 'root' })
export class FormsApi {
  private readonly api = inject(ApiService);

  list(entityCode: string): Observable<readonly FormDto[]> {
    return this.api.get<readonly FormDto[]>(PATH, { params: { entityCode } });
  }

  create(entityCode: string, code: string, body: FormBody): Observable<FormDto> {
    return this.api.post<FormDto>(PATH, { entityCode, code, ...body });
  }

  update(id: string, expectedVersion: number, body: FormBody): Observable<FormDto> {
    return this.api.patch<FormDto>(`${PATH}/${id}`, { expectedVersion, ...body });
  }

  createRevision(id: string): Observable<FormDto> {
    return this.api.post<FormDto>(`${PATH}/${id}/revisions`, {});
  }

  preview(id: string): Observable<FormPreviewDto> {
    return this.api.post<FormPreviewDto>(`${PATH}/${id}/preview`, {});
  }

  publish(id: string, expectedVersion: number): Observable<FormDto> {
    return this.api.post<FormDto>(`${PATH}/${id}/publish`, { expectedVersion });
  }

  retire(id: string, expectedVersion: number): Observable<FormDto> {
    return this.api.post<FormDto>(`${PATH}/${id}/retire`, { expectedVersion });
  }
}

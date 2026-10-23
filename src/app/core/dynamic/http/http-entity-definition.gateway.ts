import { inject, Injectable } from '@angular/core';
import { catchError, forkJoin, map, type Observable, of, switchMap, throwError } from 'rxjs';
import type { ApiError } from '../../api/api-error.model';
import { ApiService } from '../../api/api.service';
import { TenantContextService } from '../../tenant-context/tenant-context.service';
import {
  EntityDefinitionGateway,
  type SaveEntityDraftInput,
} from '../data-access/entity-definition.gateway';
import type { DefinitionFailure } from '../data-access/custom-field.gateway';
import type { DefinitionIssue } from '../engine/definition-integrity';
import type { EntityDefinition } from '../models/entity-definition.model';
import type { EntityDetailDto, EntityDto, FieldInputDto } from './dynamic-dto';
import { toDefinitionFailure } from './dynamic-errors';
import {
  definitionsFromServer,
  entityCodeOf,
  fieldToServer,
  UnrepresentableDefinitionError,
} from './dynamic-mapper';

const PATH = 'entity-definitions';

const unprocessable = (message: string, issues: readonly DefinitionIssue[]): ApiError => ({
  status: 422,
  message,
  details: { issues } satisfies DefinitionFailure,
});

/**
 * Entidades dinâmicas do tenant sobre a API real (C10). O servidor é a autoridade: isola por tenant,
 * valida os campos, compara a compatibilidade entre versões e torna imutável o que publica.
 * Só as entidades criadas pelo tenant existem (não há entidades nativas: não há módulos de negócio).
 */
@Injectable()
export class HttpEntityDefinitionGateway extends EntityDefinitionGateway {
  private readonly api = inject(ApiService);
  private readonly tenantContext = inject(TenantContextService);

  list(): Observable<readonly EntityDefinition[]> {
    const tenantId = this.tenantId();
    return this.api.get<readonly EntityDto[]>(PATH).pipe(
      switchMap((entities) =>
        entities.length === 0
          ? of([] as EntityDefinition[][])
          : forkJoin(
              entities.map((e) =>
                this.api.get<EntityDetailDto>(`${PATH}/${e.id}`).pipe(
                  map((detail) => definitionsFromServer(tenantId, detail)),
                  // Uma entidade que a interface não sabe representar não impede as restantes.
                  catchError((error: unknown) =>
                    error instanceof UnrepresentableDefinitionError
                      ? of([] as EntityDefinition[])
                      : throwError(() => error),
                  ),
                ),
              ),
            ),
      ),
      map((groups) => groups.flat()),
    );
  }

  saveDraft(input: SaveEntityDraftInput): Observable<EntityDefinition> {
    const tenantId = this.tenantId();
    const issues: DefinitionIssue[] = [];
    const sent: FieldInputDto[] = [];
    const sentKeys: string[] = [];
    input.fields.forEach((field) => {
      const dto = fieldToServer(field, issues, `fields.${field.key}`);
      if (dto) {
        sent.push(dto);
        sentKeys.push(field.key);
      }
    });
    if (issues.length > 0)
      return throwError(() => unprocessable('A entidade não é válida.', issues));

    const presentation = { pluralName: input.names.plural, icon: input.icon };
    const failures = (e: ApiError) => toDefinitionFailure(e, (i) => sentKeys[i]);

    const request$ =
      input.expectedVersion === null
        ? this.api.post<EntityDetailDto>(PATH, {
            code: entityCodeOf(input.key),
            name: input.names.singular,
            description: input.description ?? null,
            presentation,
            fields: sent,
          })
        : this.findDetail(input.key).pipe(
            switchMap((detail) => {
              const current = (detail.draft ?? detail.published)?.revision ?? null;
              if (current !== input.expectedVersion) {
                return throwError(
                  () =>
                    ({
                      status: 409,
                      code: 'VERSION_CONFLICT',
                      message: 'A entidade foi alterada entretanto. Recarregue e volte a tentar.',
                    }) satisfies ApiError,
                );
              }
              return this.draftOf(detail);
            }),
            switchMap((detail) => {
              const entity = detail.entity;
              const rename =
                entity.name !== input.names.singular ||
                (entity.description ?? undefined) !== input.description ||
                entity.presentation.pluralName !== input.names.plural ||
                entity.presentation.icon !== input.icon;
              return rename
                ? this.api.patch<EntityDetailDto>(`${PATH}/${entity.id}`, {
                    expectedVersion: input.expectedRowVersion ?? entity.version,
                    name: input.names.singular,
                    description: input.description ?? null,
                    presentation,
                  })
                : of(detail);
            }),
            switchMap((detail) =>
              this.api.put<EntityDetailDto>(`${PATH}/${detail.entity.id}/draft`, {
                expectedVersion: detail.entity.version,
                fields: sent,
              }),
            ),
          );

    return request$.pipe(
      map((detail) => {
        const draft = definitionsFromServer(tenantId, detail).find((d) => d.state === 'draft');
        if (!draft) throw new Error('O servidor não devolveu o rascunho.');
        return draft;
      }),
      catchError((error: ApiError) => throwError(() => failures(error))),
    );
  }

  publish(key: string): Observable<EntityDefinition> {
    const tenantId = this.tenantId();
    return this.findDetail(key).pipe(
      switchMap((detail) =>
        this.api.post<EntityDetailDto>(`${PATH}/${detail.entity.id}/publish`, {
          expectedVersion: detail.entity.version,
        }),
      ),
      map((detail) => {
        const published = definitionsFromServer(tenantId, detail).find(
          (d) => d.state === 'published',
        );
        if (!published) throw new Error('O servidor não devolveu a versão publicada.');
        return published;
      }),
      catchError((error: ApiError) =>
        throwError(() => toDefinitionFailure(error, () => undefined)),
      ),
    );
  }

  discardDraft(key: string): Observable<void> {
    return this.findDetail(key).pipe(
      switchMap((detail) =>
        // O primeiro rascunho de uma entidade nunca publicada desaparece com a própria entidade.
        detail.published === null
          ? this.api.delete<void>(`${PATH}/${detail.entity.id}`)
          : this.api
              .delete<unknown>(`${PATH}/${detail.entity.id}/draft`)
              .pipe(map(() => undefined)),
      ),
    );
  }

  // ------------------------------------------------------------------ interno

  private tenantId(): string {
    const id = this.tenantContext.tenant()?.id;
    if (!id) throw new Error('Sem tenant activo.');
    return id;
  }

  /** O detalhe actual da entidade com este código (o servidor é a fonte da versão a usar). */
  private findDetail(key: string): Observable<EntityDetailDto> {
    const code = entityCodeOf(key);
    return this.api.get<readonly EntityDto[]>(PATH).pipe(
      map((entities) => {
        const found = entities.find((e) => e.code === code);
        if (!found) throw { status: 404, message: 'Entidade inexistente.' } satisfies ApiError;
        return found;
      }),
      switchMap((entity) => this.api.get<EntityDetailDto>(`${PATH}/${entity.id}`)),
    );
  }

  /** Garante um rascunho: abre uma nova revisão a partir da publicada se ainda não existir. */
  private draftOf(detail: EntityDetailDto): Observable<EntityDetailDto> {
    return detail.draft
      ? of(detail)
      : this.api.post<EntityDetailDto>(`${PATH}/${detail.entity.id}/drafts`, {});
  }
}

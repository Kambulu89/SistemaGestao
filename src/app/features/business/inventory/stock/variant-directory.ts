import { inject, Injectable, signal } from '@angular/core';
import { catchError, forkJoin, map, of, type Observable } from 'rxjs';
import { InventoryApi, type VariantInfo } from './inventory.api';

/**
 * Nomes de variantes (SKU e produto) para mostrar nas listas. Pede cada id uma só vez; quem não pode ler o catálogo
 * (404/403) fica sem nome e a lista mostra o identificador abreviado.
 */
@Injectable({ providedIn: 'root' })
export class VariantDirectory {
  private readonly api = inject(InventoryApi);
  private readonly known = signal<ReadonlyMap<string, VariantInfo | null>>(new Map());

  readonly names = this.known.asReadonly();

  load(ids: readonly string[]): Observable<void> {
    const missing = [...new Set(ids)].filter((id) => !this.known().has(id));
    if (missing.length === 0) return of(undefined);
    return forkJoin(
      missing.map((id) =>
        this.api.variant(id).pipe(
          catchError(() => of(null)),
          map((info) => [id, info] as const),
        ),
      ),
    ).pipe(
      map((entries) => {
        this.known.update((current) => new Map([...current, ...entries]));
      }),
    );
  }

  label(id: string): string {
    const info = this.known().get(id);
    return info ? `${info.sku} — ${info.productName}` : id.slice(0, 8);
  }
}

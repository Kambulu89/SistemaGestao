import type { Observable } from 'rxjs';
import type { ModuleManifest } from './module.model';

/** Contrato com o backend para o catálogo global de módulos. */
export abstract class ModuleCatalogGateway {
  abstract loadCatalog(): Observable<readonly ModuleManifest[]>;
}

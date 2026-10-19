import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ModuleCatalogGateway } from '../modules/module-catalog.gateway';
import type { ModuleManifest } from '../modules/module.model';
import { MOCK_CATALOG } from './mock-data';
import { respond } from './mock-helpers';

@Injectable()
export class MockModuleCatalogGateway extends ModuleCatalogGateway {
  loadCatalog(): Observable<readonly ModuleManifest[]> {
    return respond(() => MOCK_CATALOG);
  }
}

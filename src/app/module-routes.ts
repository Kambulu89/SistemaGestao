import type { Route, Routes } from '@angular/router';
import { moduleGuard } from './core/guards/module.guard';
import { requirePermission } from './core/guards/permission.guard';
import type { ModuleManifest, ModuleRouteDef } from './core/modules/module.model';

/** Ecrã provisório para módulos ainda sem rotas próprias. */
const scaffoldRoute = (manifest: ModuleManifest): ModuleRouteDef => ({
  path: '',
  title: manifest.name,
  loadComponent: () =>
    import('./features/tenant/module-scaffold/module-scaffold').then((m) => m.ModuleScaffold),
});

export function toRoute(def: ModuleRouteDef): Route {
  return {
    path: def.path,
    title: def.title,
    canActivate: def.permission ? [requirePermission(def.permission)] : [],
    loadComponent: def.loadComponent,
  };
}

/**
 * Gera as rotas lazy dos módulos contratáveis a partir dos manifestos, sob `/t/:slug/<basePath>`.
 * Cada módulo fica protegido por `moduleGuard` (contratado, activo, flag, permissão).
 * Acrescentar um módulo ao catálogo cria a sua rota sem editar as rotas da aplicação.
 */
export function buildModuleRoutes(manifests: readonly ModuleManifest[]): Routes {
  return manifests
    .filter((m) => m.kind === 'module' && m.scope === 'tenant')
    .map((manifest) => ({
      path: manifest.basePath,
      canActivate: [moduleGuard],
      data: { moduleId: manifest.id, breadcrumb: manifest.name },
      children: (manifest.routes.length > 0 ? manifest.routes : [scaffoldRoute(manifest)]).map(
        toRoute,
      ),
    }));
}

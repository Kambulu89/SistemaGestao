import { InjectionToken } from '@angular/core';
import type { ModuleManifest } from './module.model';

/**
 * Manifestos registados na aplicação. Sem valor por omissão: a aplicação decide (app.config.ts)
 * quais módulos existem, e o core nunca importa features.
 */
export const MODULE_MANIFESTS = new InjectionToken<readonly ModuleManifest[]>('MODULE_MANIFESTS');

import type { Routes } from '@angular/router';
import { unsavedChangesGuard } from '../core/unsaved';

/** Recursos humanos (Prompt 07). O acesso a cada colaborador é decidido pela API (âmbito RBAC). */
export const HR_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'colaboradores' },
  {
    path: 'colaboradores',
    title: 'Colaboradores',
    children: [
      { path: '', loadComponent: () => import('./employees').then((m) => m.Employees) },
      {
        path: ':id',
        title: (r) => (r.paramMap.get('id') === 'novo' ? 'Novo colaborador' : 'Colaborador'),
        canDeactivate: [unsavedChangesGuard],
        loadComponent: () => import('./employee-form').then((m) => m.EmployeeForm),
      },
    ],
  },
];

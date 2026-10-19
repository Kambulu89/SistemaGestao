import type { Routes } from '@angular/router';
import { MainLayout } from './layouts/main-layout/main-layout';

export const routes: Routes = [
  {
    path: '',
    component: MainLayout,
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'Início',
        loadComponent: () => import('./features/home/home').then((m) => m.Home),
      },
      {
        path: '**',
        title: 'Página não encontrada',
        loadComponent: () => import('./features/not-found/not-found').then((m) => m.NotFound),
      },
    ],
  },
];

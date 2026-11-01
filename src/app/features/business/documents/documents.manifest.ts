import { defineModule } from '../../../core/modules/define-module';

export const DOCUMENTS_MODULES = [
  defineModule({
    code: 'documents.dms',
    name: 'DMS e anexos',
    description: 'Gestão documental e anexos transversais.',
    group: 'documents',
    icon: 'folder',
    lifecycle: 'beta',
    // Módulo `documents` do servidor (S01): funcionalidades `documents.library` e `documents.templates`.
    backendModule: 'documents',
    features: [
      {
        id: 'library',
        name: 'Biblioteca e anexos',
        description:
          'Documentos com versões imutáveis, ficheiros verificados e descarga por URL curta.',
      },
      {
        id: 'templates',
        name: 'Modelos e geração de PDF',
        description:
          'Modelos com variáveis declaradas, pré-visualização, publicação e PDF emitido.',
      },
    ],
    routes: [
      {
        path: '',
        title: 'Documentos',
        permission: 'documents.dms.read',
        loadComponent: () => import('./documents-page').then((m) => m.DocumentsPage),
      },
    ],
  }),
  defineModule({
    code: 'documents.versioning',
    name: 'Versionamento e templates',
    description: 'Versões de documentos e modelos reutilizáveis.',
    group: 'documents',
    icon: 'folder',
    dependencies: ['documents.dms'],
    backendModule: 'documents',
    // As versões e os modelos vivem na página «Documentos» do módulo anterior, que tem o mesmo acesso.
    routes: [
      {
        path: '',
        title: 'Versionamento e templates',
        loadComponent: () =>
          import('../../../shared/routing/capability-redirect').then((m) => m.CapabilityRedirect),
      },
    ],
  }),
] as const;

import { defineModule } from '../../../core/modules/define-module';

export const DOCUMENTS_MODULES = [
  defineModule({
    code: 'documents.dms',
    name: 'DMS e anexos',
    description: 'Gestão documental e anexos transversais.',
    group: 'documents',
    icon: 'folder',
  }),
  defineModule({
    code: 'documents.versioning',
    name: 'Versionamento e templates',
    description: 'Versões de documentos e modelos reutilizáveis.',
    group: 'documents',
    icon: 'folder',
    dependencies: ['documents.dms'],
  }),
] as const;

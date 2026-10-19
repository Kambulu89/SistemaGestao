/** Registos de demonstração, por tenant. Os ids são determinísticos (`<entidade>-<n>`). */
import type { EntityRecord, RecordData } from '../dynamic/models/entity-record.model';

const ATLAS = 't-atlas';
const ESCOLA = 't-escola';

let sequence = 0;
const counters = new Map<string, number>();

function seed(
  tenantId: string,
  entityKey: string,
  data: RecordData,
  options: { status?: string | null; definitionVersion?: number; actor?: string } = {},
): EntityRecord {
  const n = (counters.get(entityKey) ?? 0) + 1;
  counters.set(entityKey, n);
  sequence += 1;
  const day = String(1 + (sequence % 27)).padStart(2, '0');
  const at = `2026-0${1 + (sequence % 8)}-${day}T09:00:00Z`;
  return {
    id: `${entityKey}-${n}`,
    entityKey,
    tenantId,
    definitionVersion: options.definitionVersion ?? 2,
    status: options.status ?? null,
    data,
    rowVersion: 1,
    createdAt: at,
    createdBy: options.actor ?? 'u-frota',
    updatedAt: at,
    updatedBy: options.actor ?? 'u-frota',
  };
}

const vehicle = (
  matricula: string,
  marca: string,
  modelo: string | null,
  combustivel: string,
  quilometragem: number,
  status: string,
  numeroChassis?: string,
) =>
  seed(
    ATLAS,
    'vehicle',
    {
      matricula,
      marca,
      modelo,
      combustivel,
      quilometragem,
      ...(numeroChassis ? { numeroChassis } : {}),
    },
    // Os registos sem número de chassis foram criados quando a definição ainda estava na v1.
    { status, definitionVersion: numeroChassis ? 2 : 1 },
  );

const customer = (tenantId: string, data: RecordData) =>
  seed(tenantId, 'customer', data, { definitionVersion: 1, actor: 'u-admin' });

export const MOCK_ENTITY_RECORDS: readonly EntityRecord[] = [
  customer(ESCOLA, {
    nome: 'Colégio Santa Maria',
    email: 'geral@santamaria.example',
    sectorActividade: 'educacao',
    nifSecundario: '501234567',
    categoriaCliente: 'A',
    dataRenovacao: '2027-01-15',
  }),
  customer(ESCOLA, { nome: 'Clínica do Parque', sectorActividade: 'saude', categoriaCliente: 'B' }),
  customer(ESCOLA, {
    nome: 'Papelaria Central',
    telefone: '+351 213 000 111',
    sectorActividade: 'comercio',
    faxAntigo: '213 000 112',
  }),
  customer(ESCOLA, { nome: 'Academia Delta', sectorActividade: 'educacao', categoriaCliente: 'C' }),
  customer(ATLAS, { nome: 'Logística Norte', regiaoComercial: 'norte', codigoInterno: 'LN-01' }),
  customer(ATLAS, { nome: 'Armazéns do Sul', regiaoComercial: 'sul', codigoInterno: 'AS-02' }),
  customer(ATLAS, { nome: 'Cimentos Centro', regiaoComercial: 'centro' }),
  customer('t-clinica', { nome: 'Paciente Exemplo', email: 'paciente@example.pt' }),
  customer('t-clinica', { nome: 'Seguradora Vida' }),

  vehicle('AA-11-BB', 'Volvo', 'FH 500', 'gasoleo', 12500, 'available', 'YV2RT40A9KB123456'),
  vehicle('CC-22-DD', 'Scania', 'R450', 'gasoleo', 88000, 'maintenance'),
  vehicle('EE-33-FF', 'MAN', 'TGX', 'gasoleo', 150000, 'available'),
  vehicle('GG-44-HH', 'Mercedes', 'eActros', 'eletrico', 3000, 'available', 'WDB9634031L987654'),
  vehicle('II-55-JJ', 'Renault', 'Master', 'gasolina', 45000, 'inactive'),
  vehicle('KK-66-LL', 'Iveco', 'Daily', 'hibrido', 22000, 'available'),
  vehicle('MM-77-NN', 'DAF', 'XF', 'gasoleo', 210000, 'maintenance'),
  vehicle('OO-88-PP', 'Volvo', 'FM', 'gasoleo', 64000, 'available'),
  vehicle('QQ-99-RR', 'Toyota', 'Hilux', 'gasolina', 15000, 'available'),
  vehicle('SS-00-TT', 'Ford', 'Transit', 'hibrido', 9000, 'inactive'),
  vehicle('UU-10-VV', 'Scania', 'S500', 'gasoleo', 120000, 'available', 'YS2S500000123456'),
  vehicle('WW-20-XX', 'Mercedes', null, 'gasoleo', 78000, 'available'),

  seed(
    ATLAS,
    'driver',
    {
      nome: 'Rui Carvalho',
      numeroCarta: 'L-100200',
      categoria: 'B',
      validadeCarta: '2031-04-12',
      telefone: '+351 912 345 678',
      viatura: 'vehicle-6',
    },
    { definitionVersion: 1 },
  ),
  seed(
    ATLAS,
    'driver',
    {
      nome: 'Ana Ferreira',
      numeroCarta: 'L-100201',
      categoria: 'C',
      numeroCap: 'CAP-5521',
      validadeCarta: '2028-09-30',
      email: 'ana.ferreira@atlas.example',
      viatura: 'vehicle-1',
    },
    { definitionVersion: 1 },
  ),
  seed(
    ATLAS,
    'driver',
    {
      nome: 'Carlos Mendes',
      numeroCarta: 'L-100202',
      categoria: 'D',
      numeroCap: 'CAP-7734',
      validadeCarta: '2027-02-18',
      viatura: 'vehicle-3',
    },
    { definitionVersion: 1 },
  ),
  seed(
    ATLAS,
    'driver',
    { nome: 'Marta Lopes', numeroCarta: 'L-100203', categoria: 'B', validadeCarta: '2030-11-05' },
    { definitionVersion: 1 },
  ),

  seed(
    ATLAS,
    'note',
    {
      titulo: 'Renovar seguro da frota',
      conteudo: 'Pedir três cotações antes do fim do mês.',
      prioridade: 'alta',
      prazo: '2026-11-15',
      concluida: false,
    },
    { definitionVersion: 1 },
  ),
  seed(
    ATLAS,
    'note',
    {
      titulo: 'Agendar inspecção periódica',
      prioridade: 'media',
      prazo: '2026-12-01',
      concluida: false,
    },
    { definitionVersion: 1 },
  ),

  seed(
    ESCOLA,
    'note',
    {
      titulo: 'Reunião de pais',
      conteudo: 'Preparar apresentação do 1.º período.',
      prioridade: 'alta',
      prazo: '2026-10-30',
      concluida: false,
    },
    { definitionVersion: 1, actor: 'u-escola' },
  ),
  seed(
    ESCOLA,
    'note',
    { titulo: 'Encomendar manuais', prioridade: 'baixa', concluida: true },
    { definitionVersion: 1, actor: 'u-escola' },
  ),
  seed(
    ESCOLA,
    'note',
    {
      titulo: 'Rever calendário de exames',
      prioridade: 'media',
      prazo: '2027-01-10',
      concluida: false,
    },
    { definitionVersion: 1, actor: 'u-escola' },
  ),
];

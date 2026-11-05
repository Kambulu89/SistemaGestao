# Decisões

## D-001 Recomeço sobre AdonisJS 7, sem Redis (aceite)

O projecto anterior (AdonisJS 6, Redis) fica no histórico Git (`2ead09c` na `main`). Escolha do utilizador: construir sobre
a estrutura nova (AdonisJS 7.6, Angular 22, PostgreSQL 16), reutilizando desenhos do anterior quando poupam trabalho.

## D-002 Isolamento por RLS forçada com duas contas PostgreSQL (aceite)

Os filtros nos repositórios não bastam: um esquecimento expõe dados de outra empresa. Cada tabela de tenant tem RLS
`FORCE` e a aplicação usa uma conta sem `BYPASSRLS`; o tenant é definido por transacção. Testado em
`tenancy.spec.ts` (dois tenants, escrita cruzada recusada) e garantido para novas tabelas por `schema_conformance.spec.ts`.

## D-003 Sessão em cookie HttpOnly + CSRF em vez de tokens Bearer (aceite)

O kit API do AdonisJS usava tokens de acesso sem validade e um registo público. Um token em JavaScript fica exposto a XSS;
o cookie HttpOnly não. Sessões opacas em PostgreSQL permitem revogar e listar sessões. Removidos `@adonisjs/auth`,
`@adonisjs/session` e `@tuyau/core`.

## D-004 SQL parametrizado em vez de modelos Lucid (aceite)

O acesso a dados de tenant tem de correr dentro da transacção com `app.tenant_id`; repositórios com SQL explícito tornam
isso visível e evitam consultas fora do âmbito. A geração automática de esquema do Lucid foi desligada.

## D-005 RBAC com âmbitos TENANT/OWN nesta fase (aceite)

O Prompt 03 pede âmbitos por empresa, entidade legal, filial, departamento, equipa e próprio. Entidades legais, filiais e
departamentos só existem no bloco 3.4; criar âmbitos que apontam para tabelas inexistentes seria uma funcionalidade
falsa. A coluna `scope_type` aceita hoje `TENANT` e `OWN` (CHECK); o 3.4 alarga-a e acrescenta `scope_id` com FK composta.

## D-006 Email sem fornecedor real (aceite)

O fornecedor de email é uma decisão pendente. Convites e recuperação funcionam ponta a ponta, mas com `MAIL_DRIVER=none` a
resposta diz `NOT_CONFIGURED`; nunca se apresenta um envio que não aconteceu.

## D-007 Estrutura organizacional sem eliminação física (aceite)

Entidades legais, filiais, departamentos, cargos e centros de custo vão ser referenciados por documentos, contratos e
lançamentos; apagar quebraria o histórico. Desactiva-se (`status = INACTIVE`) e a vigência regista o período. Anexos,
moradas, responsáveis e histórico de alterações entram no Prompt 05.

## D-008 Subscrições como plano de controlo global; entitlement separado do RBAC (aceite)

Planos, subscrições e excepções pertencem à plataforma e não a uma empresa, por isso são tabelas globais alteradas só por
administradores da plataforma (`users.is_platform_admin`, concedido por comando). Ter a funcionalidade contratada não dá
acesso a ninguém: a rota exige o entitlement **e** a permissão. Não há planos, preços nem cobrança semeados: os planos
criam-se em ambiente local com `plan:create` ou pela API da plataforma; faturação e pagamentos aguardam decisão comercial.
Sem subscrição activa o tenant não tem funcionalidades (negar por omissão).

## D-009 Transversais: auditoria na transacção, aprovações sem permissão de decisão, anexos herdam acesso (aceite)

- A auditoria é gravada na mesma transacção da operação (não num log assíncrono) para nunca haver operação sem rasto
  nem rasto sem operação; a tabela é só de acrescentar, por privilégios e por trigger.
- Decidir uma aprovação é uma atribuição (aprovador da etapa ou delegado), não uma permissão RBAC; as permissões só
  regem ver tudo, pedir e gerir workflows. Requerente nunca aprova o próprio pedido.
- Os anexos não têm permissões próprias: herdam a autorização e a funcionalidade contratada do registo a que pertencem,
  para não haver um caminho paralelo de acesso aos dados.
- Notificações só in-app enquanto não houver fornecedor de email escolhido; o centro de tarefas é uma vista derivada.
- O único tipo de assunto é `manual`: não se criam assuntos provisórios de módulos que ainda não existem.

## D-010 Frontend sem biblioteca de estado e com primitivas mínimas até ao design system (aceite)

O estado partilhado é pequeno (sessão, empresa, permissões) e cabe em dois serviços com sinais; não se adiciona NgRx ou
semelhante. Os componentes usam primitivas CSS mínimas para não antecipar o design system (Prompt 04), que as vai
substituir. `GET /context` passou a devolver as funcionalidades activas e o estado da subscrição (só para a navegação) e
`GET /platform/tenants/:id` foi acrescentado para o detalhe da empresa na plataforma. A delegação de aprovações exige
ver a lista de membros (`members.read`); um directório mínimo de colegas fica para decisão posterior.

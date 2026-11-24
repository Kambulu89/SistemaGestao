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

## D-011 Qualidade da fundação: protecção de rotas verificada e dados de demonstração isolados (aceite)

A protecção de cada rota é verificada a partir do próprio router (não de uma lista mantida à mão): uma rota nova sem
sessão, sem contexto de empresa ou sem `can()` falha o teste, salvo se constar das listas explícitas com justificação.
Os dados de demonstração são um seeder Lucid limitado a desenvolvimento/testes, construído só com as APIs públicas dos
módulos (passam pelas mesmas regras e ficam auditados), com contas `@demo.invalid` e sem efeito se a empresa `DEMO`
já existir.

## D-012 Design system próprio sobre Tailwind, sem biblioteca de componentes (aceite)

Tokens semânticos em CSS (`--c-*`) com tema escuro por atributo e utilidades Tailwind ligadas por `@theme inline`;
componentes próprios pequenos, construídos sobre elementos nativos acessíveis (`<dialog>`, `<select>`, inputs) e os
padrões ARIA de combobox, menu e tabs. Evita uma dependência grande e mantém controlo sobre contraste (testado),
densidade e comportamento de teclado. Gráficos simples em HTML/CSS; uma biblioteca de gráficos entra só quando houver
relatórios que a justifiquem (Prompt 26). O âmbito de trabalho (entidade legal/filial) é preferência de apresentação,
não autorização.

## D-013 Configurações da empresa como contratos para os módulos de negócio (aceite)

Perfil, precisões, câmbios, séries, calendários e contas bancárias ficam num módulo `settings` que expõe funções
(`tenantSettings`, `rateOn`, `reserveDocumentNumber`, dias úteis) em vez de tabelas partilhadas: Facturação,
Compras, Inventário, Finanças, Contabilidade, RH e Assiduidade chamam-nas na sua transacção. A numeração documental é
atribuída sob bloqueio da série, sem lacunas e sem recuo. Contas bancárias passam por aprovação configurável (o efeito
é registado pelo módulo dono no arranque, `start/module_hooks.ts`) e os dados bancários não se editam (protecção
contra fraude). Câmbios são introduzidos pela empresa (sem fonte externa automática até haver integração validada).
Nenhuma regra fiscal ou laboral é implementada aqui; o regime fiscal é só identificação.

## D-014 Contabilidade sem plano oficial pré-carregado e com controlo de partidas dobradas no servidor (aceite)

O plano de contas é criado (ou, no bloco 6.4, importado) pela empresa: não se pré-carrega o PGC angolano nem se
alega conformidade AGT/SAF-T, porque a versão em vigor e os critérios dos mapas têm de ser confirmados com a norma
oficial antes de qualquer alegação. O campo "modelo de referência" é só texto. As regras que garantem a integridade
ficam no servidor e, para a imutabilidade, também na base de dados (triggers): um lançamento contabilizado não muda e
corrige-se por estorno. O equilíbrio exige-se nas duas moedas para que o razão funcional nunca fique desequilibrado
por arredondamentos. O fluxo de aprovação é interno ao lançamento (segregação de funções), sem passar pelos workflows
genéricos, para não depender da funcionalidade de aprovações; poderá ligar-se a eles mais tarde se for pedido.

## D-015 Motor de contabilização por regras configuráveis e eventos idempotentes (aceite)

Os módulos de negócio não escrevem lançamentos nem conhecem contas: publicam eventos (origem, evento, referência,
data, montantes nomeados, dimensões) e a contabilidade aplica a regra activa da entidade legal nessa data. As contas
ficam na regra, escolhidas pela empresa no seu plano (sem códigos fixos no código, coerente com D-014). Uma regra
usada é imutável e a mudança faz-se por vigência, para que o histórico continue explicável. O evento é idempotente
pela referência, para que reenvios (rede, reprocessamento, integrações) nunca dupliquem lançamentos. Dentro do
servidor o evento corre na transacção do módulo que o emite (tudo ou nada); pela API, as falhas ficam registadas com a
mensagem para poderem ser corrigidas e reprocessadas. A entrega assíncrona (fila/outbox) só entra se houver
necessidade medida — hoje o PostgreSQL e a transacção partilhada bastam.

## D-016 Analítica como camada sobre o razão, editável depois de contabilizar (aceite)

As imputações a centros de custo e dimensões não geram lançamentos nem alteram linhas: repartem o valor de cada linha
em percentagens que somam 100%, e a repartição é exacta (maior resto). Assim o razão e o balancete nunca mudam por
causa da analítica, e o relatório analítico confere sempre com eles. Por não tocarem no razão, as imputações podem ser
corrigidas depois da contabilização, com auditoria de cada alteração (antes/depois), o que é a prática comum em
controlo de gestão. Ficam ligadas por (lançamento, n.º de linha) e não ao id físico das linhas; alterar as linhas de
um rascunho apaga-as.

## D-017 Activos fixos geram lançamentos directamente, com contas na classe (aceite)

Os activos fixos não passam pelo motor de regras (6.3): as contas vêm da classe do activo, configurada pela empresa,
porque cada classe tem as suas contas (equipamento, viaturas, edifícios…) e uma regra por origem/evento não as
distingue. O módulo cria e contabiliza o lançamento na mesma transacção que muda a ficha (origem `FIXED_ASSETS`),
sem fluxo de aprovação: a permissão `fixed_assets.post` é a autorização. Para a ficha e o razão nunca divergirem,
estes lançamentos só se estornam pela ficha ou pela anulação do mês de depreciação; o estorno genérico recusa-os.
O mapa de depreciação é recalculado a partir da ficha (nunca guardado) e as depreciações feitas ficam numa tabela com
uma linha por activo e mês (UNIQUE), que é o que impede depreciar duas vezes. Vidas úteis, métodos e coeficientes são
configurados pela empresa; não se assumem taxas fiscais angolanas sem validação normativa.

## D-018 Regularizações geram rascunhos; diferenças cambiais por saldo em moeda (aceite)

Recorrências, acréscimos, diferimentos, provisões e diferenças cambiais não contabilizam directamente: criam
lançamentos em rascunho, origem própria (`ADJUSTMENT`, `PROVISION`, `FX_REVALUATION`), que seguem submissão, aprovação
e contabilização com segregação de funções — são estimativas e julgamentos de fecho, não factos de outro módulo. Cada
ocorrência referencia o seu rascunho com `ON DELETE CASCADE`, por isso apagar o rascunho liberta o mês ou o movimento
sem estados paralelos. As diferenças cambiais são calculadas sobre os saldos contabilizados por conta, moeda e terceiro
das contas que o utilizador escolhe (itens monetários; activos não monetários não se actualizam), e as diferenças
realizadas são o resíduo funcional de um saldo já liquidado em moeda — não dependem do módulo de Finanças, que ainda
não existe. Não se assumem câmbios nem critérios fiscais: o câmbio é o registado pela empresa.

## D-019 Demonstrações por modelos versionados e prefixos, sem modelo oficial embutido (aceite)

O balanço e a demonstração de resultados vêm de modelos configurados pela empresa por plano de contas, não de mapas
fixos no código: o PGC angolano e os critérios dos mapas têm de ser confirmados na fonte oficial antes de qualquer
alegação, e cada empresa tem o seu plano. As contas entram por prefixo de código (com regra de saldo devedor/credor
para contas que mudam de lado, como bancos), e cada conta vai para o prefixo mais longo — uma única linha —, por isso a
demonstração nunca conta duas vezes um saldo e o que ficar sem linha é mostrado e impede a conferência. Os modelos são
versionados: publicar fixa a versão (as demonstrações de um exercício podem sempre ser refeitas com a versão usada) e
uma alteração é uma nova versão. As demonstrações não se guardam: são recalculadas do razão. Fluxos de caixa não são
gerados enquanto não houver classificação dos fluxos de tesouraria (Prompt 11); o Excel é gerado no browser sem novas
dependências e o PDF é o da impressão do browser.

## D-020 Fecho por checklist com avisos reconhecidos; encerramento por lançamentos normais (aceite)

O fecho de um período corre uma checklist calculada no momento: o que torna o razão errado (lançamentos a meio do
fluxo, desequilíbrio) bloqueia; o que é provável esquecimento (rascunhos, eventos falhados, depreciações, regularizações
ou diferenças cambiais por fazer, tarefas manuais) é aviso, que se pode reconhecer de forma explícita e auditada —
bloquear sempre impediria fechar quando um módulo externo falha, e não avisar deixaria esquecimentos silenciosos. O
encerramento do exercício não guarda saldos noutra tabela: apura os resultados e transporta os saldos com lançamentos
contabilizados normais (origens `YEAR_CLOSE` e `YEAR_OPENING`), por isso o balancete, o razão e as demonstrações de
ambos os exercícios continuam a vir só dos lançamentos. Reabrir estorna esses lançamentos (nunca os apaga) e o registo
do encerramento fica no histórico. O transporte é na moeda funcional; o detalhe por moeda estrangeira não passa para
o exercício seguinte (a actualização cambial do 6.7 continua a funcionar sobre os saldos em moeda dos lançamentos).

## D-021 Identidade "Corporate Blue", navegação por domínios e preferências do membro no servidor (aceite)

O prompt de interface profissional fixa a identidade (primária `#174EA6`, interactiva `#2563EB`, sucesso `#0D9488`,
aviso `#D97706`, erro `#DC2626`, fundo `#F6F8FB`, Inter). Os tokens semânticos mantêm-se e só mudam os valores, por isso
os ecrãs existentes herdam a identidade sem alterações; o sucesso e o aviso indicados não têm 4.5:1 com texto branco nem
sobre branco, por isso são usados em preenchimentos, ícones e barras (3:1) e o texto de estado usa variantes mais
escuras — o teste de contraste verifica os dois usos nos dois temas. A Inter é auto-alojada (pacote npm, sem CDN) para
não depender nem informar terceiros. A navegação passa a domínios do ERP com secções e mostra só domínios com módulos
reais (sem entradas fictícias). Favoritos e disposição do painel são preferências do membro guardadas no PostgreSQL
(`member_preferences`, por membership, com RLS, validadas por chave e sem dados de negócio — por isso fora da auditoria),
para seguirem o utilizador entre browsers; os recentes ficam no browser, por serem só histórico local de navegação.

## D-022 Estado das listas na URL e preferências de vista no browser (aceite)

As listagens guardam pesquisa, filtros, ordenação e página nos parâmetros da URL: uma ligação abre a mesma vista,
voltar atrás repõe-na e o servidor faz sempre a filtragem, a ordenação (lista fechada de campos por recurso) e a
paginação. A escolha de colunas e os rascunhos de formulários ficam no browser, por utilizador e empresa: são
conveniências de um posto de trabalho, não dados de negócio, e um rascunho só passa a registo quando a API o aceita.
Rascunhos de um registo existente ficam associados à versão, para não se reaplicarem sobre uma alteração feita
entretanto por outra pessoa.

## D-023 Pré-visualização só de tipos passivos; quadros e assistentes só pedem à API (aceite)

A pré-visualização de ficheiros mostra apenas PDF (visualizador do browser), imagens raster e texto simples; HTML, SVG
e outros tipos activos só se descarregam, porque um ficheiro carregado por um utilizador não pode executar código na
sessão de outro. O ficheiro vem pela mesma rota autorizada da descarga e o URL temporário é libertado ao fechar. O
quadro kanban e o assistente não decidem nada: mover um cartão ou concluir um assistente é um pedido à API, e o estado
mostrado é sempre o que a API devolve depois (se recusar, nada muda). O assistente de encerramento substitui a
confirmação por um passo de revisão explícito com todos os parâmetros.

## D-024 RH: âmbito verificado no serviço, dados pessoais por campo e colaborador ≠ utilizador (aceite)

O colaborador (`employees`) é uma ficha de RH e não uma conta: pode existir sem utilizador e liga-se opcionalmente a uma
membership (uma por empresa) para self-service. Filial, departamento, cargo e centro de custo são referências à
estrutura organizacional (sem cópias); o servidor exige que sejam da mesma entidade legal, activos e coerentes
(departamento da filial escolhida) e recusa ciclos na hierarquia. A autorização de RH precisa de âmbitos parciais
(chefe de departamento, RH de uma entidade legal, o próprio colaborador), que o middleware `can()` não aceita — por
isso as rotas de RH verificam `permissionScope` no serviço (justificado no teste de protecção de rotas): listas e fichas
fora do âmbito não existem (404), gerir exige âmbito sobre a colocação antiga e a nova (`own` nunca chega para gerir).
Os dados pessoais (`hr.sensitive`) são controlados por campo: as listas e a exportação nunca os trazem, a ficha só os
preenche a quem tem a permissão no âmbito do colaborador, escrevê-los sem ela dá 403 e a auditoria regista que mudaram
mas nunca os valores (`[RESERVADO]`). Os anexos do colaborador seguem o acesso aos dados pessoais. Por conterem dados
pessoais, os formulários de RH não guardam rascunhos no browser (excepção a D-022). A cessação fica reservada ao fluxo
de desligamento (7.11); aqui só há activo ↔ suspenso, com motivo opcional e auditado.

## D-025 Recrutamento: âmbito da vaga, aprovação directa ou por workflow e contratação atómica (aceite)

O recrutamento (7.2) reutiliza a estrutura organizacional: a vaga refere entidade legal, filial, departamento e cargo
(sem cadastros próprios) e é essa colocação que decide o âmbito de `hr.recruitment.read|manage|approve` (como em D-024,
verificado no serviço); candidaturas, entrevistas e propostas herdam o âmbito da vaga e fora dele não existem (404). Os
candidatos não são colaboradores nem utilizadores e só guardam contactos mínimos; a auditoria regista que mudaram, nunca
os valores. Vagas e propostas são aprovadas por um workflow configurável por empresa (`hr_settings`, tipos de assunto
`job_requisition` e `job_offer`, efeito aplicado na transacção da decisão) ou, sem workflow, por decisão directa de quem
tem `hr.recruitment.approve` no âmbito — nunca quem a preparou (segregação). A remuneração aprovada na vaga limita a
proposta (comparação em cêntimos inteiros/`numeric`, nunca `float`). A contratação converte a proposta aceite em
colaborador com a mesma regra de 7.1 (`hr.manage` na colocação; contactos do candidato só passam a dados pessoais com
`hr.sensitive`), cria a checklist de onboarding e marca a vaga preenchida, tudo numa transacção com a vaga bloqueada:
duas contratações do último posto não passam ambas e repetir não cria outro colaborador. O entrevistador vê e avalia só
as suas entrevistas, mesmo sem outras permissões de RH.

## D-026 Contratos com adendas datadas e carreira com vigência; a colocação só muda por movimento (aceite)

O contrato de trabalho (7.3) guarda as condições iniciais e, depois de activado, nunca é reescrito: alterações de
remuneração, horas, horário ou termo são adendas (ou renovações) só de acréscimo, com data de efeito que não pode ser
anterior à última adenda nem ao início. As condições numa data são as iniciais com as adendas em vigor nessa data
(`termsAt`, exportado como `contractTermsAt` para o processamento salarial). Há no máximo um contrato em vigor por
colaborador (índice parcial) e um novo não se sobrepõe a um anterior terminado. Suspender, retomar e terminar ficam no
histórico do contrato com data e motivo; a cessação completa (aviso, férias proporcionais, liquidação) é o bloco 7.11.
Os contratos são confidenciais: permissões próprias `hr.contracts.read|manage` no âmbito do colaborador (o próprio vê
os seus com âmbito OWN) e a remuneração nunca vai para a auditoria (`[RESERVADO]`). A colocação (filial, departamento,
cargo, superior, centro de custo) passa a ter histórico com vigência (`employment_assignments`): transferências,
promoções e alterações fecham o período corrente na véspera e actualizam a ficha na mesma transacção; a ficha deixa de
aceitar mudanças de colocação (422 `USE_MOVEMENT`) e a entidade legal não muda por movimento (é outro contrato noutra
entidade). Movimentos só com data até hoje (sem agendamento por agora). Limites legais (duração e renovações de
contratos a prazo, período experimental) não estão no código: dependem da Lei Geral do Trabalho em vigor e ficam por
confirmar antes de qualquer validação legal.

## D-027 Férias: política versionada sem valores legais fixos, conta-corrente de dias e confidencialidade médica (aceite)

Os dias de férias, a regra do ano de admissão (completo, proporcional aos meses completos ou dias por mês completo), o
arredondamento e o transporte máximo vêm de uma política configurada pela empresa, com a fonte legal obrigatória e
versionada: publicada não se altera, uma nova versão começa numa data posterior e fecha a anterior na véspera; não há
duas políticas em vigor para o mesmo âmbito. O sistema não fixa nenhum valor da Lei Geral do Trabalho. O saldo é uma
conta-corrente só de acréscimo por colaborador e ano (direito, transporte, expiração, ajuste, gozo, reversão), em
`numeric(6,2)`; gerar o direito é idempotente (um direito, um transporte e uma expiração por ano, garantidos pela base
de dados) e um recálculo regista só a diferença. Os dias de um pedido são contados pelo servidor (dias úteis do
calendário da política, com feriados, ou dias de calendário), no mesmo ano, sem sobreposição e dentro do saldo
disponível (que desconta os pendentes); a aprovação volta a verificar o saldo com o colaborador bloqueado. Decide a
chefia directa ou quem tem `hr.leave.approve` no âmbito — nunca o próprio nem quem registou o pedido. Cancelar uma
ausência aprovada é de quem gere e devolve os dias por reversão. Tipos confidenciais (ex.: doença) mostram a quem
decide só as datas: tipo, motivo e justificativos ficam para o próprio e para `hr.sensitive`, e a auditoria não regista o
tipo nem o motivo. As ausências aprovadas ficam disponíveis para assiduidade e processamento salarial
(`approvedAbsences`).

## D-028 Compensação: base no contrato, componentes com vigência por proposta aprovada e incidência versionada (aceite)

O salário base continua a viver só no contrato (7.3); a compensação trata os outros componentes (subsídios, prémios,
horas extra, abonos, descontos) de um catálogo da empresa, em montante fixo ou percentagem do salário base do contrato
em vigor na data — nunca há duas fontes para o mesmo valor. A incidência de IRT e INSS de cada componente (com parte
isenta de IRT opcional) é versionada por data de início e exige a fonte legal; uma nova versão começa depois da anterior
e nunca a altera; nenhuma taxa ou limite legal está no código. Os componentes do colaborador só mudam por propostas
(rascunho → aprovação → aplicada): decide quem tem `hr.compensation.approve` no âmbito, nunca quem preparou nem o
próprio colaborador, ou o workflow configurado (`compensation_proposal`). Aplicar fecha o período em vigor na véspera e
abre o novo, na mesma transacção e com o colaborador bloqueado; volta a validar o estado (contrato na data, nada
posterior em vigor, só remove o que existe) e recusa propostas desactualizadas (409 `STALE_PROPOSAL`). O histórico nunca
é apagado nem reescrito. Os valores nunca vão para a auditoria. Os componentes variáveis (ex.: horas extra) não ficam na
ficha: entram por período no processamento (7.7), que obtém a remuneração numa data com `compensationAt`.

## D-029 Adiantamentos e empréstimos: plano criado na aprovação, limites configurados com fonte e liquidação única (aceite)

Um adiantamento (uma prestação) ou empréstimo (1 a 120 prestações mensais) a um colaborador é um pedido com código
automático por empresa e ano (`ADI-AAAA-NNNN`, `EMP-AAAA-NNNN`), sem juros (o prompt não os prevê). Rascunho → aguarda
aprovação → activo → liquidado (ou recusado/cancelado antes da aprovação). Decide quem tem `hr.loans.approve` no âmbito
da colocação do colaborador, nunca quem preparou nem o próprio. Ao submeter e de novo ao aprovar valida-se: o primeiro
desconto não é num mês passado; há contrato em cada mês de desconto (incluindo o fim de um contrato a termo) e na mesma
moeda; e, se a empresa os configurou, o número máximo de prestações e a prestação máxima em percentagem do salário base
desse mês, somando as prestações pendentes dos outros empréstimos activos. Os limites ficam em `hr_settings` e exigem a
fonte (regulamento interno ou norma legal confirmada); nenhum limite legal está no código. O plano (partes iguais ao
cêntimo, resto na última) só é gravado na aprovação; um empréstimo aprovado não se cancela, liquida-se. Cada prestação
sai de `PENDING` uma única vez — por desconto no processamento (`recordLoanDeduction`, idempotente pela referência do
processamento; outra referência dá 409 `ALREADY_SETTLED`) ou por pagamento directo com referência — e a base de dados
exige referência e data em toda a prestação liquidada. O saldo é derivado das prestações, nunca guardado à parte. Quando
não resta nada pendente o empréstimo passa a liquidado. Os montantes não vão para a auditoria.

## D-030 Processamento salarial: regras versionadas com fonte, lotes com instantâneo e hash, fecho imutável (aceite)

O cálculo é uma função pura em cêntimos (`bigint`, meio para cima): salário base proporcional aos dias pagáveis do mês
(contrato e suspensões), componentes da ficha (os de abono recorrentes na mesma proporção), valores variáveis do lote,
faltas não remuneradas (base ÷ base de dias × dias), bases de INSS e IRT pela incidência de cada linha (com a parte
isenta), INSS do trabalhador, IRT por tabela progressiva (parcela fixa + taxa × (base − excesso)), descontos
autorizados, prestações de empréstimos, INSS patronal e custo para a empresa. Os totais derivam das linhas. Nenhum valor
legal está no código: as taxas, a tabela, a incidência do salário base, se a base do IRT deduz o INSS e a base de dias
vêm de **regras versionadas por moeda e data de início, com fonte obrigatória**, imutáveis depois de publicadas (trigger).
Valores em falta não se inventam: o colaborador fica com erro (sem regras, incidência por definir, IRT fora da tabela,
líquido negativo, sem dias pagáveis) e o lote não avança até se corrigir ou excluir. Os lotes são por entidade legal e
mês: regular (um activo por mês), extra (só o que se lança no lote) e retroactivo (num mês aberto, a diferença linha a
linha entre o recálculo de um mês fechado e o já processado, sem empréstimos). Calcular é repetível e sem efeitos (a
simulação); guarda o instantâneo de cada colaborador e um hash do conjunto. Submeter, aprovar e fechar voltam a montar os
dados e recusam (`STALE_RUN`) se mudaram. Aprova outra pessoa com `hr.payroll.approve`, nunca quem preparou ou calculou
nem quem tem o recibo no lote; recusar volta a "calculado". Fechar regista os descontos dos empréstimos com o código do
lote (idempotente) e, no regular, fecha o mês. Resultados de lotes submetidos, aprovados ou fechados não se alteram nem
apagam (trigger); correcções fazem-se por retroactivo. A auditoria guarda contagens e o hash, nunca montantes
individuais. A verificação contra casos de teste oficiais e a confirmação das normas angolanas ficam para o 7.8.

## D-031 IRT/INSS: publicar só com casos de teste oficiais a passar e normas confirmadas por uma pessoa (aceite)

As regras do processamento (D-030) ganham **validade explícita** (início e, opcionalmente, fim: depois do fim, sem versão
seguinte, não há regras em vigor e o processamento dá erro em vez de usar uma versão antiga), **casos de teste
oficiais** (exemplo com salário base e abonos por incidência, valores esperados de INSS do trabalhador e IRT e,
opcionalmente, INSS da empresa e líquido, cada um com a fonte) e a **confirmação das normas vigentes**: uma pessoa com
`hr.payroll.settings` declara, com nota, que conferiu os valores na fonte indicada. Confirmar exige pelo menos um caso e
que todos passem ao cêntimo; publicar volta a correr os casos e exige a confirmação; qualquer alteração ao rascunho
apaga a confirmação. Depois de publicados, regras e casos não mudam (triggers). Um simulador mostra o recibo de um
exemplo com uma versão, sem gravar nada, para preparar os casos. Continua a não haver valores legais no código nem
pré-carregados: o projecto não confirma a legislação angolana em vigor — é a empresa que introduz e confirma, com a
fonte (por exemplo, o Código do IRT e as taxas de segurança social publicadas), e a LGT n.º 12/23 é a referência
laboral indicada no prompt.

## D-032 Recibos, pagamento e contabilização: fechado ≠ pago, obrigações por lote, eventos únicos para a contabilidade (aceite)

O fecho de um lote (D-030) cria as **obrigações** a pagar por moeda: líquido aos colaboradores, IRT, INSS (trabalhador e
entidade patronal) e outros descontos a entregar a terceiros (as prestações de empréstimos não, porque são da própria
empresa; totais não positivos não geram obrigação). Os **pagamentos** registam-se à parte, com a permissão própria
`hr.payroll.pay` (tesouraria), parciais ou totais, nunca acima do que falta, com data não futura, referência e conta
bancária activa da entidade legal na mesma moeda; são só de acréscimo (trigger). O estado do lote para o colaborador
("pago") vem dos pagamentos do líquido, não do fecho. A **contabilização** (`hr.payroll.manage`) envia ao motor da
contabilidade (D-014/6.3) um evento `PAYROLL/SALARIES` por lote e moeda — montantes `gross`, `inssEmployee`, `irt`,
`deductions`, `loans`, `net`, `inssEmployer`, `inssTotal`, `employerCost` — e um evento `PAYROLL/<TIPO>_PAID` por
pagamento (`amount`); as contas são as das regras que a empresa configura na contabilidade. Cada evento vai uma só vez
(chave idempotente do motor e registo `payroll_postings`); sem regra, nada é lançado e o erro diz qual falta; totais
negativos (retroactivo que devolve) recusam-se para lançamento manual. Como ainda não há módulo de Finanças/Tesouraria,
as obrigações publicam-se por um contrato (`payrollObligations` em `#modules/hr/index`) para esse módulo usar. Os
**recibos em PDF** geram-se no servidor com um gerador mínimo próprio (texto e linhas, sem dependências), só para lotes
fechados, com o IBAN mascarado, e só os descarrega quem processa salários na entidade legal ou o próprio colaborador
("Os meus recibos"); cada descarga fica na auditoria e as respostas não ficam em cache.

## D-033 Formação com competências e certificados; processos disciplinares de acesso restrito e auditado (aceite)

**Formação**: o catálogo da empresa (`hr.training.settings`) tem competências e cursos (modalidade, horas, entidade
formadora, com/sem avaliação, certificado com validade opcional e as competências que dá, com nível 1–5). As sessões
têm datas, capacidade e custo; inscreve quem gere formação no âmbito da colocação dos colaboradores; os resultados só se
registam depois do início (aprovado/reprovado nos cursos com avaliação, presente nos outros, faltou, cancelado).
Concluir exige resultado para todos e atribui as competências do curso a quem concluiu, só se o nível sobe, e emite o
certificado numerado com validade; depois a sessão e os resultados não mudam (trigger). O histórico de competências é só
de acréscimo (formação ou avaliação); o nível actual é o do registo mais recente. O custo por participante é o custo da
sessão repartido pelos inscritos não cancelados, e há um resumo anual por curso e por departamento no âmbito de quem
pede. O próprio vê a sua formação com OWN.

**Processos disciplinares**: permissões próprias `hr.discipline.read|manage`, nunca dadas pelas de RH geral; âmbito pela
colocação; ninguém vê, abre ou trata processos sobre si próprio; cada consulta de um processo fica na auditoria e o
texto dos factos nunca vai para a auditoria. A cronologia (notas, notificação, audiência, defesa, decisão) é só de
acréscimo; uma sanção exige o registo prévio da defesa ou da audiência do trabalhador; encerrado com a decisão e a
fundamentação, o processo não muda (trigger). Os documentos usam os anexos com o mesmo acesso. As sanções são categorias
genéricas: a sua aplicação concreta e prazos seguem a LGT e o regulamento da empresa, que o sistema não codifica.

## D-034 Cessação: processo com aprovação segregada, liquidação pelo processamento salarial e checklist verificada (aceite)

A cessação é um processo próprio (`employee_terminations`, código `CES-AAAA-NNNN`), um em curso ou concluído por
colaborador, com permissões `hr.terminations.read|manage|approve` no âmbito da colocação; ninguém trata a própria
cessação. **Nenhum valor legal está no código**: os dias de aviso exigidos só se gravam com a fonte (contrato, lei ou
convenção) e a indemnização só existe quando a empresa a marca como aplicável, com a base legal e o critério; o sistema
não calcula indemnizações. Calcula só factos (antiguidade, dias de aviso dados e em falta, fracção do ano trabalhada,
saldo de férias) e sugestões claramente rotuladas.

**Liquidação final**: linhas por tipo (férias vencidas, proporcionais, subsídios proporcionais, compensação ou desconto
por falta de aviso, indemnização, outros), cada uma com componente salarial compatível (abono/desconto), fundamentação e,
opcionalmente, quantidade × valor unitário verificada ao cêntimo. Só se alteram em rascunho (trigger); a aprovação cobre
os montantes. A remuneração do último mês não é linha: o processamento regular desse mês já a proporcionaliza pela data
de fim do contrato. O pagamento faz-se por um **lote EXTRA** gerado a partir do processo aprovado (no primeiro mês aberto a
partir do mês do último dia ou do mês corrente, se posterior — correcção do 7.13; exige também `hr.payroll.manage`), com IRT/INSS pela incidência de cada componente; os
valores desse lote não se alteram no processamento (`SETTLEMENT_RUN`) e, se o lote for cancelado, gera-se outro.

**Aprovação** (nem quem preparou nem quem submeteu) bloqueada por: contrato já não em vigor, indemnização marcada sem
linha, despedimento disciplinar sem processo encerrado com essa decisão, ausências por decidir ou posteriores ao último
dia, pedidos de adiantamento por decidir, e meses posteriores já fechados com o colaborador (um mês fechado não se
reabre). Ao aprovar, na mesma transacção: o contrato termina no último dia (evento `TERMINATED`), a colocação em vigor
fecha nessa data, o colaborador passa a `TERMINATED` e o saldo de férias do ano fecha com um ajuste referenciado. Depois
de aprovado só mudam a ligação ao lote e a conclusão (trigger); concluído ou cancelado, nada muda.

**Checklist de saída** gerada na criação (acesso à aplicação se houver conta, devolução do que foi entregue no
acolhimento, equipamentos, documentos e, havendo, empréstimos) e editável. As tarefas de sistema verificam o facto: o
acesso só fica feito com a conta suspensa ou revogada (em Membros, com a permissão de membros — o RH não suspende contas
sozinho) e os empréstimos só sem prestações por liquidar. Concluir exige a checklist tratada e o lote fechado; fechado ≠
pago (D-032): o pagamento do líquido segue no processamento.

## D-035 Portais e relatórios de RH: self-service da própria ficha, chefia pela hierarquia, relatórios só agregados (aceite)

**O meu espaço** (`GET|PATCH /hr/me`) é a ficha ligada à conta do actor, sem permissão adicional: dados próprios (os
pessoais incluídos; IBAN mascarado), contratos e condições em vigor, empréstimos e certificados; férias e recibos vêm
dos endpoints próprios já existentes. O próprio só altera contactos pessoais e de emergência (lista fechada); o resto
(identificação, IBAN, contrato) é dos RH (`NOT_SELF_EDITABLE`). A auditoria guarda os nomes dos campos, nunca os valores.

**A minha equipa** (`GET /hr/team`) deriva da hierarquia da ficha (`manager_id`, até 5 níveis), não de uma permissão:
quem é chefia vê dados básicos da equipa (cargo, departamento, estado), ausências pendentes e aprovadas nos próximos 30
dias com tipos confidenciais mascarados (regra do 7.4), alertas a 60 dias (fim de contrato, fim do período experimental,
certificados) e os pedidos pendentes com a indicação de quais pode decidir — a decisão continua no endpoint e nas regras
do 7.4 (chefia directa ou `hr.leave.approve` no âmbito). Nunca salários nem dados pessoais da equipa.

**Relatórios** (`/hr/reports/*`): efectivos numa data (pela colocação com vigência nessa data e pelo contrato em vigor),
rotatividade mensal e anual (saídas = cessações aprovadas pelo último dia; taxa = saídas / média dos efectivos,
centésimas exactas sem `float`), férias do ano por colaborador e departamento com `hr.reports.read` no âmbito da
colocação actual; folha salarial, IRT, INSS e custo para a empresa só de lotes fechados e só nas entidades legais com
`hr.payroll.read`. Os relatórios devolvem agregados e totais; a exportação CSV é feita no browser a partir do resultado.

## D-036 Catálogo do inventário: SKU/EAN únicos entre produtos e variantes, unidades por produto e classe contabilística (aceite)

O Inventário (módulo `inventory`, funcionalidade `inventory`) é o dono do catálogo. **Produto** com SKU e código de
barras únicos na empresa **entre produtos e variantes** (verificação serializada por empresa + índices únicos por
tabela); códigos numéricos de 8, 12, 13 ou 14 dígitos têm de ter o dígito de controlo GTIN certo, os restantes aceitam-se
como códigos internos. **Tipos**: armazenável, serviço e kit; serviços e kits não movimentam stock — sem lotes, séries,
validade nem limites (regra do serviço e `CHECK` na base); um kit tem componentes armazenáveis activos em unidades base
do componente e não tem variantes. Números de série exigem unidade base inteira; o prazo de validade exige o controlo de
validade.

**Unidades**: a unidade base é a do stock; as conversões são **por produto** (quantas unidades base tem 1 unidade
alternativa, 6 casas decimais exactas) e as unidades de compra e venda têm de ser a base ou ter conversão. As casas
decimais de uma unidade usada não mudam. **Variantes**: SKU, código de barras, atributos (1 a 5 pares, combinação única
sem distinguir maiúsculas) e preço próprio opcional; os movimentos dos blocos seguintes referem produto e variante.

**Contabilização**: o produto não guarda contas (os planos de contas são por entidade legal e as regras de lançamento
já ligam contas a eventos por entidade). Guarda uma **classe contabilística** (ex.: `MERCADORIAS`), definida na
categoria e sobreponível no produto; a efectiva é a do produto ou a da categoria mais próxima. O 8.10 usa a classe para
escolher a regra de lançamento. **Preço comercial** de referência com moeda (4 casas); tabelas de preços ficam para
Vendas. Nada se apaga: produtos, variantes, unidades, categorias e marcas inactivam-se ou descontinuam-se. Imagens e
fichas técnicas usam os anexos (`product`: ler com `inventory.read`, acrescentar com `inventory.products.manage`).


## D-037 Armazéns: entidade legal fixa, localizações com caminho imutável e acesso por âmbito mais lista nos restritos (aceite)

Um **armazém** pertence a uma entidade legal (fixa depois de criado, tal como o código, único na empresa) e opcionalmente
a uma filial **da mesma entidade**; tem responsável (membro activo), tipo (central, loja, trânsito, quarentena,
consignação, outro), morada e estado. As **localizações** formam a hierarquia zona → corredor → estante → posição (cada
nível só abaixo do anterior; só as zonas ficam na raiz, por `CHECK`). O **caminho** (`Z1-C01-E1-P03`) é único no armazém
e é o que vai para etiquetas e documentos: código, superior, nível e caminho **não mudam** e nada se apaga (gatilho
`warehouse_locations_fixed` na base), só se inactiva — e só sem filhas activas; reactivar exige a superior activa. As
posições podem ser geradas em série (prefixo, de/até, largura; até 200 de uma vez, sem códigos repetidos). "Guarda stock"
marca onde o 8.3 aceita saldos; um armazém sem localizações guarda stock sem posição.

**Acesso** = âmbito RBAC + modo do armazém. Ver exige `inventory.read` num âmbito que cubra a entidade (ou a filial, se o
armazém a tiver); gerir (criar, editar, localizações, lista) exige `inventory.warehouses.manage` no mesmo âmbito. Um
armazém **aberto** é visto por quem tem o âmbito; um **restrito** só por quem o gere e pelos membros da lista
(`VIEW` consultar ou `OPERATE` operar). A lista não dá permissões por si: os blocos seguintes exigem a permissão da
operação **e** o acesso `OPERATE` (ou a gestão) — `warehouseAccessFor(scope, id)` é o contrato exportado pelo módulo.
Fora do âmbito o armazém responde 404 (não se revela a existência).

## D-038 Stock: lançamentos só de acréscimo, saldos derivados na base por gatilho, baldes separados e idempotência (aceite)

O Inventário é o **único dono do stock**: os outros módulos (e os documentos do 8.4 em diante) pedem lançamentos com o
contrato `postStock(scope, …)` / `reverseStockPosting(scope, …)` exportado em `inventory/index.ts`, dentro da
transacção de quem chama. Um **lançamento** (`stock_postings`) tem tipo, origem, motivo e uma **chave de idempotência**
única por empresa: repetir o mesmo pedido devolve o lançamento já feito; a mesma chave com outro conteúdo é recusada
(`IDEMPOTENCY_MISMATCH`). As **linhas** (`stock_movements`) somam uma quantidade com sinal (unidades base, 6 casas) a um
**balde**: livre, bloqueado, quarentena (físico = soma dos três), reservado (parte do livre; disponível = livre −
reservado), em trânsito e previsto. Cada tipo só mexe em certos baldes com o sinal certo (ex.: uma mudança de estado
não altera o físico; reservado, trânsito e previsto contam-se no armazém, sem localização).

**Nada se edita nem apaga**: lançamentos e movimentos são só de acréscimo (gatilho na base); corrige-se com um
**estorno** (novo lançamento inverso, no máximo um por lançamento, nunca de um estorno) ou com um novo lançamento. Os
**saldos** (`stock_balances`, por armazém/localização/produto/variante) são **derivados** dos movimentos por gatilho e
a base recusa qualquer escrita directa. Cada balde é ≥ 0 por saldo (`CHECK`) e o reservado nunca excede o livre do
armazém (gatilho de restrição no fim da transacção; o serviço pede a verificação imediata para o erro chegar ao
pedido — sem isso o COMMIT falha e nada fica gravado, mas o cliente da base não reporta o erro).

**Concorrência**: o serviço bloqueia (advisory lock da transacção, por ordem) cada armazém/produto/variante tocado e
verifica os saldos resultantes antes de gravar (`INSUFFICIENT_STOCK`, `OVER_RESERVED`); a base repete as verificações.
Só produtos armazenáveis; com variantes, o stock conta-se por variante; a quantidade respeita as casas da unidade base;
localizações têm de guardar stock e ser do armazém (FK composta); armazéns e localizações inactivos não recebem stock.
Consultar segue o acesso aos armazéns (8.2); lançar exige acesso de operação (os módulos integradores podem dispensar a
verificação e aplicar a sua); a mudança de estado manual exige `inventory.stock.manage` no âmbito do armazém. A
reconciliação compara cada saldo com a soma dos movimentos.

## D-039 Entradas e saídas: documento em rascunho, conferência, confirmações parciais que lançam stock e estornos (aceite)

Um **documento de stock** (entrada ou saída) pertence a um armazém (e à sua entidade legal) e tem origem (compra,
devolução, produção, saldo inicial, consumo, venda, perda, amostra, outra — conforme o tipo), referência, contraparte e
notas. As **linhas** guardam produto/variante, unidade do documento com o **factor de conversão congelado** (a
conversão do produto pode mudar depois sem alterar documentos), quantidade e quantidade base (6 casas, arredondamento
meio para cima; tem de caber nas casas da unidade base), localização que guarda stock, estado do stock na entrada/saída
(livre, quarentena, bloqueado), lote, números de série (um por unidade base; linha com séries confirma-se por inteiro),
validade e custo unitário (só nas entradas, na moeda funcional da entidade; a valorização chega no 8.9).

**Ciclo**: rascunho (editável) → **conferência** (quantidades contadas por linha, com motivo da diferença; reabrível) →
**confirmação**, que lança no stock **só** as quantidades conferidas, por `postStock` (idempotente; as regras e
bloqueios do 8.3 aplicam-se — uma saída sem stock é recusada e nada muda). O que falta fica **parcial**: nova
conferência e nova confirmação, ou **fecho do saldo** com motivo. A última parte de uma linha leva o resto exacto da
quantidade base (sem desvios de arredondamento). **Número**: reservado na primeira confirmação na série documental
activa da entidade legal (`STOCK_RECEIPT` / `STOCK_ISSUE`, a da filial do armazém primeiro), sem buracos por rascunhos
anulados; sem série, a confirmação explica o que configurar. **Anular** só sem confirmações (com motivo). Uma
**confirmação estorna-se** (motivo, idempotente, uma vez): lançamento inverso pelo 8.3 e as quantidades voltam a estar
por confirmar. Nada se apaga: confirmações e as suas linhas são só de acréscimo e as linhas já confirmadas não mudam
(gatilhos na base). Gerir (`inventory.documents.manage`) e confirmar (`inventory.documents.confirm`) são permissões
separadas, no âmbito do armazém e com acesso de operação; quem consulta segue o acesso aos armazéns.

## D-040 Transferências: reserva na aprovação, trânsito no destino, recepção parcial, perdas e fluxo intragrupo (aceite)

Uma **transferência** liga dois armazéns da empresa. Todo o efeito no stock passa pelo contrato do 8.3 (`postStock`):
a **aprovação** reserva na origem (só o stock livre; bloqueado e quarentena não contam para o disponível); a
**expedição** tira da origem as quantidades separadas (ou pedidas), consome a reserva toda (o que não segue volta a
ficar disponível) e põe-nas **em trânsito no armazém de destino**; a **recepção** (parcial ou total, com localização
de destino) tira do trânsito e entra no mesmo estado do stock de origem (quarentena chega em quarentena); o que não
chega fecha-se como **perda em trânsito**, com motivo; **anular** depois de aprovada liberta a reserva. Cada passo é
um evento só de acréscimo com o seu lançamento e chave de idempotência; linhas expedidas não mudam (gatilho).

**Autorização**: quem pede não aprova nem aceita (segregação de funções). Pedir, separar e expedir exigem
`inventory.transfers.manage` no armazém de origem; receber, no de destino; aprovar/rejeitar, `inventory.transfers.approve`
na origem; aceitar e fechar perdas, no destino. **Entre entidades legais (intragrupo)** o fluxo é próprio: a
aprovação da origem não basta — o destino aceita — e a expedição exige a referência do documento comercial intragrupo;
os lançamentos levam a origem `INTERCOMPANY_TRANSFER` (o 8.10 trata-os como venda/compra intragrupo na contabilidade).
Quem pede numa entidade pode escolher como destino qualquer armazém activo aberto (ou visível) de outra, sem o
consultar; por isso o `postStock` com `checkAccess: false` só confirma que o armazém existe — a autorização de cada
passo é do módulo que chama. Número na aprovação, pela série `STOCK_TRANSFER` da entidade de origem.

## D-041 Requisições internas e reservas: pedido por departamento, aprovação que reserva, entrega por consumo e libertação (aceite)

Uma **requisição interna** pede stock de um armazém para o consumo de um **departamento** (obrigatório, da mesma
entidade legal do armazém; entre entidades usa-se uma transferência intragrupo), com **centro de custo** opcional (da
mesma entidade) e finalidade. Ciclo: rascunho → pedida → **aprovada**, que numera (série `STOCK_REQUISITION` da
entidade) e **reserva** as quantidades por `postStock` (o reservado baixa o disponível, não o físico; acima do
disponível é recusado e nada muda) → separada → **entregue** (consumo: sai do stock livre e consome a reserva, em uma
ou mais vezes, da localização que quem atende escolhe) → concluída; o que já não é preciso **liberta-se** com motivo;
**anular** só antes de qualquer entrega (liberta a reserva se já havia). Cada passo é um evento só de acréscimo com o
seu lançamento (origem `INTERNAL_REQUISITION` e o número), base do consumo por centro de custo no 8.11; as linhas não
mudam depois da reserva (gatilho).

**Permissões**: `inventory.requisitions.request` (no âmbito do departamento — com descendentes —, da filial ou da
entidade; com âmbito "próprio", qualquer departamento mas só as suas), `inventory.requisitions.approve` (no âmbito do
departamento; **quem pede não aprova**) e `inventory.requisitions.fulfil` (separar, entregar, libertar: no âmbito do
armazém, com acesso de operação). Cada membro vê as requisições que pode pedir/aprovar e as dos armazéns que atende.
As **reservas activas** listam-se por origem (requisições, transferências e, no 8.10, vendas) a partir dos
movimentos — coincidem sempre com a coluna "Reservado" dos saldos. Os ecrãs aceitam agora "basta uma destas
permissões" (`anyOf`) nas rotas e na navegação.

## D-042 Contagens físicas e ajustes: plano, snapshot, contagem cega e recontagem, diferenças justificadas e aprovação que ajusta (aceite)

Uma **contagem** é planeada para um armazém, com zona (inclui as posições abaixo) e categoria (inclui as
subcategorias) opcionais, e é **cega por omissão**. Ciclo: plano → **início**, que numera (série `STOCK_COUNT` da
entidade) e tira o **snapshot** do físico (livre + bloqueado + quarentena) de cada saldo no âmbito (máximo 2000 linhas)
→ **contagem** (por partes; cada quantidade registada fica num histórico só de acréscimo; artigos encontrados fora do
snapshot entram com o sistema actual) → **revisão**: diferença = contado − snapshot, cada diferença precisa de
**motivo** (lista fixa) e **justificação** escrita; quem aprova pode pedir **recontagem** de linhas (nova volta, o
snapshot dessas linhas passa a ser o sistema actual) → **aprovação**, que lança o ajuste por `postStock` (tipo
`ADJUSTMENT`, origem `STOCK_COUNT` com o número): sobras entram no livre, faltas saem do livre, depois da quarentena e
do bloqueado. Anular (com motivo) é possível até à aprovação e não mexe no stock.

**Movimentos durante a contagem não são bloqueados.** O ajuste é relativo ao snapshot: o que entrou ou saiu depois já
está no saldo e não é anulado; a revisão mostra "movido depois do snapshot" por linha para que quem aprova peça
recontagem quando a contagem e os movimentos se cruzaram. Se uma falta já não cabe no saldo actual, a aprovação é
recusada (`INSUFFICIENT_STOCK`) e nada muda. Duas contagens em curso não podem contar o mesmo saldo (`COUNT_OVERLAP`).

**Permissões e segregação**: `inventory.counts.manage` (planear, iniciar, contar, acrescentar, submeter; no âmbito do
armazém com acesso de operação) e `inventory.counts.approve` (rever, justificar, pedir recontagem, aprovar; no âmbito
do armazém). **Quem registou quantidades não aprova** (`SELF_APPROVAL`). Numa contagem cega, o sistema (snapshot,
diferença, movido depois) só é devolvido pela API a quem aprova, até à aprovação; numa aberta, a quem gere também (e
quem gere justifica). A contagem cega esconde o sistema **no ecrã e na API da contagem**; quem também tem acesso à
consulta de saldos continua a vê-los lá — a separação de perfis é uma decisão da empresa.

**Imutabilidade**: aprovada ou anulada, a contagem e as linhas ficam fixas (gatilho); o plano fica fixo depois do
início; registos de contagem e lançamentos de ajuste só de acréscimo; o ajuste corrige-se com uma nova contagem, não
editando a anterior.

## D-043 Lotes, séries e FEFO: o lote é dimensão do saldo, séries por unidade, saídas FEFO no motor, bloqueio e recolha (aceite)

O **lote** (`stock_lots`: código único por produto/variante, validade, fabrico, estado activo/bloqueado/recolhido)
passa a ser uma **dimensão dos movimentos e dos saldos** — só nos baldes físicos e em trânsito; reservado e previsto
continuam sem lote. A validade guarda-se no lote (um produto com validade tem de controlar lotes). Cada unidade de um
produto com séries tem uma linha em `stock_serials` (onde está: armazém, localização, lote, balde — ou fora do stock)
e um histórico só de acréscimo por lançamento. Com movimentos, o rastreio por lote/série do produto já não muda.

**Tudo no motor (`postStock`)**: as linhas aceitam `lotId`, `lotCode` (+ validade; o lote é criado nas entradas e
ajustes) e `serials`. Uma **saída sem lote** reparte-se em **FEFO** (validade mais próxima; sem validade no fim;
empate pela entrada do lote; stock sem lote anterior ao 8.8 por último) — nas saídas do livre (consumo, venda,
transferência) ignora lotes bloqueados, recolhidos e expirados, e um lote assim indicado explicitamente é recusado
(`LOT_BLOCKED`, `LOT_EXPIRED`); o abate (ajuste) e as mudanças de estado podem usá-los. As **séries** de uma saída são
as indicadas (têm de estar nesse lugar) ou as mais antigas ali. As **entradas do mesmo lançamento** sem lote/séries
(o outro lado de uma transferência ou de uma mudança de estado) recebem os que saíram — por isso transferências,
requisições, estornos e contagens funcionam sem mudanças e mantêm a rastreabilidade; uma entrada nova sem lote/séries é
recusada (`LOT_REQUIRED`, `SERIALS_REQUIRED`). Uma série não entra duas vezes em stock (`SERIAL_IN_STOCK`).

**Bloqueio e recolha** (`inventory.lots.manage` no âmbito de todos os armazéns com stock do lote): bloquear move o
livre do lote (em todos os armazéns) para bloqueado com um lançamento `STATUS_CHANGE` (deixa de ser disponível; recusa
se ficaria reservado acima do livre); desbloquear devolve o que o último bloqueio moveu; **recolher** é definitivo
(gatilho), bloqueia o livre e o lote não volta a receber no livre — o que está bloqueado sai por documento (devolução,
destruição). **Rastreabilidade**: o lote mostra de onde veio (entradas por origem), onde está (saldos por armazém e
estado), para onde foi (saídas definitivas por origem — a lista de uma recolha) e as séries; cada série mostra o seu
percurso. **FEFO/FIFO aqui é a ordem física de saída, não o método de valorização** (8.9).

Contagens (8.7) contam por lote; diferenças em produtos com séries regularizam-se por documento com as séries
(`SERIALS_REQUIRED`), porque o ajuste não sabe que unidades faltam ou sobram.

## D-044 Valorização: livro de custo só de acréscimo, médio/FIFO/específico por entidade legal, ajustes de custo e reconciliação (aceite)

O valor do stock vive num **livro de custo** (`stock_valuation_entries`, só de acréscimo) alimentado pelo próprio
lançamento de stock (`postStock`, na mesma transacção): por **entidade legal**, produto e variante (e lote no custo
específico), a variação da quantidade valorizada (livre, bloqueado, quarentena, trânsito) gera entradas de valor. Os
**saldos de custo** (`stock_cost_pools`) e o que resta de cada **camada** (`stock_cost_layers`) derivam do livro por
gatilho — escritas directas são recusadas — e a reconciliação interna confirma livro = saldos = camadas e quantidade
valorizada = stock físico. O que entra e sai na mesma entidade (transferência interna, mudança de estado) não mexe no
valor; entre entidades (intragrupo) o valor que sai da origem entra no destino.

**Métodos** (por produto; fixo depois de haver movimentos): **custo médio ponderado** (saída = parte proporcional do
saldo); **FIFO contabilístico** (camadas por ordem de entrada — independente do FEFO físico do 8.8); **custo
específico** por lote (exige lotes; a saída consome as camadas do lote que sai). **Entradas**: custo indicado (documento:
quantidade conferida × custo unitário), o valor que saiu no mesmo lançamento, o custo do documento original numa
**devolução** (`returnOfDocumentId`: devolução ao fornecedor sai ao custo da compra, primeiro das camadas dessa compra;
devolução de cliente entra ao custo a que saiu), o custo actual, ou zero (assinalado na reconciliação). **Estorno**:
as entradas do original ao contrário (a mesma camada, o mesmo valor), sem recalcular.

**Arredondamento**: aritmética em inteiros — quantidades 6 casas, valores em cêntimos, custo unitário 6 casas,
meio-para-cima; quem esvazia um saldo ou uma camada leva o valor que lá resta (nada se perde nem sobra). **Sem
retroeditar**: nada do passado é recalculado; correcções (preço definitivo, custos de aquisição) são **ajustes de custo**
sobre o stock que ainda existe (no médio ao saldo; no FIFO/específico à camada) — o que já saiu fica como saiu (a
diferença de custo das vendas é contabilizada no 8.10). O stock anterior ao 8.9 entrou no livro com valor zero.

**Reconciliação com a contabilidade**: cada classe contabilística (do produto ou da categoria) tem a sua conta do razão
por entidade; à data, o valor do livro por classe compara-se com o saldo lançado da conta (e descendentes). A
contabilização automática dos movimentos (Posting Engine) é do 8.10. Permissões `inventory.valuation.read|manage` no
âmbito da entidade legal.

## D-045 Integrações do inventário: eventos contabilísticos por lançamento e contratos idempotentes para Compras e Vendas (aceite)

**Contabilização.** Cada lançamento de stock com valor (e cada ajuste de custo) gera, na mesma transacção, um **evento
contabilístico** (`inventory_accounting_events`) por entidade legal e sentido, com o total e os montantes por classe
contabilística (`value` e `cls_<classe>` para todas as classes do tenant, a zero quando não se aplicam — as regras do
motor usam a chave da classe). O evento é enviado ao **Posting Engine** (6.3) com origem `INVENTORY` e chave
`inv:<chave>`; o nome do evento vem do tipo de movimento e da origem (`RECEIPT_PURCHASE`, `ISSUE_SALE`,
`ISSUE_CONSUMPTION`, `ADJUSTMENT_GAIN|LOSS`, `TRANSFER_IN|OUT_INTERCOMPANY`, `COST_ADJUSTMENT_UP|DOWN`, …); o estorno
envia `REV_<evento>` com os montantes do original. A requisição passa o centro de custo.

**Falhar sem bloquear.** O envio corre dentro de um savepoint: sem regra (ou com a regra inválida) o savepoint é
desfeito, o evento fica `FAILED` com o motivo e a operação de stock conclui-se. "Repetir falhados"
(`inventory.accounting.manage`) reenvia — o motor é idempotente pela chave, por isso repetir nunca duplica o
lançamento. O conteúdo do evento é fixo na base (gatilho) e um evento lançado não volta atrás. A reconciliação do 8.9
passa a fechar quando todas as regras existem.

**Compras e Vendas.** Os módulos ainda não existem nesta aplicação; o inventário publica os contratos (`index.ts`):
`receivePurchase`, `reserveForSale`, `releaseSaleReservation`, `deliverSale`, `returnFromSale` — e a mesma API HTTP
(`/inventory/integrations/*`, `inventory.integrations.post` no âmbito do armazém) para um sistema externo. Cada pedido
leva **chave de idempotência** e as **referências** (encomenda, documento, contraparte); fica registado
(`inventory_integration_events`, só acréscimo) com o hash do pedido — a repetição devolve o resultado original, a
mesma chave com outro pedido dá `IDEMPOTENCY_MISMATCH` (409). Um advisory lock por encomenda serializa pedidos
concorrentes. A reserva é da encomenda: a entrega consome-a, a libertação não passa do reservado (`OVER_RELEASE`) e a
devolução não passa do entregue (`OVER_RETURN`) e entra ao custo a que saiu (`returnOfPostingIds`). A recepção de
compra exige o custo unitário.

## D-046 Alertas e relatórios do inventário: calculados na hora, sem tabelas próprias, com valores só para quem vê a valorização (aceite)

Os alertas (ruptura, reposição, validade) e os relatórios (rotação, cobertura, movimentos, perdas, consumo por centro
de custo, inventário valorizado) **não guardam nada**: são consultas sobre os saldos, os movimentos e o livro de custo,
por isso nunca divergem do stock e não precisam de tarefa periódica nem de recalcular o passado.

- **Reposição e ruptura**: disponível (livre − reservado) contra o `min_stock` do produto, somando os armazéns do
  relatório. Ruptura = disponível ≤ 0; repor = disponível ≤ mínimo; "a caminho" = abaixo do mínimo mas o que está em
  trânsito/previsto repõe acima dele. A sugestão repõe até ao máximo (ou ao mínimo), descontando o que vem a caminho.
  Entram os produtos com saldo nesses armazéns e os que têm mínimo e nunca tiveram stock em lado nenhum — o que só
  existe noutros armazéns não é ruptura aqui.
- **Validade**: lotes com stock físico e validade até N dias (30 por omissão) ou já expirados; expirar no próprio dia
  ainda conta como válido (a regra do FEFO do 8.8).
- **Classe do movimento**: do tipo de lançamento, da origem (documento, requisição, integração, transferência) e do
  sentido. Cada lançamento conta pelo efeito líquido no stock valorizado de cada armazém (mudanças de estado dão zero);
  o **estorno entra na classe do original com o sinal contrário**, por isso anula-o em vez de aparecer como entrada.
- **Rotação** = consumo do período (vendas, consumo interno, amostras, outras saídas — sem perdas, devoluções a
  fornecedores, transferências ou ajustes) ÷ stock médio ((abertura + fecho) ÷ 2, reconstituídos a partir do saldo
  actual e dos movimentos). **Cobertura** = disponível ÷ consumo diário do período. Aritmética em inteiros.
- **Perdas**: quebras (documento com origem perda), perdas em trânsito e faltas de contagem; as sobras de contagem
  aparecem ao lado para o líquido. **Consumo por centro de custo**: o que as requisições internas entregaram.
- **Inventário valorizado**: soma do livro de custo até à data, por entidade legal (o valor vive na entidade, não no
  armazém), com totais por classe contabilística — bate com os saldos de custo do 8.9.

**Acesso**: quantidades pelos armazéns que o membro pode consultar (a regra dos saldos); um armazém que não vê dá 404.
Os **valores** só vêm quando o membro tem `inventory.valuation.read` em todas as entidades dos armazéns do relatório
(senão `null`, sem totais); o inventário valorizado exige essa permissão na entidade. Sem permissões novas.

## D-047 Terceiro reutilizável e fornecedor com homologação, documentos com validade e dados bancários protegidos (aceite)

**Terceiro (business partner).** A identidade de quem a empresa compra ou vende vive num módulo próprio (`partners`):
código, nome, pessoa colectiva/singular, NIF (único por país, validado só no formato), país, contactos (um principal) e
morada. Não tem rotas: os papéis de negócio (fornecedor agora, cliente no Prompt 10) usam o contrato de `index.ts` e
decidem a permissão. Um terceiro tem no máximo um papel de fornecedor; pode ser também cliente sem duplicar a ficha.
Ao criar um fornecedor com um NIF já registado, a API devolve `TAX_ID_TAKEN` com o terceiro existente e a interface
oferece reutilizá-lo.

**Fornecedor.** Tipo (bens, serviços, ambos), moeda, prazo e meio de pagamento, prazo de entrega, encomenda mínima,
incoterm. Estados: rascunho → em aprovação → homologado | recusado; homologado → suspenso; recusado e suspenso voltam
por um novo pedido. O NIF e o país de um fornecedor homologado ou em aprovação não mudam.

**Homologação.** A empresa configura tipos de documento (obrigatórios ou não) e critérios (obrigatórios ou não). O
pedido avalia todos os critérios activos (obrigatórios cumpridos; não cumprido exige justificação) e só é aceite com
cada documento obrigatório activo e válido hoje. Quem pede não decide (`SELF_APPROVAL`, também como restrição na base);
a decisão volta a verificar os documentos. O pedido guarda a avaliação e os documentos que o sustentavam e fica fixo
depois de decidido. A **validade da homologação deriva dos documentos**: quando um obrigatório caduca ou é desactivado,
o estado continua "homologado" (é história) mas `qualification.valid` passa a falso — o contrato `supplierStanding`
devolve `canOrder` só com as duas coisas, para as ordens do 9.5. Não há tarefa periódica: calcula-se na leitura.

**Documentos.** Número, emissão, validade e o ficheiro (um anexo do próprio fornecedor). O que foi entregue não se
edita: desactiva-se com motivo e entrega-se outro.

**Dados bancários protegidos.** Uma conta nova entra pendente e só fica activa com a aprovação de outra pessoa com
`procurement.suppliers.approve` (nunca quem a registou — também na base). O conteúdo nunca se altera (gatilho): para
mudar, regista-se outra e desactiva-se a antiga. Sem `procurement.suppliers.bank` o IBAN e o número vêm mascarados; a
auditoria e o histórico só guardam a forma mascarada. A validação do IBAN é a do 5.x (mod 97), sem confirmar a conta.

**Permissões** (âmbito da empresa; fornecedores são dados mestres partilhados pelas entidades): `.read`, `.manage`,
`.approve`, `.bank` e `procurement.settings`. Histórico só de acréscimo (`supplier_events`) e auditoria de cada acção.
Funcionalidade contratável `procurement`.

## D-048 Requisições de compra: aprovação em etapas por valor, segregada, e atendimento parcial por afectações (aceite)

**Cabeçalho e linhas.** O departamento dá a entidade legal, a filial e o centro de custo por omissão; prioridade,
necessidade, finalidade, referência de orçamento e moeda (por omissão a funcional da entidade). Cada linha é um produto
do catálogo (activo, não kit; unidade de compra por omissão) ou uma descrição livre, com quantidade (6 casas), preço
estimado (6 casas), taxa de imposto (0–100, 3 casas), entrega e fornecedor sugerido. Valores exactos em inteiros:
líquido e imposto arredondados ao cêntimo por linha (meio para cima); o total do cabeçalho é a soma e a base confere-o.

**Estados.** Rascunho (edita-se, substitui as linhas) → em aprovação (recebe o número da série `PURCHASE_REQUISITION`
da entidade e deixa de se alterar) → aprovada → parcialmente encomendada → encomendada. Recusada e anulada são finais
(uma recusa pode ser **copiada** para um rascunho novo); uma aprovada com resto pode ser **fechada** pelo comprador. A
base recusa alterar cabeçalho e linhas fora do rascunho (só as quantidades encomendadas/fechadas mudam).

**Aprovação por valor e âmbito.** A empresa define etapas (ordem, valor mínimo em moeda funcional, opcionalmente só
para uma entidade e exigindo um perfil). Ao pedir aprovação, o total é convertido pelo câmbio do dia (`NO_RATE` sem
ele) e ficam **fixadas** as etapas cujo mínimo atinge (sem nenhuma, uma etapa base). Cada etapa é decidida por ordem
por quem tem `procurement.requisitions.approve` no âmbito do departamento: nunca o solicitante (`SELF_APPROVAL`),
nunca a mesma pessoa em duas etapas (`SAME_APPROVER`) e, se a etapa o exige, com o perfil (`ROLE_REQUIRED`). A
decisão fica numa linha só de acréscimo única por etapa: duas decisões simultâneas — só uma entra.

**Atendimento parcial e consolidação.** Cotações e ordens (9.3/9.5) consomem quantidade das linhas pelo contrato
`allocateRequisition` (positivo consome, negativo devolve; idempotente por chave; nunca acima do aberto nem abaixo do
encomendado). O estado acompanha. O que volta a uma requisição fechada passa a fechado. As **necessidades
consolidadas** juntam o aberto das aprovadas por entidade, produto, variante, unidade e moeda (descrições livres à
parte), com a necessidade mais cedo, a prioridade mais alta e as origens — para `procurement.requisitions.process`
(entidade/filial). Orçamento (compromisso) é do 9.10: aqui só a referência.


## D-049 Pedidos de cotação: emissão numerada, envelope fechado, versões de proposta e revisões com motivo (aceite)

**Pedido.** Por entidade legal: título, especificações, prazo de resposta (data e hora), condições de entrega e
pagamento, moeda (por omissão a funcional) e envelope fechado (por omissão). Linhas de uma requisição aprovada da mesma
entidade com quantidade em aberto (traz produto, unidade, quantidade em aberto e necessidade; a quantidade pode
ajustar-se), do catálogo ou livres. O pedido **não consome** a requisição: a afectação (`allocateRequisition`) é feita
pela ordem de compra (9.5), para que várias cotações do mesmo artigo não bloqueiem quantidade.

**Estados.** Rascunho (edita-se; convidar e retirar convidados) → aberto (emitido: número da série `RFQ` da entidade,
`NO_SERIES` sem ela; prazo futuro; ≥ 1 linha e ≥ 1 convidado homologado com documentos em dia) → fechado (propostas
abertas) → adjudicado (9.4). Anulável com motivo até à adjudicação. A base recusa mudar número, entidade, moeda e
envelope depois do rascunho, alterar um anulado/adjudicado, apagar pedidos, e mudar linhas emitidas excepto
quantidade e especificações.

**Convidados e propostas.** Só fornecedores homologados (`supplierStanding.canOrder`, `NOT_QUALIFIED`). As propostas
são registadas pelo comprador (o portal do fornecedor é de um prompt posterior): moeda, validade, prazos de entrega e
pagamento, referência, anexo do pedido e linhas com oferta principal e até nove alternativas descritas (quantidade,
preço e imposto exactos; totais só das principais, ao cêntimo como nas requisições). Uma nova proposta do mesmo
fornecedor é uma **nova versão**; a anterior fica "substituída" e imutável (gatilho: só o estado muda, a partir de
"em vigor"; linhas só de acréscimo). Retirar e declinar exigem motivo. Depois do prazo: `QUOTE_LATE`.

**Confidencialidade.** Com envelope fechado e o pedido aberto, a API não devolve valores a ninguém (nem a quem
registou); a auditoria e a cronologia guardam só fornecedor e versão. A abertura (fecho do pedido) é possível depois
do prazo ou antes se todos os convidados já responderam ou declinaram (`EARLY_OPENING`), e fica registada (quem, quando).

**Revisões.** Um pedido aberto revê-se com motivo (prazo, especificações, condições, quantidade e especificações das
linhas): a revisão aumenta e as propostas feitas a uma revisão anterior ficam assinaladas como desactualizadas (não são
apagadas). Permissões `procurement.rfqs.read|manage` no âmbito da entidade legal; tudo auditado.

## D-050 Comparação e adjudicação: moeda normalizada à data da abertura, pontuação ponderada e aprovação segregada (aceite)

**Comparação.** Calculada na hora sobre as propostas em vigor de um pedido com as propostas abertas (fechado ou
adjudicado). Cada preço é convertido para a moeda funcional da entidade com o câmbio em vigor na **data da abertura**
(fixa — câmbios registados depois não mudam a comparação). Sem câmbio, a oferta aparece mas não é pontuada nem
adjudicável (`NO_RATE`). Mapa lado a lado por linha do pedido: cada oferta (principal e alternativas) com preço
original, preço e total na moeda de base, entrega e pontuação; por fornecedor: total da proposta convertido, prazos,
validade, linhas cotadas e em quantas é a melhor.

**Pontuação.** Por linha, entre as ofertas pontuáveis, em centésimos inteiros: preço = mais baixo/este; entrega = (mais
curto+1)/(este+1) (sem prazo, 0); pagamento = (este+1)/(mais longo+1) (mais longo é melhor; sem prazo, 0); qualidade =
nota dada ao fornecedor (0–100; obrigatória para todos se o critério pesa). Total = Σ peso × pontuação / 100, com pesos
inteiros (0–100) que **somam 100** (`WEIGHTS_SUM`; por omissão 60/20/20/0). A melhor da linha é a de total mais alto
(empate: preço mais baixo, depois a principal). A nota de qualidade é manual até à avaliação de fornecedores (9.11).

**Adjudicação.** Por linha e fornecedor: escolhe-se a oferta (principal ou alternativa) e a quantidade (até à oferecida
e, somada por linha, até à pedida — pode dividir-se uma linha); escolher uma oferta que não é a melhor exige motivo
(`NOT_BEST`); propostas caducadas não se adjudicam. Justificação obrigatória. Grava a fotografia dos valores (preço,
câmbio, valores na moeda de base, pontuação) e os totais. Uma só adjudicação viva por pedido (índice único parcial).

**Aprovação.** Rascunho → em aprovação (refaz a validação e fixa a fotografia) → aprovada (o pedido fica adjudicado)
ou recusada com motivo (pode preparar-se outra); anulável com motivo antes da decisão. Decide quem tem
`procurement.rfqs.approve` na entidade e **não** submeteu (`SELF_APPROVAL`; `CHECK` na base). Aprovar exige as
propostas ainda válidas (`QUOTE_EXPIRED`). Depois de submetida, a base recusa mudar cabeçalho, notas e linhas;
aprovada ou recusada, nada muda. Um pedido com adjudicação em curso não se anula (`AWARD_IN_PROGRESS`). Aprovação
numa etapa (sem níveis por valor) — as ordens de compra (9.5) consomem as linhas aprovadas.

## D-051 Ordens de compra: três estados independentes, aprovação por rondas, emissão numerada e revisões (aceite)

**Cabeçalho e linhas.** Fornecedor homologado (`supplierStanding.canOrder`, verificado ao criar, ao pedir aprovação e
ao emitir), entidade legal (fixa), filial, centro de custo e armazém de entrega da mesma entidade (o armazém é
obrigatório quando há produtos armazenáveis — a recepção do 9.7 dá entrada nele), adjudicação de origem, moeda (por
omissão a do fornecedor), datas, prazo e meio de pagamento, incoterm, condições e morada de entrega, referência do
fornecedor. Linhas de requisição aprovada da mesma entidade (até ao aberto), do catálogo (não kit) ou livres;
bruto = quantidade × preço, desconto, líquido, imposto e total exactos ao cêntimo (meio para cima), conferidos por
`CHECK`. O **contrato** (9.6) ainda não existe: a coluna entra com o 9.6, sem estado provisório.

**Estados independentes.** Aprovação (rascunho → em aprovação → aprovada | recusada, que volta a editar-se; anulada é
final), recepção (por receber → recebida em parte → recebida, pelas quantidades recebidas + canceladas — escrita pelo
9.7) e facturação (por facturar → em parte → facturada — pelo 9.8). Emissão à parte: revisão emitida, data e quem.

**Aprovação.** As mesmas etapas das requisições, fixadas pelo total em moeda funcional ao câmbio do dia em que se
pede (`NO_RATE`); quem pediu não decide, a mesma pessoa não decide duas etapas, a etapa pode exigir perfil. Cada pedido
de aprovação é uma **ronda** (as decisões ficam por ronda e etapa, únicas e só de acréscimo): uma recusa seguida de
nova submissão começa as etapas de novo.

**Emissão com numeração segura.** Só aprovada; a primeira emissão reserva o número da série `PURCHASE_ORDER` da
entidade (filial primeiro, sem buracos, com a ordem bloqueada); as seguintes mantêm-no. Na emissão a quantidade das
linhas de requisição é afectada pelo contrato `allocateRequisition` (diferença entre o encomendado em vigor e o já
afectado, idempotente por linha e revisão). Anular (sem recepções nem facturas) devolve tudo; fechar o resto
(parcialmente recebida) passa o que falta a cancelado e devolve-o às requisições.

**Revisões.** Uma ordem emitida revê-se com motivo: a versão emitida fica guardada (fotografia só de acréscimo), a
ordem volta a rascunho na revisão seguinte e precisa de nova aprovação e nova emissão; nunca se baixa uma linha do
recebido ou facturado, nem se muda o produto de uma linha com recepções. A base recusa mudar número, série, entidade,
fornecedor e moeda depois de emitida, mudar conteúdo fora do rascunho/recusa, apagar ordens e apagar linhas com
movimento. Permissões `procurement.orders.read|manage|approve` por entidade legal.

## D-052 Contratos de fornecedor: aprovação segregada, adendas aplicadas só depois de aprovadas e consumo controlado (aceite)

**Contrato.** Fornecedor homologado, entidade legal, objecto, vigência (início e fim), valor máximo **líquido** (sem
impostos) na moeda do contrato, prazo de pagamento, renovação (automática prevista ou não, período em meses, dias de
aviso), tabela de preços (produto/variante uma vez, ou descrição; preço unitário líquido) e níveis de serviço
(prazo de entrega, taxa de satisfação, conformidade, tempo de resposta ou outro descrito; objectivo e penalização). A
medição dos SLA é da avaliação de fornecedores (9.11).

**Estados.** Rascunho → em aprovação → activo (número da série `PURCHASE_CONTRACT` dado na aprovação; decide quem tem
`procurement.contracts.approve` na entidade e não submeteu, também por `CHECK`); recusado volta a editar-se; activo ↔
suspenso (motivo); terminado (motivo) e anulado (antes de aprovado) finais. O estado efectivo deriva das datas: "por
iniciar" e "caducado" (sem agendador); "a renovar" quando o fim cai dentro do aviso.

**Adendas e renovações.** Depois de aprovado, o contrato só muda por adenda: propõe-se o cabeçalho inteiro e, se
mudarem, a nova tabela de preços e os novos SLA, com motivo e data de efeito; uma pendente de cada vez (índice único
parcial); outra pessoa aprova e só então se aplica, guardando o anterior na adenda. A renovação é uma adenda que
estende o fim (por omissão, fim + meses de renovação). O máximo nunca baixa do consumido (`BELOW_CONSUMED`). A base
recusa alterar o contrato, os preços e os SLA fora do rascunho excepto quando a transacção aplica uma adenda aprovada
(`app.contract_amendment` com o id do contrato), e recusa mudar número/entidade/fornecedor/moeda depois de numerado.

**Consumo controlado.** Uma ordem de compra pode referir um contrato (fixo depois de emitida): mesma entidade,
fornecedor e moeda, data da ordem dentro da vigência, contrato activo; o preço de um produto da tabela não pode passar
o do contrato (`PRICE_ABOVE_CONTRACT`). Ao pedir aprovação verifica-se o saldo; na **emissão**, com o contrato
bloqueado, consome-se a diferença entre o valor líquido em vigor da ordem (líquido × (quantidade − cancelada) /
quantidade) e o já consumido por ela, nunca acima do máximo (`CONTRACT_EXCEEDED`; também `CHECK` na base) e só com o
contrato efectivamente activo. Fechar o resto e anular devolvem; um contrato terminado aceita devoluções mas não
consumo novo. Os movimentos são idempotentes por chave e só de acréscimo.

## D-053 Recepções de compra: conferência, entrada única no Inventário, aceitação de serviços e estorno (aceite)

**Recepção.** De uma ordem aprovada e emitida na revisão em vigor (não fechada; uma revisão em curso suspende as
recepções), com data (não futura), guia do fornecedor e, por linha em falta: quantidade aceite (na unidade da ordem),
recusada com motivo (fica registada, não entra nem conta como recebida — base da não conformidade do 9.9), lote,
validade, séries e localização nos bens armazenáveis. Rascunho editável e anulável com motivo.

**Confirmação.** Com a ordem bloqueada (recepções simultâneas esperam umas pelas outras) volta a verificar o que falta
receber (`OVER_RECEIPT`), dá o número da série `PURCHASE_RECEIPT` e faz **um único** pedido ao Inventário
(`receivePurchase`, chave `pr-<recepção>`: repetir não duplica o movimento) com todos os bens armazenáveis, na unidade
base do produto (quantidade × factor da unidade de compra; sem conversão → `NO_CONVERSION`) e ao **custo de entrada**:
líquido da linha da ordem ÷ quantidade encomendada (desconto incluído, imposto excluído) × câmbio fixado na ordem ÷
factor, na moeda funcional. Serviços e artigos não armazenáveis (ou ordens sem armazém) ficam só aceites, sem stock.
Actualiza as quantidades recebidas e o estado de recepção da ordem. Uma recepção confirmada não se confirma de novo.

**Correcção.** Confirmada, a recepção e as linhas não mudam (gatilho); corrige-se por **estorno** com motivo: estorna o
lançamento de stock (`reverseStockPosting`, idempotente; um estorno não se estorna) e devolve as quantidades à ordem —
recusado se a linha já foi facturada abaixo do que ficaria (`RECEIPT_INVOICED`; aí corrige-se por devolução, 9.9) ou se
a ordem foi fechada. Permissões `procurement.receipts.read|manage` por entidade legal. As **entregas previstas** são
calculadas na hora (linhas emitidas com quantidade em falta, pela data prevista da linha ou da ordem: atrasada, hoje,
prevista, sem data).

## D-054 Facturas de fornecedor: conferência a três, tolerâncias e excepções autorizadas (aceite)

**Registo.** A factura do fornecedor parte de uma ordem aprovada e emitida (entidade, fornecedor e moeda vêm da ordem;
outra moeda → `CURRENCY_MISMATCH`), com número externo, data (não futura), total declarado e vencimento (data + prazo
de pagamento do fornecedor, alterável). O número externo é único por fornecedor, comparado em maiúsculas e sem espaços,
excluindo as anuladas (índice parcial na base e verificação antes de tudo o resto: `DUPLICATE_INVOICE` com a factura
existente). Linhas ligadas a uma linha da ordem (uma vez cada) ou encargos sem linha, com preço, desconto e imposto
exactos; totais conferidos pela base.

**Conferência a três** (ordem, recepção/aceitação, factura), na unidade da ordem e com a ordem bloqueada:
`QTY_OVER_RECEIVED` (já facturado + quantidade > recebido × (1 + tolerância)), `PRICE_OVER_ORDER` (preço líquido
unitário acima do da ordem para lá da tolerância em percentagem **ou** em valor da linha), `TAX_MISMATCH`,
`UNMATCHED_LINE` (encargo) e `TOTAL_MISMATCH` (|declarado − soma| acima da tolerância de total). Preço ou quantidade
abaixo não são divergências. As tolerâncias são da empresa (`procurement.settings`), zero por omissão.

**Validação.** Sem divergências, validar finaliza; com divergências a factura fica com **excepção pendente** e o
conteúdo fixo (gatilho). Outra pessoa (`procurement.invoices.approve`; `CHECK` de segregação na base) autoriza ou
recusa com motivo; ao decidir a conferência corre de novo e, se as divergências mudaram (outra factura ou um estorno
entretanto), a decisão é recusada (`DIVERGENCES_CHANGED`). Recusada a excepção, volta a rascunho. Finalizar fixa o
câmbio da data da factura na moeda funcional (`NO_RATE` se não houver), dá o número da série `PURCHASE_INVOICE`, soma
as quantidades facturadas às linhas da ordem e actualiza o estado de facturação. Validada, recusada (devolvida ao
fornecedor) e anulada são finais e imutáveis; uma validada corrige-se por nota de crédito (9.9). A obrigação a pagar e
a contabilização são do 9.10 (aqui não se cria nada no Finance nem no razão).

## D-055 Devoluções a fornecedor, não conformidades e notas de crédito (aceite)

**Não conformidade / devolução.** Parte de uma recepção confirmada: data (não futura), motivo (qualidade, danificado,
artigo errado, fora de validade, quantidade a mais, documentação, outro), descrição, solução pedida e, por linha da
recepção, o que volta: do **aceite** (estava em stock; sai pelo Inventário com o lote da recepção, as séries recebidas
escolhidas, a localização e o estado de stock — livre, bloqueado ou quarentena) ou do **recusado** na conferência
(nunca entrou: só fica registado). O disponível é o aceite/recusado menos as outras devoluções não anuladas (os
rascunhos também reservam). **Evidência obrigatória**: confirma-se só com pelo menos um anexo, e os anexos só se juntam
ou retiram em rascunho.

**Confirmação.** Com a ordem bloqueada volta a verificar o disponível, dá o número da série `PURCHASE_RETURN` e faz
**uma** saída no Inventário (contrato novo `returnToSupplier`, evento `PURCHASE_RETURN`, chave `prt-<devolução>`:
repetir não duplica), valorizada primeiro pelas camadas/custo da recepção de origem (`returnOfDocumentRef`); o evento
contabilístico é `ISSUE_PURCHASE_RETURN` (as contas vêm das regras da empresa). Na ordem, o aceite devolvido deixa de
contar como recebido. **Substituição**: a ordem volta a esperar a quantidade (recusada se a ordem estiver fechada:
`ORDER_CLOSED`). **Crédito**: deixa de a esperar (cancelada até ao que falta receber) e o que já estava facturado acima
do novo recebido fica **por creditar** na linha. Confirmada, a devolução não muda (só o creditado e o estado do
crédito, pela nota de crédito); uma recepção com devoluções já não se estorna (`RECEIPT_RETURNED`).

**Nota de crédito.** Do fornecedor, sobre uma factura validada (opcionalmente ligada a uma devolução): número externo
único por fornecedor (maiúsculas, sem espaços, fora as anuladas; verificado antes de tudo — `DUPLICATE_CREDIT_NOTE`),
data entre a da factura e hoje, motivo, total declarado (tem de bater com o calculado dentro da tolerância de total) e,
por linha da factura, **quantidade devolvida** ao preço líquido da factura (só em linhas da ordem) e/ou **ajuste de
valor**; imposto à taxa da linha; a última que fecha a linha leva o resto exacto (sem cêntimos perdidos). Nunca acima do
facturado por creditar (`OVER_INVOICED`) nem do pendente da devolução (`OVER_PENDING`). A validação, com a factura e a
ordem bloqueadas, recalcula com o que já foi creditado no momento, dá o número da série `PURCHASE_CREDIT_NOTE`, fica ao
**câmbio da factura**, abate a quantidade facturada da ordem e o pendente da devolução (estado: sem crédito a receber,
pendente, creditada). Validada é imutável. A obrigação a pagar (factura − notas de crédito), o pagamento e a
contabilização são do 9.10.

## D-056 Compras ↔ orçamento, obrigação a pagar e contabilidade: compromisso sem duplo bloqueio, obrigação única, sem duplicar o inventário (aceite)

**Compromisso por centro de custo.** Um livro só de acréscimo (`procurement_commitments`) por centro de custo e ano, em
moeda funcional e líquido de imposto. Cada requisição e ordem grava só a **diferença** para o seu valor em aberto actual
(sincronização idempotente), por isso a soma é sempre o estado: requisição aprovada = líquido × (quantidade − encomendada
− fechada) ÷ quantidade, ao câmbio da requisição; ordem aprovada e emitida = líquido × (quantidade − cancelada −
facturada) ÷ quantidade, ao câmbio da ordem (em revisão fica o da versão emitida). A ordem tira à requisição o que
encomenda e a factura tira à ordem o que factura: **a mesma verba nunca fica bloqueada duas vezes**. Realizado = facturas
validadas − notas de crédito (líquido, ao câmbio da factura), no centro de custo da ordem. Documentos sem centro de custo
não comprometem. Recalcula-se na aprovação final, fecho e anulação da requisição, nas afectações, na emissão, fecho e
anulação da ordem, na validação de facturas e notas de crédito e na confirmação de devoluções.

**Verba.** `procurement_budgets` por centro de custo e ano (`procurement.budgets.manage`), com controlo BLOCK (a aprovação
final da requisição ou a emissão da ordem que aumente o comprometido para lá da verba é recusada, `BUDGET_EXCEEDED`, e a
transacção desfaz-se) ou WARN (passa; o disponível fica negativo e assinalado). Concorrência: bloqueio por centro de
custo/ano. Sem verba, o compromisso regista-se mas nada é bloqueado. É uma verba de compras, não o orçamento geral da
empresa (que, quando existir, usa este livro como contrato).

**Obrigação a pagar.** Exactamente uma por factura validada (`procurement_payables`, índice único), na moeda e ao câmbio
da factura, com vencimento da factura; abatida pelas notas de crédito validadas. Como ainda não há módulo de
Finanças/Tesouraria (Prompt 11), os **pagamentos** registam-se aqui, como no salário (D-032), com a permissão própria
`procurement.payables.pay`: nunca acima do saldo, data não futura nem anterior à factura, referência, conta bancária
activa da entidade na moeda da factura, câmbio da data do pagamento; só de acréscimo. O contrato `procurementPayables`
publica as obrigações com saldo para esse módulo.

**Contabilidade sem duplicar o inventário.** Eventos ao motor (origem `PROCUREMENT`), guardados e enviados num savepoint:
sem regra ou com erro ficam FALHADOS com o motivo e repetem-se sem bloquear o documento; cada um é idempotente pela chave.
A recepção de bens armazenáveis já lançou o stock contra a conta de recepções por facturar (regra da empresa para
`INVENTORY/RECEIPT_PURCHASE`); a factura (`INVOICE`) **salda essa conta** pelo valor a que os bens entraram
(`goodsReceived`, ao câmbio da ordem) e lança só a diferença de preço/câmbio (`priceVarianceUp|Down`), os serviços e
artigos sem stock (`services`), o imposto (`tax`) e o fornecedor (`payable`, = soma, equilibrado ao cêntimo). A nota de
crédito (`CREDIT_NOTE`) usa as mesmas chaves (a quantidade devolvida volta pelas recepções por facturar; o ajuste de valor
num bem em stock é diferença de preço). O pagamento (`PAYMENT`): `payable` ao câmbio da factura, `bank` ao do pagamento,
`fxLoss|fxGain`. As Compras nunca debitam stock.

## D-057 Avaliação de fornecedores: indicadores das provas, pesos da empresa, publicação imutável (aceite)

**Indicadores calculados das provas do período** (nunca introduzidos à mão), em pontos de 0 a 100:
- **qualidade** — por linha de recepção confirmada, (aceite − devolvido do aceite) ÷ (aceite + recusado); média das
  linhas, cada linha conta igual, para não misturar unidades;
- **prazo** — linhas recebidas até à data prevista (da linha ou da ordem) ÷ linhas com data;
- **conformidade** — facturas validadas sem excepção ÷ (validadas + devolvidas ao fornecedor);
- **custo** — por linha de pedido de cotação aberto no período, o menor preço proposto na mesma moeda ÷ o preço do
  fornecedor; média das linhas.

**Nota e classe.** A nota é a média ponderada pelos pesos da empresa (inteiros que somam 100, `procurement.settings`;
por omissão 30/30/20/20). Um critério sem provas (ou com peso 0) não conta e os pesos dos outros reescalam-se; sem
provas nenhumas não há nota. Classes: A ≥ 85, B ≥ 70, C ≥ 50, D abaixo.

**Mapa e provas.** `procurement.evaluations.read` vê o mapa e as provas só das entidades do âmbito: recepções
atrasadas, com recusa ou devolução, facturas com excepção, cotações em que o fornecedor foi o mais barato, e o
cumprimento dos SLA dos contratos que se medem automaticamente:
- prazo — média de dias da emissão à recepção ≤ alvo;
- taxa de entrega — recebido ÷ encomendado ≥ alvo;
- taxa de qualidade — o indicador de qualidade ≥ alvo.

**Publicação.** Exige `procurement.evaluations.manage` no âmbito da empresa (o fornecedor é da empresa toda) e recalcula
com as provas de todas as entidades. Guarda a fotografia — pesos, indicadores com número de provas, nota, classe e
comentário — que a base de dados não deixa alterar nem apagar. Uma nova publicação do mesmo período substitui a
anterior, que fica no histórico. A ficha do fornecedor mostra a avaliação em vigor.

## D-058 Unicidade verificada na aplicação e garantida na base: a corrida devolve 409, nunca 500 (aceite)

Onde um número ou chave tem de ser único (número externo de facturas e notas de crédito por fornecedor, verba por
centro de custo e ano, códigos), o serviço verifica primeiro, para dar uma resposta clara. É o **índice único da base**
que garante a regra quando dois pedidos passam a verificação ao mesmo tempo, e esse erro (`23505`, pela restrição) é
convertido no mesmo 409 da verificação (`DUPLICATE_INVOICE`, `DUPLICATE_CREDIT_NOTE`, `BUDGET_EXISTS`, …). Onde a
transição pode bloquear o documento-pai, bloqueia-o (`FOR UPDATE` ou advisory lock) e a corrida resolve-se por ordem.
O QA do Prompt 09 (9.12) encontrou duas operações sem a conversão (notas de crédito e verbas: o segundo pedido
simultâneo dava 500) e passou a testá-las com pedidos em paralelo.


## D-059 Cliente como papel do terceiro, com versões imutáveis dos dados usados nos documentos (aceite)

O cliente (`customers`, módulo `sales`) é o **papel de venda** de um terceiro (`business_partners`, módulo `partners`),
como o fornecedor é o papel de compra (D-047): um terceiro por NIF e país, no máximo um cliente por terceiro, e o
mesmo terceiro pode ser fornecedor e cliente sem duplicar a ficha. Ao criar, o NIF de um terceiro existente dá
`TAX_ID_TAKEN` com o terceiro, e o ecrã oferece "tornar este terceiro cliente". O cliente nunca se apaga nem muda de
terceiro (gatilho na base): os documentos de venda vão referi-lo.

**Condições e crédito.** Moeda, prazo (0–365 dias), segmento e notas são de `sales.customers.manage`. O limite de crédito
(`numeric`, vazio = sem limite) é de `sales.customers.credit`, com motivo, e fica no histórico; a edição geral recusa-o.
Bloquear e inactivar exigem motivo (`CHECK` na base); um cliente bloqueado não recebe documentos novos (regra aplicada
pelos blocos 10.3 a 10.7).

**Versões.** A identidade fiscal e a morada de facturação usadas nos documentos (código, nome, tipo, NIF, país, e-mail,
morada de facturação por omissão ou a do terceiro) ficam em `customer_versions`, só de acréscimo (gatilho). Cada
alteração que muda a impressão digital (sha256 dos dados) cria a versão seguinte, sob advisory lock por cliente; os
documentos de venda guardarão a versão que usaram (`customerSnapshot`), e uma correcção posterior do cliente não altera
documentos emitidos. Alterar só condições comerciais não cria versão.

**Fiscal.** Este bloco não configura nada fiscal: códigos de isenção, regimes e requisitos da AGT (Decreto Presidencial
n.º 71/25 e regulamentação) ficam para os blocos 10.5 e 10.9, depois de verificados nas fontes oficiais.

## D-060 Preços e descontos: tabelas aprovadas e imutáveis, uma regra por linha e limite do desconto manual (aceite)

**Tabelas.** Uma tabela de preços (`price_lists`) é geral, de um segmento ou de um cliente, numa moeda, de uma entidade
legal (ou de todas), num período, com prioridade (0–1000). Tem preços por produto (ou variante) e escalão de quantidade
mínima, na unidade base e sem impostos, com 4 casas (`numeric`). Prepara-se em rascunho (`sales.prices.manage`), é
submetida e só fica activa com a aprovação de **outra pessoa** (`sales.prices.approve`; `CHECK` na base). Activa, a
tabela e as suas linhas não mudam nem se apagam (gatilhos): para mudar preços copia-se para um rascunho novo e
inactiva-se a antiga com motivo. Assim, o preço que um documento guardou continua explicável pela tabela de onde veio.
Duas tabelas activas com o mesmo destino, moeda, entidade e prioridade não podem ter períodos sobrepostos: a aprovação
recusa-o (`OVERLAP`) sob advisory lock, para que a prioridade decida sempre.

**Resolução.** Ganha a tabela mais específica (cliente > segmento > geral), depois a de maior prioridade, depois a que
começou mais tarde; dentro dela, a linha da variante antes da do produto e o maior escalão atingido. Sem tabela, vale o
preço de venda do catálogo, se estiver na mesma moeda. Sem nenhum, o preço é manual e exige aprovação; sem preço manual,
a linha fica `NO_PRICE`. Não há conversão de moeda nos preços.

**Descontos automáticos.** As regras (`discount_rules`) dão uma percentagem a todos, a um segmento ou a um cliente, num
produto, numa categoria (incluindo as subcategorias) ou em tudo, a partir de uma quantidade, num período. Têm o mesmo
ciclo de aprovação. Numa linha aplica-se **uma só** regra (não acumulam): a de maior prioridade, depois a do destino e
do âmbito mais específicos.

**Desconto manual.** Aplica-se sobre o preço já com a regra. O limite sem aprovação (`discount_limits`, definido por quem
aprova preços) é o do cliente, senão o do segmento, senão o geral; **sem nenhum, é 0 %** (qualquer desconto manual pede
aprovação). O limite da linha da tabela, quando menor, prevalece. O desconto da regra não conta para o limite, porque a
regra já foi aprovada. Um preço manual abaixo do preço com a regra conta como desconto, com a percentagem implícita
arredondada para cima. Acima do limite, `requiresApproval`; a aprovação em si acontece nos documentos (10.3+).

**Snapshot.** `resolvePrices` (contrato do módulo) não grava nada. Devolve por linha a origem (tabela, linha e escalão,
ou catálogo, ou manual), o preço base, a regra e a percentagem, o desconto manual, o limite e a sua origem, o preço
líquido (4 casas, arredondado a metade para cima), o valor (2 casas) e os motivos de aprovação. Devolve ainda uma
impressão digital sha256 do conjunto, igual para o mesmo pedido com os mesmos dados. Os documentos de venda guardam este
snapshot nas linhas.

Ficam para depois:
- limites de desconto por vendedor ou perfil;
- preços noutra unidade que não a base;
- promoções que acumulam.

## D-061 Orçamentos: aprovação só por excepção, envio numerado com versão fotografada e conversão única (aceite)

**Âmbito.** Os orçamentos são da entidade legal. `sales.quotes.read|manage|approve` valem no âmbito da empresa, de uma
entidade legal ou só para os próprios (âmbito OWN: os orçamentos de que a pessoa é o comercial). Um comercial OWN não
cria orçamentos para outro comercial. Um orçamento fora do âmbito responde 404.

**Preços e imposto.** As linhas pedem o produto (ou variante), a quantidade e, se houver, um desconto ou preço manual.
O preço vem sempre do motor do 10.2 (`resolvePrices`), à data do orçamento. É recalculado a cada gravação do rascunho
e na submissão, e o snapshot fica em cada linha. Até ao motor fiscal (10.5), o imposto é uma taxa por linha (0–100 %):
a 0 % exige o motivo da isenção em texto, sem códigos inventados. O imposto arredonda a 2 casas por linha e os totais
somam as linhas (`CHECK` total = líquido + imposto).

**Aprovação.** Submeter sem nenhuma linha acima do limite de desconto e sem preço manual aprova logo (a política de
limites já foi aprovada). Com elas, o orçamento aguarda `sales.quotes.approve` de **outra pessoa**
(`SELF_APPROVAL`; `CHECK` na base). Devolver exige motivo e volta a rascunho. Um cliente bloqueado ou inactivo impede
criar, submeter e enviar (`CUSTOMER_BLOCKED`). Linhas sem preço impedem a submissão (`NO_PRICE`).

**Envio e versões.** O primeiro envio atribui o número pela série `SALES_QUOTE` da entidade. Com várias séries
activas, a escolha é explícita (`SERIES_REQUIRED`), nunca "a primeira". Cada versão enviada fica fotografada em
`sales_quote_versions`, só de acréscimo, com impressão digital: cabeçalho, versão imutável dos dados do cliente
(`customerSnapshot`), linhas com o snapshot de preço e totais. O envio é **registado** (canal e destinatário); o envio
automático por e-mail com PDF fica para o 10.13. Rever (de aprovado, enviado ou recusado) exige motivo e volta a
rascunho com a versão seguinte, mantendo o número. A aceitação ou recusa do cliente refere-se à versão enviada em vigor
(`VERSION_MISMATCH`), e a aceitação só é possível dentro da validade (`EXPIRED`). "Expirado" é calculado na leitura,
não guardado.

**Imutabilidade.** Fora do rascunho, a base recusa alterar o conteúdo do cabeçalho, mexer nas linhas e mudar o número
ou a série. Recusa também reabrir um anulado ou convertido, sair de aceite a não ser para convertido, e apagar.

**Conversão.** A conversão única é um contrato para as encomendas (10.4). `acceptedQuote` devolve o orçamento aceite,
a versão do cliente e a impressão digital da versão aceite. `markQuoteConverted` faz a passagem a convertido com
`UPDATE … WHERE status = 'ACCEPTED' AND converted_order_id IS NULL`, e o índice único em `converted_order_id` garante
uma encomenda por orçamento. Duas conversões simultâneas: uma passa, a outra recebe `ALREADY_CONVERTED`. O botão
"Converter em encomenda" chega com o 10.4: não há encomenda provisória.

## D-062 Encomendas de venda: estados separados, crédito na confirmação e stock só pelos contratos do Inventário (aceite)

**Estados.** Uma encomenda tem cinco estados independentes:
- ciclo: rascunho, confirmada, fechada ou anulada;
- aprovação: não exigida, pendente, aprovada ou devolvida;
- reserva: nenhuma, parcial, total ou não aplicável (só serviços);
- entrega: nenhuma, parcial ou total;
- facturação: nenhuma, parcial ou total.

Reserva, entrega e facturação derivam das quantidades das linhas (encomendada, reservada em aberto, entregue,
facturada e fechada sem entrega), com `encomendada ≥ reservada + entregue + fechada` garantido por `CHECK`. A
facturação é actualizada pelo 10.6; até lá fica "por facturar".

**Confirmação.** Submeter recalcula os preços pelo motor do 10.2, excepto numa encomenda vinda de orçamento, que mantém
os preços aceites. Verifica também o limite de crédito do cliente:

- Exposição = valor por facturar das outras encomendas confirmadas + esta. O valor por facturar é o total da linha ×
  (encomendada − facturada − fechada) / encomendada. Tudo convertido para a moeda do cliente pelo câmbio da data.
- Sem câmbio, a encomenda pede aprovação (`NO_RATE`).
- As contas a receber entram na exposição quando existirem Finanças (10.10).

Sem excepções (preço, crédito ou câmbio), a encomenda fica confirmada logo, com número da série `SALES_ORDER`. Com
várias séries activas, a escolha é explícita. A encomenda fica também ligada à versão imutável dos dados do cliente.
Com excepções, aguarda `sales.orders.approve` de **outra pessoa** e mostra os motivos e o cálculo do crédito. Cliente
bloqueado ou inactivo impede submeter, aprovar e expedir.

**Stock.** A encomenda nunca escreve stock: chama os contratos idempotentes do Inventário com o número como referência
e chaves derivadas da encomenda.
- **Reservar:** `reserveForSale`. Recusa acima do livre (`OVER_RESERVED`).
- **Libertar:** `releaseSaleReservation`.
- **Expedir:** `deliverSale`. Consome a reserva da encomenda e sai por FEFO.

Os serviços não passam pelo inventário: a expedição dá-os por prestados. Cada expedição é idempotente pela chave do
pedido (`IDEMPOTENCY_MISMATCH` com outro conteúdo). Fica só de acréscimo, com referência interna `número/En` e o
evento do Inventário; não é um documento fiscal de transporte. Expedições simultâneas são ordenadas pelo bloqueio da
encomenda: o excesso dá `OVER_DELIVERY`. Kits ainda não se vendem (`KIT_NOT_SUPPORTED`).

**Fecho e anulação.** Fechar o resto exige motivo e entregas: liberta as reservas e fecha o que falta. Anular só é
possível em rascunho ou numa confirmada sem entregas, e também liberta as reservas. O orçamento de origem continua
convertido. A base protege preços e produtos depois do rascunho, a numeração, os estados finais e as expedições.

**Conversão.** `POST /sales/orders/from-quote` exige `sales.orders.manage` no âmbito do orçamento. Chama o contrato do
10.3 na mesma transacção: com duas conversões simultâneas, uma dá 201 e a outra 409 (`ALREADY_CONVERTED`). A encomenda
herda cliente, condições, linhas e preços, que não se alteram (`LINES_FROM_QUOTE`).

## D-063 Motor fiscal configurável sem valores pré-carregados; séries fiscais só em simulação (aceite)

**Verificação das fontes (24/11/2026).** Confirmei por fontes secundárias (EY, PwC, Cegid, Afriwise, Abreu Advogados):
- o Decreto Presidencial n.º 71/25, de 20 de Março (regime jurídico das facturas), que substitui o regime anterior e
  torna obrigatória a facturação electrónica por software validado pela AGT;
- o Decreto Executivo n.º 683/25 (estrutura de dados e modelo da facturação electrónica);
- a exigência de comunicar as séries à AGT e de prever um regime de contingência.

**Não obtive** o texto oficial no Diário da República nem a especificação técnica da AGT (estrutura, assinatura, hash,
QR, códigos de isenção, validação de séries). As fontes secundárias divergem nas datas de entrada em vigor. Por isso:
- **Nenhuma taxa, isenção, retenção, código de documento ou regra de arredondamento vem pré-carregada.** A empresa
  introduz cada valor com a fonte legal (diploma, artigo, publicação). Uma **outra pessoa** (`sales.fiscal.confirm`)
  confirma-o depois de o verificar na fonte oficial; a base impede quem prepara de confirmar. Confirmado, o valor
  não muda: retira-se com motivo e cria-se nova vigência. Vigências confirmadas do mesmo imposto e âmbito não se
  sobrepõem (`OVERLAP`).
- Só valores **confirmados e em vigor na data** entram nos cálculos. A taxa da entidade prevalece sobre a do país.
  Uma taxa de imposto a 0 % exige um motivo de isenção confirmado.
- **As séries fiscais só existem em modo `SIMULATION`** (`CHECK` na base). A operação real fica bloqueada até haver
  software certificado e a especificação oficial; não há comunicação com a AGT, assinatura, hash ou QR.
- A "referência da comunicação à autoridade" é um registo manual, nunca verificado. Os ecrãs mostram o aviso de
  simulação.

**Cálculo.** Inteiros escalados com arredondamento a metade para cima:
- **Por linha:** cada imposto de cada linha a 2 casas, somados.
- **Por documento:** o total de cada imposto e taxa arredondado uma vez. O nível escolhe-se por entidade, e a empresa
  deve confirmá-lo na fonte oficial.
- **Retenções:** sobre a base do documento sujeita a cada uma, a partir da base mínima configurada.
- **Totais:** líquido, imposto, bruto, retenção e a pagar.

**Sequência.** `allocateFiscalNumber` corre na transacção do documento e bloqueia a série.
- Exige série activa, da entidade e do tipo do documento, com data dentro do ano fiscal e não anterior à última
  emissão.
- Regista o número em `fiscal_numbers`, só de acréscimo, único por série e por documento.
- Uma emissão que falha desfaz a atribuição, por isso não há saltos.
- A base impede recuar ou saltar a numeração, alterar a configuração de uma série activa e reabrir uma fechada.
- Várias séries do mesmo tipo podem estar activas em simultâneo; o documento escolhe-a explicitamente.

**Pendente:**
- verificar o texto oficial e a especificação da AGT;
- só depois configurar valores reais e implementar o adaptador de comunicação (10.9), que nesta fase só terá
  simulador identificado.

## D-064 Facturas: três estados distintos, emissão demonstrativa que fotografa e fixa tudo, facturação da encomenda sem duplicar (aceite)

**Estados.** A factura tem três estados independentes:
- **negócio:** rascunho → emitida → corrigida (pelas notas do 10.8); um rascunho pode ser descartado com motivo;
- **fiscal:** pendente na emissão; aceite, rejeitada ou contingência quando existir a integração do 10.9;
- **cobrança:** por pagar → parcial → paga (pelos recibos do 10.7). "Vencida" calcula-se na leitura: emitida, não paga
  e com o vencimento ultrapassado.

**Emissão.** Acontece numa só transacção, sob bloqueio da factura:
- recalcula preços (os da encomenda ou o motor de preços à data) e impostos (o motor fiscal, só valores confirmados
  em vigor);
- fotografa o cliente: versão imutável e dados (nome, NIF, morada);
- fixa o vencimento (data + prazo) e o câmbio para a moeda funcional na data (`NO_RATE` sem câmbio);
- regista o facturado na encomenda;
- atribui o número da série fiscal (em simulação, 10.5; escolha explícita com várias séries do ano);
- guarda uma impressão digital sha256 do conteúdo canónico. É controlo interno e **não** é a assinatura ou o hash da
  AGT.

Uma segunda emissão é recusada (`ALREADY_ISSUED`), por isso nunca há dois números. Uma emissão que falha não gasta
número. Não se emite:
- com data futura (`FUTURE`);
- com cliente bloqueado;
- sem linhas, ou com linhas sem preço;
- com descontos acima do limite ou preços manuais numa factura sem encomenda (`PRICING_APPROVAL_REQUIRED`): a
  aprovação faz-se no orçamento ou na encomenda.

**Imutabilidade.** Emitida, a base recusa alterar qualquer campo do conteúdo ou das linhas, voltar a rascunho ou
apagar. Só mudam o estado fiscal, a cobrança e a passagem a corrigida. Descartada é final.

**Stock.** Produtos de stock só se facturam a partir de uma encomenda, e só o que foi expedido e ainda não facturado
(`OVER_INVOICED`). Sem encomenda, a factura só leva serviços. Assim o stock nunca fica por movimentar nem é
movimentado pela factura: a saída é da expedição. `recordInvoiced` corre na emissão, bloqueia as linhas da encomenda
e recusa facturar acima do entregue. Duas emissões concorrentes sobre as mesmas unidades: uma passa, a outra é
recusada e não gasta número. Toda entregue e facturada, a encomenda fecha.

**Imposto vindo da encomenda.** Orçamentos e encomendas guardam uma taxa por linha (até ao 10.5). Ao facturar, a
linha precisa dos códigos de imposto do motor fiscal. Propõe-se o único imposto confirmado em vigor com essa taxa; se
houver mais de um, ou nenhum, a escolha é de quem factura.

## D-065 Recibos e facturas-recibo: só contam depois da confirmação financeira por outra pessoa; adiantamentos sem duplicação (aceite)

**Contexto.** O 10.7 pede recibos e facturas-recibo "conforme regime", que só contem depois da confirmação financeira,
com afectação parcial ou total a facturas e adiantamentos sem duplicação. O módulo Finanças/Tesouraria (Prompt 11)
ainda não existe.

**Decisão.**
- **Registo ≠ recebimento.** Registar um recebimento (valor, meio, conta, referência, data, afectações) cria-o
  `PENDING`. Nada é abatido nas facturas até alguém **diferente de quem registou** o confirmar com
  `sales.receipts.confirm` (a base recusa `confirmed_by = created_by`). Recusa e anulação exigem motivo e são finais.
  Este é o contrato que a Tesouraria do Prompt 11 vai chamar (conciliação bancária); até lá a confirmação é manual. Não
  se cria um módulo de Finanças provisório.
- **Recibo (RC).** As afectações são só a facturas emitidas do mesmo cliente, entidade e moeda, cada uma ≤ ao valor por
  receber, e somam ≤ ao valor recebido (`OVER_ALLOCATED`). Na confirmação, sob bloqueio de cada factura, aplica-se o
  pagamento (`OVER_PAYMENT` se outra confirmação já a pagou entretanto, e tudo volta atrás), a cobrança passa a
  parcial/paga e o recibo recebe o número da série `RECEIPT` em simulação. O excedente fica como **adiantamento**.
- **Adiantamentos sem duplicação.** O saldo é `advance_total − advance_used`, com `CHECK advance_used ≤
  advance_total`. Usar um adiantamento bloqueia o recibo, grava uma aplicação só de acréscimo e abate a factura numa só
  transacção. Duas aplicações simultâneas acima do saldo: uma passa, a outra recebe `OVER_ADVANCE`.
- **Factura-recibo (FR).** É um rascunho de factura com `document_kind = INVOICE_RECEIPT`, que **não** se emite
  directamente (`FR_NEEDS_PAYMENT`). Regista-se o recebimento do valor exacto a pagar (`AMOUNT_MISMATCH`) e, na
  confirmação, a FR é emitida pela série `INVOICE_RECEIPT` (preços e impostos recalculados; se o valor mudou, nada é
  feito) e fica paga. Só pode haver um recebimento pendente ou confirmado por FR (índice único parcial).
- **Idempotência.** O registo leva `requestKey`; o mesmo pedido devolve o mesmo recebimento e um corpo diferente com
  a mesma chave é recusado (`IDEMPOTENCY_MISMATCH`, por impressão digital do corpo).
- **Imutabilidade.** Confirmado, o conteúdo do recebimento não muda; afectações e aplicações são só de acréscimo; a
  cobrança da factura nunca desce (gatilhos). O tipo de documento da factura fica fixo depois do rascunho.
- **"Conforme regime".** Quando se usa factura-recibo, recibo ou outro documento por regime (geral, simplificado,
  exclusão) não foi verificado no texto oficial nem na especificação da AGT (ver D-063). Por isso a escolha é de quem
  factura e nada está bloqueado por regime. As séries continuam só em simulação e **não** há qualquer declaração de
  conformidade ou de validação pela AGT.

**Consequências.** As facturas só ficam pagas por recebimentos confirmados. A contabilização (10.12) e a conciliação
bancária (Prompt 11) ligam-se a `CONFIRMED`. Devoluções de adiantamentos e estornos de recebimentos confirmados ficam
para as notas de crédito (10.8) e a Tesouraria.

## D-066 Notas de crédito/débito, devolução física e reembolso: três documentos distintos (aceite)

**Contexto.** O 10.8 pede notas de crédito e débito com:
- referência à factura original;
- motivo;
- linhas, valores e imposto elegíveis;
- devolução física distinta da correcção fiscal e do reembolso financeiro.

A factura emitida é imutável (D-064).

**Decisão.**

- **Três documentos.** Cada um tem o seu documento, as suas permissões e a sua auditoria:
  - **devolução física**: na encomenda, entra no stock pelo `returnFromSale` do Inventário;
  - **correcção fiscal**: a nota;
  - **reembolso financeiro**: o reembolso confirmado.

  Nenhum dos três cria os outros automaticamente.

- **Devolução física** (`sales_returns`):
  - só linhas de stock, nunca acima do expedido ainda não devolvido (`OVER_RETURN`), com motivo;
  - idempotente por chave e impressão digital;
  - só de acréscimo.

  O devolvido deixa de ser facturável: facturável = entregue − devolvido − facturado + devolvido já creditado. O
  último termo é a parte do devolvido que uma nota ligada à devolução creditou depois de facturada. A encomenda fecha
  quando o facturado líquido cobre o que ficou com o cliente.

- **Nota** (`sales_notes`):
  - referencia sempre uma factura emitida ou já corrigida e copia dela:
    - a entidade e o cliente;
    - a fotografia fiscal do cliente;
    - a moeda e o câmbio da factura;
    - o nível de arredondamento.
  - o motivo vem de uma lista por tipo, com descrição obrigatória;
  - cada linha referencia uma linha da factura:
    - crédito por quantidade (devolução, quebra) ou por valor (preço, desconto);
    - débito só por valor: mais quantidade é uma nova factura.
  - o elegível conta só as notas de crédito emitidas, por quantidade e por valor;
  - creditar toda a quantidade que resta credita exactamente o valor que resta, o que evita resíduos de
    arredondamento.

- **Imposto.** Usam-se os códigos e as taxas da linha original, nunca os de hoje, calculados pelo motor fiscal do
  10.5. Uma retenção só entra se foi aplicada na factura.

- **Ligação à devolução** (opcional, só crédito). O crédito por quantidade não passa o que voltou nessa devolução e
  ainda não foi creditado (`OVER_RETURNED`).

- **Emissão:**
  - bloqueia a factura e recalcula o elegível;
  - a nota de crédito é emitida por outra pessoa que não quem a preparou (`SELF_ISSUE`, também na base);
  - numera pela série `CREDIT_NOTE`/`DEBIT_NOTE` em simulação, sem gastar número quando falha;
  - fixa uma impressão digital interna.

  Duas emissões concorrentes sobre o mesmo resto: uma passa, a outra é recusada.

- **Efeito na factura.** A factura passa a corrigida e ganha `credited_total`/`debited_total`, que nunca descem.
  Em dívida = a pagar + débitos − créditos − recebido.
  - O crédito abate o que está em dívida.
  - O resto fica como **crédito do cliente** na nota: pode compensar outra factura do mesmo cliente, entidade e moeda,
    ou ser reembolsado.
  - O débito aumenta a dívida, que os recibos do 10.7 cobram.

- **Reembolso** (`sales_refunds`):
  - registo idempotente com `sales.receipts.manage`;
  - um reembolso pendente reserva o crédito;
  - só conta quando outra pessoa o confirma com `sales.receipts.confirm`, como nos recebimentos; até à Tesouraria do
    Prompt 11 a confirmação é manual;
  - recusa e anulação exigem motivo.

- **Fiscal.** Os tipos de nota e o modo de as comunicar não foram verificados na especificação oficial da AGT (D-063).
  Fica só a simulação, sem qualquer declaração de conformidade.

**Consequências.**
- A factura original nunca muda.
- O histórico fiscal fica nas notas.
- O stock só se movimenta pela devolução.
- O dinheiro só sai pelo reembolso confirmado.

A contabilização dos três (10.12) e a ligação à conciliação bancária (Prompt 11) ficam por fazer. Também ficam por
fazer a devolução para quarentena ou bloqueado (hoje a mercadoria entra como livre) e a nota sobre a factura-recibo
com reembolso imediato.


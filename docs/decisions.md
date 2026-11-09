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

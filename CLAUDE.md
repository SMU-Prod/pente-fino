# PENTE-FINO — contexto de domínio

> **Status:** o `PRD.md` (§0) descreve este arquivo como o lugar onde vive o
> contexto de domínio e o léxico completo — e diz que, onde os dois
> divergirem, o `PRD.md` vence em requisito, contrato e critério de aceite,
> mas **este arquivo vence em dado de pesquisa e léxico**. Até agora só a
> §7 (léxico de detecção) foi escrita — é o que os três blocos travados em
> RN-020, RN-021 e RN-023 (PRD §12.2) precisam para sair do papel. As demais
> seções de contexto de domínio ainda não existem; não finja que existem.

---

## 7. Léxico de detecção — SVA, agregadoras, prefixos de processador e seguro embutido

### 7.0 Como este léxico foi construído — e o que isso significa para quanto confiar nele

Esta pesquisa foi feita **sem nenhuma fatura real em mãos** — nem o golden
set (`fixtures/golden/`, vazio: ver `fixtures/golden/README.md`) nem
qualquer conta de operadora ou cartão. A fonte foi texto de reclamação:
pessoas descrevendo, em português corrido, o que viram na própria fatura —
Reclame Aqui, consumidor.gov.br/PROTESTE, artigos jurídicos (jus.com.br,
Jusbrasil) sobre casos concretos, páginas de ajuda oficiais de operadoras e
processadoras, e o processo do MP-GO já citado no PRD.

Isso tem um teto claro:

- **Título de reclamação ≠ trecho de fatura.** Quando o autor da reclamação
  escreveu "Skeelo Promo" ou "COBRANÇA SERVIÇOS DE TERCEIRO TDATA" no título,
  é razoável assumir que copiou o que viu na fatura — mas não é a mesma
  garantia que extrair o texto de um PDF real, onde uma regra pode testar
  contra formatação, abreviação e ruído de OCR de verdade.
- **Resumo gerado por busca ≠ citação literal.** Toda vez que a informação
  veio de um resumo produzido pela ferramenta de busca (e não de um título
  de reclamação ou de uma página oficial lida diretamente), este documento
  marca isso explicitamente. Dois desses resumos concordando entre si **não
  contam como duas fontes independentes** se os dois resumiram a mesma
  reclamação — por isso a contagem de fontes abaixo é conservadora.
- **Nomes de produto mudam.** Parte do que segue é de operadoras/períodos
  específicos (alguns relatos são de 2015–2019, outros recentes). Um serviço
  pode ter sido descontinuado ou renomeado. Isso é aceitável para a decisão
  de *que padrão vale a pena testar* — não é aceitável como verdade atual
  sem confirmação.

**Por isso, e por decisão que já está no PRD (RF-125), nenhuma regra gerada a
partir deste léxico deve nascer `active`.** Nasce `draft`, entra em `shadow`
por 7 dias, e só é promovida pelos números reais de `dismissed/fired`
(RF-126) — nunca pela confiança que este documento atribui a um termo. O
custo de deixar um termo de fora é uma cobrança que o laudo não pega; o custo
de incluir um termo fraco é acusar uma pessoa real de uma cobrança indevida
que não é. RF-106 já aceita o primeiro custo como a direção seguramente mais
barata, e este léxico segue a mesma lógica.

**Classificação de confiança usada em todas as tabelas abaixo:**

| Selo | Critério |
|---|---|
| ✅ **confirmado** | Termo aparece em 2 ou mais fontes independentes (títulos de reclamação de reclamantes diferentes, ou uma fonte oficial + um relato) |
| ⚠️ **1 fonte** | Aparece em só uma fonte, ou só em resumo de busca sem título/trecho literal corroborando |
| ❔ **precisa de fatura real** | Termo plausível pela pesquisa, mas sem base suficiente para virar regra em qualquer confiança — listado à parte, no fim de cada bloco |

Nenhum termo ❔ deve virar seed de `rules`, nem em `draft`.

---

### 7.1 RN-020 — SVA em telecom

#### 7.1.1 Seções-âncora (cruza com o seed de `issuers` do PRD §20.1)

O PRD §20.1 já semeia as seções por emissor. A pesquisa corrobora que essas
seções são nomes reais usados pelas próprias operadoras, e encontra uma
seção adicional útil para Vivo:

| Emissor | Seções já no seed (§20.1) | Achado adicional da pesquisa | Fontes |
|---|---|---|---|
| Claro Móvel | "Aplicativos Digitais" | Claro reduziu o catálogo de SVA de "mais de 100" para "cerca de 60" produtos, majoritariamente parcerias de streaming (YouTube, Netflix, Prime Video, HBO, Telecine Play) — confirma que a seção agrega produto de terceiro, não item de plano | ✅ Proteste/conectaja |
| Vivo | "Serviços Digitais", "Serviços Digitais avulsos", "Cobrança de Serviços de terceiros", "Adicionais Contratados" | Pacote nomeado **"Serviços Digitais III"** aparece como o agrupador de cobrança de vários itens (FunKids, Hube Jornais, Vivo Meditação Lite, etc. somados) — é um nível abaixo da seção, mais parecido com um "combo" | ✅ Reclame Aqui (2 reclamações independentes citam o nome do combo) |
| TIM | "Serviços de valor adicionado(SVA)" | — | — |
| Oi | "Serviços Digitais", "Outros Pacotes e Serviços Mensais" | — | — |
| Sky | "lançamentos diversos" | — | — |
| Algar | "Outros Valores", "SERVICOS FACILIDADES", "OUTRAS COBRANCAS" | Reclame Aqui confirma que Algar também usa a sigla "SVA" diretamente no título da reclamação do cliente ("Cobrança de SVA (Serviço de Valor Adicional)") | ✅ Reclame Aqui |

Termo-âncora genérico, específico o bastante para ser âncora de seção (não
é "serviços" sozinho — é a expressão completa):

- **"Serviços de valor adicionado"** / **"SVA"** — ✅ confirmado à exaustão:
  Idec, Anatel (Resolução 632/2014, arts. 81–89, revogada pela Res.
  765/2023 mas ainda a base doutrinária citada nos processos), o próprio
  processo MP-GO 5223695.65.2019.8.09.0051, e dezenas de títulos de
  reclamação em quatro operadoras diferentes (TIM, Algar, Ligga, Op
  Telecom).
- **"Cobrança de Serviços de Terceiro(s)"** — ✅ confirmado (ver TDATA
  abaixo) — bate com a seção já seedada "Cobrança de Serviços de terceiros"
  da Vivo.

#### 7.1.2 Itens de SVA confirmados (2+ fontes independentes)

| Item (texto como aparece) | Operadora(s) observada(s) | Seção/pacote típico | Natureza | Fontes |
|---|---|---|---|---|
| **Skeelo** (variantes: Skeelo Top, Skeelo Promo, Skeelo Premium, Skeelo Intermediário, Skeelo Audiobooks) | Vivo (também citado em Brisanet, um ISP regional) | Serviços Digitais / "Serviços Digitais III" | Audiolivros/leitura por assinatura | ✅ 7+ reclamações independentes no Reclame Aqui, títulos distintos |
| **GoRead** / **Go Read** | Vivo | Serviços Digitais | Leitura de revistas/e-books (parceria com Editora Abril) | ✅ 4+ reclamações RA + Proteste; reclamação própria contra Editora Abril por dificuldade de cancelamento |
| **Hube Jornais** / **Hube Jornal** | Vivo | Serviços Digitais | Agregador de jornais | ✅ 3+ reclamações RA (aparece sempre ao lado de Skeelo/GoRead) |
| **NBA Básico** | Vivo | Serviços Digitais | Streaming esportivo (parceria Vivo–NBA) | ✅ 3+ reclamações RA + Proteste |
| **Clube de Revistas** | Vivo | Serviços Digitais | Assinatura de revistas, R$ 19,90/mês com renovação automática | ✅ 3+ reclamações RA |
| **FunKids** | Vivo | Serviços Digitais | Conteúdo infantil | ✅ 4+ reclamações RA + página própria da empresa no RA |
| **Ubook** / **Ubook Jornais** | Claro (contrato de autorização de cobrança oficial, PDF público), TIM (rebatizado "TIM Livros" na TIM) | Aplicativos Digitais / SVA | Audiolivros — produto legítimo com opt-in documentado, mas também alvo de reclamação de cobrança que persiste após cancelamento | ✅ multi-operadora: PDF oficial da Claro + branding oficial da TIM + reclamações RA |
| **"Serviços de Terceiro TDATA"** / **"Cobrança Serviços de Terceiro TDATA"** / **"Tdata Manutenção estendida Vivo fixo"** | Vivo (TDATA = Telefônica Data S.A., subsidiária 100% da Vivo) | Cobrança de Serviços de terceiros | Item "guarda-chuva" que a própria Vivo usa para itens que vão desde antivírus até "manutenção estendida" — nome deliberadamente pouco claro, segundo o artigo jurídico fonte | ✅ artigo jus.com.br (com citação literal do texto de fatura) + notícia Jusbrasil + reclamação RA de título idêntico + jnjur |
| **McAfee** (McAfee Proteção / McAfee Safe Connect) | Vivo (oficial, página própria de ativação) | Serviços Digitais | Antivírus — contratação oficialmente opt-in pela Vivo, mas presente em reclamações de cobrança que continua após cancelamento | ✅ página oficial Vivo + 2+ reclamações RA |
| **Vivo Meditação Lite** | Vivo | Serviços Digitais | App de meditação/bem-estar — **nota de julgamento:** não é item religioso (é produto secular de bem-estar com a marca da própria Vivo), mas o nome soa perto o bastante de prática espiritual para merecer o registro explícito desta ressalva antes de qualquer regra usar o termo | ✅ 2 reclamações RA/Proteste, valor R$ 2,49/mês citado |

#### 7.1.3 Itens com 1 fonte só — precisam de fatura real para confirmar

| Item | Operadora | Por que a confiança é baixa |
|---|---|---|
| Abril News Digital | Vivo | Só aparece em listagens combinadas de reclamação (2 reclamações citam o item, mas sempre dentro da mesma lista de "vários serviços", nunca isolado) |
| Babbel | Vivo | 1 única reclamação, dentro de uma lista de pacotes a cancelar |
| Vivo Recado | Vivo | 1 reclamação; pode ser recurso de caixa postal legítimo, não necessariamente SVA de terceiro |
| BandNews | Vivo | 1 reclamação, dentro de lista combinada |
| Lionsgate / Lionsgate+ | Vivo | 1 reclamação; é parceria de conteúdo real (citada em fonte separada sobre parcerias da Vivo), mas sem confirmação de como aparece na fatura |
| "NewsCo+" / "newco" | Vivo | Grafia inconsistente entre as fontes (uma reclamação escreve "newco" em minúsculas dentro de uma lista) — nome oficial do produto não confirmado |
| "Mais Proteção" e "Seguro Conta Paga" *(nota: estes dois são de cartão, não telecom — repetidos na tabela de RN-021 abaixo)* | — | — |

#### 7.1.4 Agregadoras / provedoras de conteúdo

| Nome | Papel | Confiança | Fontes |
|---|---|---|---|
| **Telefônica Data S.A. (TDATA)** | Subsidiária integral da Vivo que fatura o "guarda-chuva" de serviços de terceiro | ✅ confirmado | jus.com.br, Jusbrasil, RA, jnjur |
| **Editora Abril** | Editora por trás de GoRead e ligada a Abril News Digital / Clube de Revistas nas reclamações que os citam juntos | ✅ confirmado (GoRead) / ⚠️ 1 fonte (os outros dois) | RA (reclamação direta contra "Editora Abril" por GoRead) |
| **Skeelo** (a empresa, não só o app) | Empresa brasileira de audiolivros que revende via múltiplas operadoras (Vivo, Brisanet) | ✅ confirmado | RA — reclamações citam explicitamente "contratado via Vivo/Brisanet" |
| M4U / Multidisplay | Citado como integrador de recarga white-label para operadoras | ❔ precisa de fatura real | 1 fonte, e o negócio descrito (recarga pré-paga) não é claramente o mesmo de agregação de conteúdo SVA — relevância para RN-020 não confirmada |
| Movile | Empresa histórica de comércio de toque de celular/SMS (fim dos anos 1990/2000) | ❔ precisa de fatura real | Datado; sem evidência de que ainda aparece em fatura atual |

---

### 7.2 RN-023 — prefixos de descritor de processador de pagamento

**Lembrete do próprio RN-023, para quem for usar esta tabela:** casar um
descritor com um prefixo abaixo classifica a cobrança como **assinatura
recorrente** para o app mostrar onde cancelar. Isso **não é, por si só, um
achado de cobrança indevida** — é exatamente o que o PRD já diz.

| Prefixo / formato | Processador | Confiança | Fontes |
|---|---|---|---|
| `MP*<nome ou id>` (ex.: `MP*CHUBBSEGUROSBRASI`, `EC*MP*CHUBBSEGUROSBRASI`) | Mercado Pago | ✅ confirmado | Descritor literal em 8+ reclamações RA independentes + múltiplos guias explicativos consistentes entre si |
| `PAG*<nome>` | PagBank / PagSeguro | ✅ confirmado | Documentação de integração oficial do PagBank (prefixo fixo, não removível) + guias de fatura |
| `PP*<vendedor>` | PayPal | ✅ confirmado | Documentação oficial do PayPal (orientação a lojistas sobre o próprio formato) |
| `EBANX*`, `EBW+`, `EBANX PIN` | Ebanx | ✅ confirmado | Guias consistentes entre si + site especializado em tradução de descritor de fatura |
| `DL*<nome>` (ex.: `DL*GOOGLE`, `DLOCAL*GOOGLE YOUTUBE`) | dLocal | ✅ confirmado | 2+ reclamações RA + fórum oficial de suporte Google + site de tradução de descritor |
| `HTM*` / `HTM` / `HT` | Hotmart | ✅ confirmado | Reclamação RA de título "COBRANÇA HTM" + central de ajuda oficial da Hotmart + site de tradução de descritor |
| `APPMAX` / `APPX` | Appmax | ✅ confirmado | Artigo oficial da própria Appmax ("O que significa APPX na fatura") + reclamação RA + documentação de plataformas de e-commerce que integram a Appmax |

**Achados de menor confiança — não usar sozinhos:**

| Prefixo | Observação |
|---|---|
| `MERCADOPAGO*` (forma por extenso) | Uma única fonte descreve esta forma por extenso, contradizendo a forma abreviada `MP*` que é a esmagadoramente mais citada — pode ser variante de emissor de cartão específico; ❔ precisa de fatura real |
| `EC*` | Aparece como prefixo composto antes de outro código (`EC*MP*...`) em pelo menos um caso real — parece significar "Estabelecimento Comercial" genérico antepandido por alguns emissores, não um processador em si; ❔ precisa de fatura real antes de virar padrão |
| `Ebn*` / `Pg*` | Variantes citadas em só uma fonte (site catalogador), sem confirmação; ❔ |
| `STRIPE` | Raramente aparece cru — Stripe permite descritor customizado por lojista na maioria dos casos, então um regex fixo tende a não casar com a maioria das cobranças reais; ❔ |

**Negativo confirmado — não tratar como prefixo de RN-023:** Iugu, Vindi,
Pagar.me (Stone) e Asaas são plataformas de cobrança recorrente cujo próprio
material oficial descreve o nome exibido como um **"soft descriptor"
configurável por cada lojista** — não existe um prefixo fixo da plataforma
em si. Um regex que procure "IUGU" ou "VINDI" no descritor vai errar a
maioria das cobranças reais processadas por essas plataformas, porque o que
aparece é o nome que o lojista escolheu. Da mesma forma, adquirentes puros
(Cielo, Rede, GetNet, Stone como adquirente) tipicamente mostram o nome do
próprio estabelecimento, não a marca do adquirente — **não são candidatos a
prefixo de RN-023** com o material encontrado nesta pesquisa.

---

### 7.3 RN-021 — seguro embutido em cartão

**Achado estrutural antes do léxico em si:** ao contrário de RN-020, não
encontrei evidência de uma seção estável e nomeada em fatura de cartão que
funcione como âncora de seguro embutido (o equivalente ao "Serviços
Digitais" da telecom). O que a pesquisa trouxe sobre "seção" veio só de
conteúdo genérico de explicação de fatura, não corroborado por trecho real —
fica como ❔. Isso é coerente com o próprio PRD: RN-021 já é especificado
sem bônus de âncora de seção (ao contrário de RN-020, que ganha 0,80→0,88
com seção confirmada). Não inventar uma seção para RN-021 só para ter uma.

#### Vocabulário genérico (específico o bastante para ser termo de casamento — não "seguro" sozinho)

| Termo | Confiança | Fontes |
|---|---|---|
| "Seguro Cartão Protegido" / "Cartão Protegido" | ✅ confirmado — nome quase idêntico usado por 5+ emissores/seguradoras diferentes (convenção de mercado, não coincidência) | Páginas oficiais: Santander, Itaú, Porto Seguro/Porto Bank, PagBank, Mapfre; reforçado por reclamações RA contra Porto Bank e Porto Seguro citando o nome exato |
| "Fatura Protegida" | ✅ confirmado — mesmo padrão, outro grupo de emissores | Páginas oficiais: Carrefour Soluções Financeiras, Cartão Atacadão, C6 Bank |
| "Seguro Prestamista" | ✅ confirmado | Múltiplas reclamações RA independentes (Facta Financeira, Banco BMG, Generali Seguros) |
| "Proteção Financeira" (cartão) | ⚠️ 1 fonte forte (branding oficial Santander) | — |
| "Seguro de Capitalização" (em fatura de cartão) | ⚠️ 1 fonte (artigo jurídico/modelo de petição) | Categoria regulada real (SUSEP), mas só uma fonte liga especificamente a cobrança em fatura de cartão |

#### Nomes específicos de seguradora/produto encontrados embutidos e recorrentes sem consentimento claro

| Nome | Confiança | Fontes |
|---|---|---|
| **"Chubb Seguros" / "Chubbsegurosbrasi"** (descritor real: `MP*CHUBBSEGUROSBRASI`, `EC*MP*CHUBBSEGUROSBRASI`) | ✅ confirmado — o achado mais forte de todo RN-021 nesta pesquisa | 8+ reclamações RA independentes, a maioria citando o valor exato (R$ 5,99 ou R$ 7,99) e o descritor literal. É também o melhor exemplo real de RN-021 e RN-023 se cruzando: seguro embutido, vendido através do Mercado Pago, cobrado com o prefixo `MP*` |
| "Mais Proteção" / "Mais Proteção - Mega" (Riachuelo/Midway) | ⚠️ 1 fonte — só apareceu em resumo de busca, nunca em um título de reclamação que eu pudesse conferir diretamente (reclameaqui.com.br bloqueia leitura direta de página) | ❔ precisa de fatura real ou leitura direta da reclamação antes de confiar no nome exato |
| "Seguro Conta Paga - Plano Único" (Riachuelo/Midway) | ⚠️ 1 fonte, mesma ressalva acima | ❔ precisa de fatura real |

---

### 7.4 Excluído por INV-006

**Nada do que apareceu nesta pesquisa — itens de SVA em telecom, seguro
embutido em cartão, ou prefixo de processador — tocou em saúde, religião,
sindicato ou política.** Os quatro domínios de busca (SVA telecom,
agregadoras, prefixo de processador, seguro embutido) simplesmente não
cruzam naturalmente com essas categorias, e nenhuma reclamação ou fonte
oficial lida mencionou um item cujo nome revelasse uma delas. Portanto não
há uma lista de termos removidos — a lista é vazia, e é honesto dizer que é
vazia porque o domínio pesquisado não gerou candidato, não porque houve uma
triagem rigorosa que removeu muita coisa.

Uma ressalva registrada por transparência, não uma exclusão: "Vivo Meditação
Lite" (§7.1.2) tem "meditação" no nome, o que poderia soar perto de prática
espiritual/religiosa. Decidi mantê-lo porque é um produto secular de
bem-estar com marca própria da operadora (não é um serviço de uma
denominação religiosa específica) — mas registro a dúvida aqui em vez de
decidir isso em silêncio. Se quem for gerar a regra achar que o risco não
vale a pena, é seguro remover esta única linha sem perder mais nada da
tabela.

---

### 7.5 Fontes usadas, por peso

**Maior peso (usadas para os itens ✅ confirmado):**
- Títulos de reclamação no Reclame Aqui — tratados como texto literal
  escrito pelo reclamante (não resumo de IA), portanto a fonte mais confiável
  disponível sem uma fatura real. Múltiplos títulos de reclamantes
  diferentes = múltiplas fontes independentes.
- Páginas oficiais de operadora/processador (Vivo, Claro, PayPal, PagBank,
  Appmax, Hotmart) — mais confiáveis que reclamação para formato exato de
  descritor, menos úteis para saber que a cobrança é *disputada*.
- Idec ("Cobrança Indevida - SVA" e "Serviço de Valor Adicionado no
  celular"), Proteste/conectaja, reclamações via plataforma PROTESTE.
- Artigo jus.com.br "A ilegalidade das cobranças pelas empresas de
  telefonia de Serviços de Valores Adicionados" — única fonte com citação
  literal de texto de fatura fora de reclamação individual (o caso TDATA).
- Processo MP-GO 5223695.65.2019.8.09.0051, já citado no PRD para RN-020 —
  confirmado via notícia oficial do MP-GO e cobertura jurídica (Rota
  Jurídica).
- Anatel: Resolução 632/2014 (RGC, arts. 81–89, revogada pela Res.
  765/2023) como base regulatória histórica dos casos citados.

**Peso médio:** sites especializados em "traduzir" descritor de fatura de
cartão (ex.: tradutordefatura.com.br) — úteis para corroborar formato de
prefixo, mas são fonte única por prefixo na maioria dos casos, então
qualquer entrada que dependa só deles está marcada ⚠️ ou ❔ acima.

**Peso baixo, usado só como pista:** resumos gerados por ferramenta de busca
sobre múltiplos resultados ao mesmo tempo — úteis para achar *para onde*
pesquisar em seguida, nunca citados sozinhos como confirmação de um termo.

**Não citável, não usado:** não foi possível ler o conteúdo de
`reclameaqui.com.br` e `idec.org.br` diretamente (bloqueiam acesso
automatizado) — tudo que vem dessas fontes passou por resultado de busca
(título literal ou resumo, diferenciados acima) em vez de leitura direta da
página.

---

### 7.6 Nota para quem for transformar isto em `RuleSpec`

Este documento não escreve regex nem toca em seed de `rules` — isso é
trabalho de quem ler isto a seguir. Só um lembrete de arquitetura, porque já
está no PRD e vale repetir aqui: a normalização de RF-122 (caixa alta,
remoção de acento, `Ç→C`, colapso de espaço, remoção de número variável) roda
**antes** de qualquer casamento — então as strings acima devem ser escritas
como estão, no português com acento, e a normalização é responsabilidade do
motor, não deste léxico. Toda regra gerada a partir de um termo ✅
confirmado ainda nasce `draft`→`shadow` (RF-125); um termo ⚠️/❔ não deve
virar seed nenhum ainda.

---

## 8. Convenções de domínio que o PRD não fixou

### 8.1 Fuso horário do cálculo de prazo

**Toda aritmética de data civil deste produto acontece em `America/Sao_Paulo`,
com deslocamento fixo de −180 minutos (UTC−3).**

O `PRD.md` não diz isso em lugar nenhum — não há uma única ocorrência de
`Sao_Paulo`, `fuso`, `timezone` ou `UTC` no documento. Ficou implícito, e
implícito é como dois módulos acabam com duas respostas diferentes.

Por que fixo e não `Intl`:

- O Brasil não tem horário de verão desde o Decreto 9.772/2019, então o
  deslocamento não varia dentro do horizonte que este produto enxerga.
- Depender do tzdata do host faria a mesma conta dar resultados diferentes
  no Windows do desenvolvimento e no Linux do CI — que é exatamente a classe
  de defeito que só aparece depois de deployado.

Onde isso vive: `SAO_PAULO_UTC_OFFSET_MINUTES`, em
`packages/core/src/cases/deadline.ts`. É a única declaração do fuso no
código; qualquer módulo novo que precise contar dias importa dela em vez de
inventar a sua.

Consequência que se vê no banco: `cases.next_deadline_at` é `timestamptz` e
guarda o **último milissegundo do dia do vencimento em horário local**. Um
prazo que vence dia 15 é armazenado como `2026-05-16T02:59:59.999Z` — a data
certa, lida no fuso certo.

### 8.2 Contagem de prazo: o dia do começo não conta

Exclui-se o dia do começo, inclui-se o do vencimento (CPC art. 224; Lei
9.784/1999 art. 66). Prazo em dias corridos que cai em fim de semana ou
feriado **rola para o próximo dia útil** — vencimento carimbado num domingo é
um argumento de graça para a empresa contestar a nossa aritmética.

Carnaval e Corpus Christi **não param o relógio**: ponto facultativo vincula
o Executivo federal, não a empresa do outro lado. Estão registrados no
calendário com `observance: "optional"` para que a política seja uma linha
visível, e não uma ausência que ninguém sabe se foi decidida ou esquecida.

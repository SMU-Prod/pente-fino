# E1 · Ingestão — desenho

**Data:** 31/08/2026 · **Escopo:** bloco E1 da §18 do `PRD.md` (RF-101 a RF-111), na variante **sem credencial externa**, seguindo o mesmo critério do E0.

---

## 1. O ponto de partida

Metade do E1 já está de pé, entregue no E0:

| Requisito | Estado |
|---|---|
| RF-101 upload assinado, expira em 5 min | **pronto** — e a URL expira de verdade, o adaptador rejeita assinatura adulterada |
| RF-102 dedup por hash e por dono | **pronto** — sequencial; a corrida concorrente segue anotada |
| RF-108 validações determinísticas | **pronto** — as quatro, com os limites documentados |
| RF-109 mascaramento antes de gravar | **pronto** — `INV-007` verde, dígito verificador em vez de contagem de dígitos |

O que falta é o miolo: **ler a fatura de verdade**.

## 2. A descoberta que define o bloco

A extração do RF-107 é `unpdf` — uma biblioteca, não um serviço. A detecção de emissor do RF-105 é heurística explícita ("CNPJ no texto, palavras-chave de cabeçalho, aliases"), e o PRD manda fazê-la **antes de qualquer chamada de modelo**. A contagem de páginas do RF-104 sai do próprio parser.

Ou seja: **quase todo o E1 se constrói sem conta nenhuma.** O que depende de credencial é só a chamada do modelo e a ingestão por e-mail.

| Requisito | Precisa de conta? |
|---|---|
| RF-103 foto: resize 2000px, HEIC→JPEG, rotação EXIF | não — roda no navegador |
| RF-104 magic bytes + 12 páginas | não — o parser dá as duas coisas |
| RF-105 detecção de emissor por heurística | **não** — é o ponto do requisito |
| RF-106 emissor desconhecido segue com regra genérica | não |
| RF-107 `unpdf` para PDF com texto | **não** — biblioteca |
| RF-107 queda para visão quando a qualidade < 0,6 | a decisão de rota, não; a chamada, sim |
| RF-110 job diário de expiração de arquivo | não — o adaptador local implementa |
| RF-111 ingestão por e-mail | **sim** — Resend inbound |

## 3. Escopo do E1 sem credencial

**Entra:**

1. **Extração de texto real.** `unpdf` sobre o PDF, devolvendo texto por página, contagem de páginas e um `extractionQuality` calculado — não estimado no olho. A qualidade é o que decide a rota do RF-107, então ela precisa ser uma medida defensável e testada, não um número inventado.
2. **Detecção de emissor.** CNPJ no texto, aliases e palavras-chave de cabeçalho, sobre os seis emissores do §20.1. Emissor desconhecido cria `issuers` com `status=unknown` e o fluxo continua (RF-106).
3. **O portão de arquivo completo.** Magic bytes em vez de tipo declarado, e o limite de 12 páginas — as duas metades que o E0 deixou anotadas no código.
4. **Pipeline de imagem no cliente.** Resize, HEIC→JPEG, correção de rotação por EXIF, antes do upload.
5. **Job de expiração.** `fileExpiresAt` e a varredura diária que apaga do storage.
6. **O provedor de IA real, atrás da porta que já existe.** Implementado contra o AI SDK com saída validada por Zod (A7), exercitável no instante em que houver chave, sem tocar em domínio.
7. **A dívida do golden set.** O desenho do E0 prometeu "formato, script de anonimização e runner" e entregou só o formato. O E1 fecha isso: o script que troca CPF, nome, endereço e número de linha **preservando o layout**, e o runner que mede acerto por campo-chave. Sem isso o RNF-16 não é mensurável nem quando as faturas chegarem.

**Não entra, e por quê:**

| Item | Motivo |
|---|---|
| RF-111 ingestão por e-mail | Precisa de Resend inbound. Único requisito do bloco integralmente bloqueado. |
| A chamada de visão | O roteamento e a porta ficam prontos; a implementação é configuração de provedor. |
| O número do RNF-16 | Mede-se contra fatura real. O aparelho fica pronto; a medida espera as faturas. |

## 4. Decisões

**A qualidade da extração é uma medida, não um palpite.** `extractionQuality` decide se a fatura vai para visão — um número frouxo manda PDF nativo para o modelo (custo) ou aceita lixo de OCR como texto (erro). Vai ser calculada a partir de sinais verificáveis: proporção de caracteres legíveis, presença dos campos-âncora que toda fatura tem (valor total, vencimento, CNPJ), e densidade de texto por página. Com teste para cada sinal.

**A heurística de emissor não chuta.** Se nenhum sinal casar, o emissor é `unknown` e o laudo sai com regra genérica (RF-106) — nunca um palpite de emissor, que envenenaria a precedência de regra do RF-123 no E2.

**O texto extraído não vira `InvoiceCanonical` sem modelo.** A1 é explícito: o modelo transcreve, o motor julga. Sem chave, o pipeline vai até o texto e para de forma visível, com `needs_review` e mensagem honesta — nunca inventando estrutura a partir de regex, que é a tentação óbvia e viraria dívida permanente.

**O golden set nasce com casos negativos.** §16.2 pede faturas sem nenhum achado, porque sem elas não há como medir falso positivo — que é o guardrail do §1.4 e o marco de qualidade do §18.

## 5. Critério de pronto

- Um PDF de fatura com texto atravessa upload → magic bytes → contagem de páginas → `unpdf` → detecção de emissor → qualidade → rota, e para em `needs_review` com mensagem honesta por falta de chave de modelo.
- Um PDF escaneado (sem camada de texto) é roteado para visão, não tratado como texto.
- Um `.docx` renomeado para `.pdf` é recusado pelos magic bytes.
- Um PDF de 13 páginas é recusado.
- Uma foto HEIC de 12 MP chega ao storage em JPEG, abaixo de 2 MB, na orientação certa.
- O job de expiração apaga o arquivo vencido e só ele.
- O runner do golden set roda contra uma pasta vazia, informa zero casos, e falha de verdade quando um caso regride.

## 6. O que continua dependendo do Erick

1. **As faturas.** 10 reais anonimizadas por emissor. O aparelho de medição fica pronto neste bloco; a medida, não.
2. **A chave do modelo.** Sem ela o pipeline para no texto extraído, de propósito e visivelmente.
3. **Resend**, para o RF-111.

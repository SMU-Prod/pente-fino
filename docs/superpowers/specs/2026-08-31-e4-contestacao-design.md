# E4 · Contestação — desenho

**Data:** 31/08/2026 · **Escopo:** bloco E4 da §18 (RF-160 a RF-165), mais o `INV-003` que este bloco torna testável pela primeira vez.

---

## 1. O que este bloco é

Até aqui o produto lê uma fatura e diz o que vale conferir. Aqui ele escreve **o texto que a pessoa vai enviar para a empresa** — e é onde três das dez invioláveis deixam de ser teste de unidade e viram a saída do produto.

O critério de pronto do §18 é um eval com rubrica ≥ 8/10 e a suíte `invariants/lint` verde. Mas o que define o bloco não é a nota: é que **o documento é da pessoa, não do sistema.**

## 2. As três invioláveis que este bloco ativa

**`INV-003` — nunca redigir peça apresentando o sistema como autor ou representante.** A §3 diz como: todo documento tem o usuário como autor, existe o campo `user_edited`, e o envio é ação manual. O teste que a §16.3 nomeia, `invariants/authorship.spec.ts`, nunca foi escrito porque não havia documento. Agora há.

Isso não é formalidade. Um texto que diz "nós entramos com a reclamação" é o produto se apresentando como representante de alguém num procedimento de consumo — e a §1.5 põe "qualquer forma de representação do usuário" fora de escopo, permanentemente.

**`INV-004` — vocabulário jurídico proibido em qualquer saída.** O lint existe desde o E0, com a lista da §14.3, plural, e o mecanismo de citação explícita. O RF-162 exige que ele rode **antes de exibir**, e que um documento reprovado seja regenerado.

**`INV-005` — nunca prometer resultado.** Mesma trava, mesma lista.

## 3. O que depende do modelo e o que não

Como no E1 e no E2, a maior parte se constrói sem chave.

| Peça | Precisa do modelo? |
|---|---|
| O contrato `ContestDocument` (§7.5) | não — existe desde o E0 |
| RF-161: montar `legalRefs` a partir dos achados | **não, e é o ponto** |
| RF-162: o lint antes de exibir, e a regeneração | não |
| RF-163: o roteiro do atendimento | o texto sim; a estrutura e os pedidos obrigatórios não |
| RF-164: edição, `userEdited`, versão original preservada | não |
| RF-165: checklist de anexos por etapa | não — vem do playbook |
| A rubrica de eval da §20.4 | o aparelho não; a nota sim |
| A geração em si | **sim** |

## 4. Decisões

**A base legal nunca passa pelo modelo.** O RF-161 é explícito e o aceite é um teste que injeta achados com base X e verifica que só X aparece. Isso existe porque alucinação de base legal é o jeito mais rápido de esse produto morrer: uma citação inventada num documento enviado a uma empresa é um erro que o usuário assina. O `legalBasis` vem do achado, que veio da regra, que foi semeada de uma citação do PRD.

**O lint roda antes de exibir, não depois de gerar.** A diferença importa: o RF-160 já regenera uma vez quando o schema rejeita, e o RF-162 acrescenta a regeneração por vocabulário. Um documento que falhe nas duas tentativas vira erro claro ao usuário — nunca um documento parcialmente higienizado.

**A versão original é preservada em qualquer edição.** O RF-164 pede as duas consultáveis. Isso é `INV-003` na prática: se a pessoa editou, o que ela enviou é dela; se não editou, ainda é dela, e o registro mostra qual foi qual.

**Sem chave, o bloco para de forma visível.** Igual ao E1: o gerador chega até a entrada estruturada e diz que não pode gerar. Nunca monta um texto por template como substituto — um documento jurídico costurado de fragmentos fixos é pior que documento nenhum, porque parece pronto.

## 5. Fora do bloco

| Item | Motivo |
|---|---|
| O envio em si | A §1.5 e o `INV-002` são explícitos: o produto gera texto e deep link; quem envia é a pessoa |
| O dossiê do `jec_ready` (RF-187) | É E5 |
| O diff no admin do RF-164 | A tela é E11; as duas versões ficam consultáveis |
| A nota do eval | Precisa do modelo; a rubrica e o harness ficam prontos |

## 6. Critério de pronto

- uma saída fora do schema é rejeitada e regenerada uma vez; falhando de novo, erro claro (RF-160)
- achados com base legal X produzem documento contendo só X (RF-161)
- um documento contendo "advogado" é rejeitado e regenerado (RF-162)
- o `scriptForCall` tem no mínimo três itens, incluindo pedido de protocolo e de gravação (RF-163)
- editar grava `userEdited` e mantém a original consultável (RF-164)
- a etapa `consumidor_gov` lista fatura, protocolo anterior e print da conversa (RF-165)
- `invariants/authorship.spec.ts` existe e reprova primeira pessoa do plural institucional (`INV-003`)
- a rubrica da §20.4 roda, e diz que não mediu nada enquanto não houver chave

## 7. O que continua dependendo do Erick

A chave do modelo é o que separa este bloco de um aparelho sem uso: sem ela o gerador tem contrato, tem lint, tem rubrica e não tem texto.

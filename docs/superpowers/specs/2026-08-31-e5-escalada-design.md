# E5 · Escalada — desenho

**Data:** 31/08/2026 · **Escopo:** bloco E5 da §18 (RF-180 a RF-187).

---

## 1. O que este bloco é

É o bloco que faz o produto **valer alguma coisa depois do primeiro dia**.

Até aqui: a pessoa manda a fatura, vê o laudo, recebe o texto da contestação, envia. E aí acaba. Ela vai esquecer. A empresa conta com isso — o prazo corre, ninguém cobra, e o caso morre em silêncio.

Este bloco é o que conta o prazo por ela, avisa quando venceu, e gera o texto da etapa seguinte **já com o prazo vencido carimbado**. A §2.3 lista isso entre os momentos de verdade: sem o lembrete de prazo, *"caso morre no meio"*.

## 2. As três coisas difíceis

**O prazo tem que estar certo.** O RF-181 exige dias corridos e dias úteis com o calendário nacional de feriados, e o aceite é específico: 10 dias úteis começando numa quinta antes de feriado tem que cair na data correta. Feriado brasileiro móvel deriva da Páscoa — Carnaval é Páscoa menos 47 dias, Sexta-feira Santa menos 2, Corpus Christi mais 60 — e isso é aritmética de computus, não uma lista fixa. Um prazo errado num documento enviado a uma empresa é um argumento perdido.

**A espera tem que sobreviver a um restart.** O RF-180 é explícito: *"reiniciar o serviço no meio de uma espera não perde o caso"*. Isso é o mesmo problema que documentei no E3 — trabalho disparado e esquecido não sobrevive a uma função serverless sendo desligada.

**A transição tem que ser total.** O `nextStage` é a única função do núcleo que ainda lança em toda entrada. A §9.1 pede a tabela de decisão completa, com teste cobrindo **todas** as combinações de `stage × event × category`. Um estágio errado perde o caso de alguém em silêncio.

## 3. A decisão central do bloco

**A durabilidade vem do banco, não do Trigger.dev.**

O ADR-02 escolheu Trigger.dev por espera durável de dias, tarefas longas e replay. Isso continua certo, e a conta é sua. Mas o aceite do RF-180 — sobreviver a um restart — **não depende dele**: uma linha em `cases.next_deadline_at` sobrevive a qualquer restart, e o schema já tem a coluna, o índice parcial `cases_next_deadline` e `protocol_token` esperando desde o E0.

Então: a espera é uma linha no banco, um job varre o que venceu, e a porta `TaskQueue` continua a mesma. O Trigger.dev entra quando houver conta, e ganha replay e observabilidade — não ganha a durabilidade, que já estará lá.

Isso é o oposto do que fizemos no E3, e de propósito: lá o disparo-e-esquece era um substituto assumidamente frágil; aqui a persistência é o mecanismo real.

## 4. O que depende de conta

| Peça | Precisa? |
|---|---|
| `nextStage` completo (§9.1) | não |
| Calendário de feriados e cálculo de prazo (RF-181) | não |
| Espera durável em banco + varredura (RF-180) | não |
| Protocolo libera a espera (RF-184) | não |
| Deep link, cópia, checklist (RF-183) | não — e o `INV-002` proíbe o sistema enviar |
| `stalled` e `abandoned` (RF-186) | não |
| Dossiê em PDF do `jec_ready` (RF-187) | não |
| Lembrete por e-mail (RF-185) | Resend pra enviar; o mailer local exercita o caminho |
| Lembrete por push (RF-185) | é E12 |
| Replay e observabilidade do workflow | Trigger.dev |

## 5. Decisões

**O calendário de feriados é dado versionado, não constante.** Feriado móvel se calcula; feriado fixo é lei federal e muda por lei. Fica como tabela de referência, do mesmo jeito que a §12.3 trata tarifa da ANEEL — com a fonte anotada.

**O prazo é carimbado quando vence, não quando é lido.** O RF-182 exige que o documento da etapa seguinte cite canal, protocolo e as duas datas. Isso significa que o vencimento é um fato registrado em `events`, não um cálculo refeito na hora de gerar o texto.

**Nada é enviado pelo sistema.** O `INV-002` e a §1.5 são explícitos. O RF-183 gera deep link e copia texto; quem clica é a pessoa. O aceite pede teste de que nenhum dado sai daqui para o canal.

**Um caso abandonado fecha com evento, não some.** O RF-186 dá 30 dias sem protocolo para `stalled` e mais 30 para `abandoned`. O desfecho fica registrado, porque a métrica-norte da §1.4 é reais recuperados confirmados e um caso que evaporou não é o mesmo que um caso perdido.

## 6. Critério de pronto

Da §18: **teste de reinício não perde caso.** Mais:

- a tabela de decisão do `nextStage` cobre toda combinação de `stage × event × category` (§9.1)
- 10 dias úteis a partir de uma quinta antes de feriado cai na data certa (RF-181)
- o documento da etapa seguinte contém protocolo e as duas datas (RF-182)
- nenhum dado é enviado ao canal pelo sistema (RF-183, `INV-002`)
- um POST de protocolo retoma a espera em menos de 30 s (RF-184)
- um caso aberto nas últimas 24 h não dispara e-mail (RF-185)
- 30 dias sem protocolo vira `stalled`; mais 30, `abandoned`, com evento (RF-186)
- o dossiê do `jec_ready` abre e traz a linha do tempo completa (RF-187)

## 7. O que continua dependendo do Erick

Resend para o lembrete por e-mail sair de verdade, e Trigger.dev quando quiser replay. Nenhum dos dois bloqueia o bloco.

# O agendador

`vercel.json` (em `apps/web/`) e `app/api/cron/[task]/route.ts`. Antes
disto, **nada agendava nada**: os quatro jobs abaixo estavam registrados em
`lib/container.ts` e nunca eram chamados por ninguém.

## Horários

Cron da Vercel roda em **UTC**. São Paulo é UTC−3 o ano inteiro (ver
`CLAUDE.md` §8.1).

| Tarefa | Cron (UTC) | Hora em SP | Por quê |
|---|---|---|---|
| `caseDeadlines` | `0 * * * *` | de hora em hora | RF-180. Um prazo que venceu às 9h não pode esperar até a manhã seguinte pra alguém saber — o bloco inteiro existe pra avisar no dia certo. |
| `dossier` | `0 5 * * *` | 02:00 | RF-187. Antes do `expireFiles` de propósito: um caso que chegou ao `jec_ready` hoje ganha o dossiê enquanto o arquivo da fatura ainda existe. |
| `expireFiles` | `0 6 * * *` | 03:00 | RF-110. Retenção; a hora exata não importa, madrugada é barata. |
| `ruleMetrics` | `0 7 * * *` | 04:00 | RF-302. Materializa `rule_metrics` a partir de `events`. |
| `ruleLifecycle` | `0 8 * * *` | 05:00 | RF-126/RF-127. Lê o que o `ruleMetrics` acabou de escrever. |

**A hora de diferença entre `ruleMetrics` e `ruleLifecycle` é deliberada.**
O `container.ts` já dizia que a ordem importa e que ela é problema do
agendador. Encadear os dois numa chamada só faria uma corrida de métricas
lenta ou quebrada arrastar a decisão de promoção junto; separados, uma
falha atrasa a promoção em um dia e não corrompe nada.

## Autenticação

A Vercel manda `Authorization: Bearer $CRON_SECRET` nos caminhos listados
no `vercel.json`. O segredo vive no ambiente da Vercel, nunca em arquivo
(RNF-12) — o `gitleaks` no CI cobre isso.

**Sem `CRON_SECRET` definido a rota recusa tudo (503).** Ela não abre. Um
deploy mal configurado que aceitasse chamada anônima daria a um estranho o
poder de apagar o arquivo de fatura de alguém.

Para configurar:

```bash
vercel env add CRON_SECRET production
```

## Limite de plano

O plano Hobby da Vercel limita cron a **duas execuções por dia por
projeto**. O `caseDeadlines` de hora em hora exige plano Pro. Se isso for
um problema antes da hora, o ajuste é o `schedule` do `caseDeadlines` — e
o custo do ajuste é direto e mensurável: uma varredura diária atrasa cada
escalada em até 24 horas.

## A lista cresce por merge

Um handler registrado no `container()` e ausente do `SCHEDULABLE` da rota
fica **exatamente tão morto** quanto todos ficavam antes desta rota existir.
Isso já aconteceu uma vez, no merge que trouxe o dossiê da RF-187.

Por isso `apps/web/test/routes/cron.test.ts` lê o `container.ts` e falha se
sobrar handler que não esteja agendado nem explicitamente dispensado (só o
`ingest`, que é disparado pelo upload de uma pessoa e nunca por relógio).
Quem adicionar um job novo descobre no teste, não em produção seis meses
depois.

## Tudo ligado

As cinco tarefas estão registradas no `container()` e agendadas aqui. O
`caseDeadlines` foi o último a entrar — a tarefa 3 do E5 o exportou do
pacote e não o registrou, então o caminho de cron existia e não chegava em
lugar nenhum.

Isso aponta o limite da guarda de deriva: ela lê o `container.ts` e pega
handler registrado que ninguém agenda. **Não pega o contrário** — nome
agendado que não resolve pra handler nenhum. Esse lado é coberto pelo teste
`every scheduled name resolves to a handler`, mas com o `container()`
mockado, então ele prova a rota e não a fiação. O teste que fecha de
verdade é o `apps/web/test/container-tasks.test.ts`, que enfileira pelo
nome contra o container real.

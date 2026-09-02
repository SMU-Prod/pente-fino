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

## O que ainda não está ligado

`caseDeadlines` só aparece em `container.ts` quando a tarefa 3 do E5 for
mesclada. Até lá a rota responde 500 com `no handler registered for task
"caseDeadlines"` — que é a resposta certa: alto e verdadeiro, em vez de um
200 que faria um job inexistente parecer um job sem trabalho a fazer.

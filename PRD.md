# PRD — PENTE-FINO

**Product Requirements Document · versão 1.0 · agosto de 2026**
Auditor de fatura + copiloto de reclamação do consumidor brasileiro.

---

## 0. COMO USAR ESTE DOCUMENTO

Este PRD é a especificação de execução. Ele vive na raiz do repositório junto do `CLAUDE.md` (que carrega o contexto de domínio e o léxico completo). Onde os dois divergirem, **este documento vence** em matéria de requisito, contrato e critério de aceite; o `CLAUDE.md` vence em matéria de dado de pesquisa e léxico.

### Regras para o agente que implementa

1. **Nunca implemente um requisito sem o seu critério de aceite.** Todo `RF-` e `RN-` tem critério verificável. Se não for possível verificar, pare e pergunte.
2. **Identificadores são estáveis.** `RF-`, `RNF-`, `RN-`, `INV-`, `E-` são referenciados em commits, testes e PRs. Nunca renumere.
3. **`INV-*` são invioláveis.** São restrições jurídicas e de privacidade traduzidas em requisitos. Violá-las é bug de severidade máxima, mesmo que o produto funcione.
4. **Configuração no banco, não em código.** Regras de detecção, prompts, playbooks, prazos e tabelas de referência são linhas versionadas. Deploy só para lógica de execução, segurança e cobrança.
5. **Toda migração é compatível para trás.** Adicionar coluna, nunca renomear em um passo.
6. **Toda alteração fecha com teste.** Ver §16 (Definition of Done).
7. **Idioma:** interface, mensagens e conteúdo em português do Brasil. Código, identificadores, commits e comentários em inglês.
8. **Ordem de execução:** siga §18. Não pule a fundação por parecer invisível.

---

## 1. VISÃO E ESCOPO

### 1.1 Problema

Cobrança indevida é a reclamação número um do Brasil. O consumidor não sabe que está sendo cobrado, e quando desconfia não sabe o que escrever nem para onde mandar. Os canais existem e são gratuitos, mas exigem texto, protocolo e controle de prazo — três coisas que ninguém faz.

### 1.2 Produto

O usuário envia a fatura. Em até 30 segundos recebe um laudo com as linhas a verificar e o valor somado. Com um toque recebe o texto da contestação e o roteiro do atendimento. O sistema conta os prazos legais, avisa quando a empresa não responde e gera o texto da etapa seguinte já com o prazo vencido carimbado. Quando a próxima fatura chega, compara e confirma se o valor voltou.

### 1.3 Categorias

| Código | Categoria | Fase |
|---|---|---|
| `telecom` | Telefone, internet, TV | MVP |
| `card` | Cartão de crédito e conta bancária | Fase 2 |
| `energy` | Energia elétrica | Fase 3 |
| `water` | Água e saneamento | Fase 4 |

### 1.4 Métricas do produto

| Métrica | Definição | Meta inicial |
|---|---|---|
| **Norte** | Reais recuperados confirmados por usuário ativo/mês | — |
| **Proxy** | % de contestações com desfecho favorável em 45 dias | ≥ 40% |
| **Ativação** | % de laudos que viram contestação enviada | ≥ 30% |
| **Guardrail** | Taxa de falso positivo por regra | < 15% |
| **Guardrail** | Taxa de `needs_review` por emissor em 24h | < 10% |

### 1.5 Fora de escopo (v1)

Automação de login de terceiros (permanente, ver `INV-002`); ligação automática ao SAC; integração Open Finance; múltiplos idiomas; funcionalidades para empresas; marketplace de advogados; qualquer forma de representação do usuário.

---

## 2. PERSONAS E JORNADAS

### 2.1 Personas

**P1 — O desconfiado.** Viu um valor estranho na fatura e não sabe o que é. Chega pelo Google buscando o nome do item. Quer resposta em segundos, sem cadastro. É o maior volume de entrada.

**P2 — O organizado.** Já sabe que paga coisa que não usa. Quer varrer todas as contas de uma vez e cancelar. É quem converte melhor para assinatura.

**P3 — O indignado.** Já reclamou, não resolveu, está sem paciência. Quer escalar. É quem mais usa a trilha de prazos e quem gera os melhores desfechos confirmados.

**P4 — O cuidador.** Administra as contas de outra pessoa (pai, mãe, filho). Precisa de múltiplas faturas de titulares diferentes na mesma conta.

### 2.2 Jornada principal (P1 → P3)

```
descoberta (SEO / card compartilhado)
   → upload sem cadastro
   → laudo em ≤ 30s
   → [salvar por e-mail]  → contestação gerada
   → roteiro do SAC → protocolo colado
   → espera com lembrete → prazo vencido → próxima etapa
   → fatura seguinte → diff → desfecho confirmado
   → monitor mensal ativo
```

### 2.3 Momentos de verdade

| Momento | Falha significa |
|---|---|
| Laudo em ≤ 30s | Abandono antes do valor |
| Precisão do laudo | Perda permanente de confiança |
| Texto da contestação | Usuário não envia |
| Lembrete de prazo | Caso morre no meio |
| Diff da fatura seguinte | Nunca há prova de resultado |

---

## 3. RESTRIÇÕES INVIOLÁVEIS

São requisitos, não diretrizes. Cada uma tem teste automatizado.

| ID | Restrição | Implementação | Teste |
|---|---|---|---|
| **INV-001** | Nunca cobrar percentual do valor recuperado ou economizado | Schema de billing não possui campo de comissão. Planos são fixos | `billing.spec` falha se existir campo `commission*`, `success_fee*` ou `percent*` |
| **INV-002** | Nunca acessar, armazenar ou operar credencial de terceiro (gov.br, banco, operadora) | Não existe integração de login externo. Fluxo é: gerar texto → deep link → usuário cola protocolo | Grep de CI proíbe `gov.br` em contexto de auth; revisão manual em PR que toque `packages/ai` |
| **INV-003** | Nunca redigir peça apresentando o sistema como autor ou representante | Todo documento tem o usuário como autor; campo `user_edited`; envio é ação manual | `documents.spec` verifica ausência de primeira pessoa do plural institucional em templates |
| **INV-004** | Vocabulário jurídico proibido em qualquer saída ao usuário | `packages/ai/lint.ts` roda antes de exibir; rejeita e regenera | `lint.spec` com lista completa (§14.3) |
| **INV-005** | Nunca prometer resultado | Copy revisada; laudo usa "a verificar" / "provável cobrança a contestar" | `copy.spec` proíbe "garantimos", "vamos ganhar", "você vai receber" |
| **INV-006** | Nunca inferir ou armazenar categoria sensível a partir da fatura | Lista de padrões proibidos no motor de regras; sem classificação semântica de gasto | `rules.spec` falha se regra ativa casar termo de saúde, religião, sindicato, política |
| **INV-007** | Mascarar CPF, endereço, código de barras e linha digitável antes de persistir | Etapa obrigatória do pipeline entre extração e gravação | `ingest.spec` verifica ausência de padrão de CPF em `canonical` gravado |
| **INV-008** | Nenhuma query de dado de usuário sem filtro de titularidade | Helper único `withUser(session)`; regra ESLint customizada | `eslint-rule-with-user.spec`; CI falha no lint |
| **INV-009** | Nunca vender produto, dado ou serviço à empresa reclamada | Sem tenant de empresa no schema; base pública é agregada e anônima | Revisão de arquitetura em PR que adicione tabela com `company_customer` |
| **INV-010** | Nunca sinalizar as teses mortas de `RN-090` a `RN-092` | Regras marcadas como supressoras | `suppressors.spec` — build falha se regra ativa violar |

---

## 4. GLOSSÁRIO (linguagem ubíqua)

Use exatamente estes termos em código, banco, API e conversa.

| Termo | Código | Definição |
|---|---|---|
| Emissor | `issuer` | Empresa que emitiu a fatura (Claro Móvel, Itaú, Enel SP) |
| Fatura | `invoice` | Documento enviado pelo usuário, único por `(user, content_hash)` |
| Item | `invoice_item` | Linha da fatura |
| Achado | `finding` | Detecção de uma regra sobre um item |
| Caso | `case` | Agrupamento de achados do mesmo emissor e período, com ciclo de vida próprio |
| Etapa | `stage` | Posição do caso na trilha de escalada |
| Playbook | `playbook` | Configuração por emissor: canais, prazos, o que pedir |
| Laudo | `report` | Resultado da auditoria apresentado ao usuário |
| Contestação | `contest` | Documento gerado para uma etapa |
| Protocolo | `protocol` | Número que a empresa fornece; prova da etapa |
| Desfecho | `outcome` | Resultado confirmado do caso |
| Diff | `diff` | Comparação entre fatura N e N+1 |
| Regra | `rule` | Unidade de detecção, versionada, em configuração |
| Supressor | `suppressor` | Regra que impede detecção juridicamente inválida |
| Modo sombra | `shadow` | Regra ativa que registra mas não exibe |

---

## 5. ARQUITETURA

### 5.1 Visão

```
┌─────────────┐   ┌─────────────┐
│  apps/web   │   │ apps/mobile │      Next.js (RSC)  ·  Expo Router
│  Next.js    │   │   Expo      │      Compartilham packages/ui e packages/core
└──────┬──────┘   └──────┬──────┘
       │                 │
       └────────┬────────┘
                │  Server Actions / Route Handlers
       ┌────────▼─────────┐
       │  packages/core   │  puro, sem I/O
       │  ─ InvoiceSchema │
       │  ─ ruleEngine    │
       │  ─ nextStage     │
       │  ─ diffInvoices  │
       └────────┬─────────┘
                │
   ┌────────────┼──────────────┬───────────────┐
   │            │              │               │
┌──▼───┐   ┌────▼─────┐   ┌────▼─────┐   ┌─────▼──────┐
│ Neon │   │    R2    │   │ Trigger  │   │ packages/ai│
│  PG  │   │ arquivos │   │  .dev    │   │ AI SDK+Zod │
└──────┘   └──────────┘   └──────────┘   └────────────┘
                                │
                    jobs: classify · extract · rules
                          escalation · diff · monitor
                          tariff-import · metrics · agent
```

### 5.2 Princípios de arquitetura

| # | Princípio | Consequência |
|---|---|---|
| A1 | **Extração ≠ interpretação** | O modelo transcreve; o motor de regras julga. Prompts de extração não contêm nenhuma noção de "indevido" |
| A2 | **Núcleo puro** | `packages/core` não faz I/O. Recebe JSON, devolve JSON. Testável com milhares de casos em milissegundos |
| A3 | **Tudo é evento** | Toda transição grava `events`. Métricas, motor adaptativo, cota do plano grátis e auditoria leem a mesma tabela |
| A4 | **Idempotência por hash** | Fatura identificada por `content_hash`. Cada passo de workflow pode reexecutar sem duplicar efeito |
| A5 | **Configuração viva** | Regras, prompts, playbooks e referências em tabela versionada com autor e motivo |
| A6 | **Estado durável** | Escalada é workflow com espera de dias, não cron com tabela de status |
| A7 | **Saída tipada** | Toda chamada de IA retorna objeto validado por Zod. Nunca prosa livre |
| A8 | **Falha visível** | Quando não há confiança, o sistema diz que não conseguiu, nunca inventa |

### 5.3 Monorepo

```
pentefino/
├── CLAUDE.md
├── PRD.md
├── turbo.json  ·  pnpm-workspace.yaml
├── apps/
│   ├── web/                  Next.js 15 (App Router)
│   │   ├── app/
│   │   │   ├── (public)/     landing, /l/[token], /cobranca/*, /empresa/*
│   │   │   ├── (app)/        laudo, casos, conta
│   │   │   ├── admin/        painel interno
│   │   │   └── api/          route handlers, webhooks, /api/card
│   │   └── ...
│   ├── mobile/               Expo Router
│   └── jobs/                 Trigger.dev tasks
├── packages/
│   ├── db/                   Drizzle schema, migrações, seeds
│   ├── core/                 domínio puro
│   │   ├── invoice/          InvoiceSchema, normalize, validate
│   │   ├── rules/            engine, types, evaluators
│   │   ├── cases/            nextStage, playbook types
│   │   ├── diff/             pairing, outcome
│   │   └── events.ts         catálogo de eventos
│   ├── ai/                   providers, prompts, router, lint
│   ├── ui/                   tokens, componentes web + RN
│   └── config/               tsconfig, eslint, tailwind preset
└── fixtures/
    └── golden/               faturas anonimizadas + JSON esperado
```

### 5.4 Decisões arquiteturais registradas

| ID | Decisão | Alternativa | Motivo |
|---|---|---|---|
| ADR-01 | Monorepo TS com Next.js + Expo | Flutter; PWA pura | Tipos e núcleo compartilhados; push confiável no iOS |
| ADR-02 | Trigger.dev para escalada | Cron + tabela; Inngest | Espera durável de dias; tarefas longas; replay |
| ADR-03 | Neon + Drizzle | Supabase | Branch por PR; escala a zero; tipos gerados |
| ADR-04 | AI SDK `generateObject` + Zod | SDK do provedor | Saída tipada; troca de modelo; eval e lint viáveis |
| ADR-05 | Núcleo puro sem I/O | Serviços com repositório | Teste massivo de regras; mesma lógica em web, app e jobs |
| ADR-06 | Regras declarativas em banco | Regras em código | Ajuste sem deploy; base do motor adaptativo |
| ADR-07 | Sessão anônima antes de auth | Login obrigatório | Laudo sem cadastro é o motor de aquisição |
| ADR-08 | Stripe (web) + RevenueCat (app) | Só lojas | Pix; evita taxa de loja na web |

---

## 6. MODELO DE DADOS

### 6.1 Convenções

- IDs: `text` com prefixo semântico (`inv_`, `cas_`, `rul_`), gerados por `nanoid(21)`.
- Dinheiro: `integer` em centavos. Nunca float.
- Datas: `timestamptz`. Datas civis (competência, vencimento) em `date`.
- Enums: `text` com `CHECK`, não `enum` nativo (facilita migração aditiva).
- Toda tabela: `created_at`, `updated_at`.
- Soft delete só onde há requisito legal de rastro; caso contrário, delete real.

### 6.2 Schema (Drizzle)

```ts
// packages/db/schema.ts

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  phone: text("phone"),
  plan: text("plan").notNull().default("free"),            // free | premium
  emailForwardToken: text("email_forward_token").unique(), // u-3f9a → inbound
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const anonymousSessions = pgTable("anonymous_sessions", {
  id: text("id").primaryKey(),
  claimedByUserId: text("claimed_by_user_id").references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const issuers = pgTable("issuers", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),                   // "claro-movel"
  category: text("category").notNull(),                    // telecom|card|energy|water
  displayName: text("display_name").notNull(),
  cnpj: text("cnpj"),
  aliases: jsonb("aliases").$type<string[]>().default([]), // para detecção
  playbook: jsonb("playbook").$type<Playbook>(),           // §7.4
  status: text("status").notNull().default("active"),      // active|unknown|paused
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invoices = pgTable("invoices", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id),
  sessionId: text("session_id").references(() => anonymousSessions.id),
  issuerId: text("issuer_id").references(() => issuers.id),
  contentHash: text("content_hash").notNull(),
  periodStart: date("period_start"),
  periodEnd: date("period_end"),
  dueDate: date("due_date"),
  totalCents: integer("total_cents"),
  source: text("source").notNull(),                        // pdf_text|pdf_vision|photo|csv|email
  extractionQuality: real("extraction_quality"),
  status: text("status").notNull().default("queued"),      // queued|extracting|analyzed|needs_review|failed
  fileKey: text("file_key"),
  fileExpiresAt: timestamp("file_expires_at", { withTimezone: true }),
  canonical: jsonb("canonical").$type<InvoiceCanonical>(),
  masked: boolean("masked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ownerHash: uniqueIndex("invoices_owner_hash")
    .on(sql`coalesce(${t.userId}, ${t.sessionId})`, t.contentHash),
  byUserIssuer: index("invoices_user_issuer_period").on(t.userId, t.issuerId, t.periodStart),
}));

export const invoiceItems = pgTable("invoice_items", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  lineNo: integer("line_no").notNull(),
  section: text("section"),
  description: text("description").notNull(),
  normalizedDesc: text("normalized_desc").notNull(),
  amountCents: integer("amount_cents").notNull(),
  qty: real("qty"),
  unitPriceCents: integer("unit_price_cents"),
  periodRef: text("period_ref"),
  meta: jsonb("meta").$type<Record<string, string | number>>(),
}, (t) => ({
  byInvoiceDesc: index("items_invoice_desc").on(t.invoiceId, t.normalizedDesc),
  trgm: index("items_desc_trgm").using("gin", sql`${t.normalizedDesc} gin_trgm_ops`),
}));

export const rules = pgTable("rules", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  version: integer("version").notNull().default(1),
  category: text("category").notNull(),
  issuerId: text("issuer_id").references(() => issuers.id),  // null = genérica
  kind: text("kind").notNull(),                              // pattern|delta|threshold|reference|confirm|arithmetic|suppressor
  spec: jsonb("spec").$type<RuleSpec>().notNull(),
  legalBasis: jsonb("legal_basis").$type<LegalRef[]>().notNull().default([]),
  confidenceBase: real("confidence_base").notNull(),
  status: text("status").notNull().default("draft"),         // draft|shadow|active|paused
  shadowUntil: timestamp("shadow_until", { withTimezone: true }),
  author: text("author").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ slugVersion: uniqueIndex("rules_slug_version").on(t.slug, t.version) }));

export const findings = pgTable("findings", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  itemId: text("item_id").references(() => invoiceItems.id, { onDelete: "cascade" }),
  ruleId: text("rule_id").notNull().references(() => rules.id),
  ruleVersion: integer("rule_version").notNull(),
  confidence: real("confidence").notNull(),
  evidence: jsonb("evidence").$type<string[]>().notNull().default([]),
  amountCents: integer("amount_cents").notNull(),
  doubledCents: integer("doubled_cents"),
  shadow: boolean("shadow").notNull().default(false),
  status: text("status").notNull().default("open"),
  // open|confirmed_by_user|dismissed_by_user|contested|resolved|unresolved
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cases = pgTable("cases", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id),
  issuerId: text("issuer_id").notNull().references(() => issuers.id),
  findingIds: jsonb("finding_ids").$type<string[]>().notNull(),
  stage: text("stage").notNull().default("draft"),          // §9.1
  stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull().defaultNow(),
  nextDeadlineAt: timestamp("next_deadline_at", { withTimezone: true }),
  workflowRunId: text("workflow_run_id"),
  protocolToken: text("protocol_token"),                    // wait.forToken
  outcome: text("outcome"),                                 // resolved|partial|denied|abandoned
  outcomeConfirmedBy: text("outcome_confirmed_by"),         // diff|user|none
  recoveredCents: integer("recovered_cents"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  dueSoon: index("cases_next_deadline")
    .on(t.nextDeadlineAt).where(sql`${t.stage} <> 'closed'`),
}));

export const caseDocuments = pgTable("case_documents", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  kind: text("kind").notNull(),          // sac_script|contest_letter|gov_text|regulator_text|dossier
  promptVersion: integer("prompt_version").notNull(),
  variant: text("variant"),
  body: jsonb("body").$type<ContestDocument>().notNull(),
  userEdited: boolean("user_edited").notNull().default(false),
  editedBody: jsonb("edited_body").$type<ContestDocument>(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const caseProtocols = pgTable("case_protocols", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  protocolNumber: text("protocol_number").notNull(),
  channel: text("channel").notNull(),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull(),
  responseDueAt: timestamp("response_due_at", { withTimezone: true }).notNull(),
  responseReceivedAt: timestamp("response_received_at", { withTimezone: true }),
  responseSummary: text("response_summary"),
});

export const events = pgTable("events", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  sessionId: text("session_id"),
  caseId: text("case_id"),
  invoiceId: text("invoice_id"),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byCase: index("events_case_time").on(t.caseId, t.occurredAt),
  byTypeTime: index("events_type_time").on(t.type, t.occurredAt),
}));

export const aiCalls = pgTable("ai_calls", {
  id: text("id").primaryKey(),
  invoiceId: text("invoice_id"),
  caseId: text("case_id"),
  purpose: text("purpose").notNull(),     // classify|extract|contest|agent
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptVersion: integer("prompt_version"),
  tokensIn: integer("tokens_in").notNull(),
  tokensOut: integer("tokens_out").notNull(),
  costUsd: real("cost_usd").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  traceId: text("trace_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const prompts = pgTable("prompts", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  version: integer("version").notNull(),
  body: text("body").notNull(),
  modelDefault: text("model_default").notNull(),
  status: text("status").notNull().default("draft"),  // draft|active|retired
  metrics: jsonb("metrics").$type<Record<string, number>>(),
}, (t) => ({ slugVersion: uniqueIndex("prompts_slug_version").on(t.slug, t.version) }));

export const referenceTariffs = pgTable("reference_tariffs", {
  id: text("id").primaryKey(),
  issuerCnpj: text("issuer_cnpj").notNull(),
  subgroup: text("subgroup").notNull(),        // B1
  modality: text("modality").notNull(),        // Convencional
  className: text("class_name").notNull(),     // Residencial
  subClass: text("sub_class").notNull(),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"),
  tusdCentsMwh: integer("tusd_cents_mwh").notNull(),
  teCentsMwh: integer("te_cents_mwh").notNull(),
  sourceUrl: text("source_url").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ lookup: index("tariffs_lookup").on(t.issuerCnpj, t.subgroup, t.validFrom) }));

export const referenceFlags = pgTable("reference_flags", {
  id: text("id").primaryKey(),
  competence: date("competence").notNull().unique(),
  flag: text("flag").notNull(),                 // verde|amarela|vermelha_1|vermelha_2|escassez
  valueCentsPer100Kwh: integer("value_cents_per_100kwh").notNull(),
  sourceUrl: text("source_url").notNull(),
});

export const aggregates = pgTable("aggregates", {
  id: text("id").primaryKey(),
  issuerId: text("issuer_id").notNull().references(() => issuers.id),
  normalizedDesc: text("normalized_desc").notNull(),
  period: date("period").notNull(),
  invoicesSeen: integer("invoices_seen").notNull().default(0),
  flagged: integer("flagged").notNull().default(0),
  confirmedByUser: integer("confirmed_by_user").notNull().default(0),
  dismissedByUser: integer("dismissed_by_user").notNull().default(0),
  resolved: integer("resolved").notNull().default(0),
}, (t) => ({ uniq: uniqueIndex("agg_uniq").on(t.issuerId, t.normalizedDesc, t.period) }));

export const entitlements = pgTable("entitlements", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  plan: text("plan").notNull(),
  source: text("source").notNull(),           // stripe|revenuecat|manual
  externalId: text("external_id"),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ byUser: index("entitlements_user").on(t.userId) }));

export const seoPages = pgTable("seo_pages", {
  id: text("id").primaryKey(),
  issuerId: text("issuer_id").notNull().references(() => issuers.id),
  chargeSlug: text("charge_slug").notNull(),
  title: text("title").notNull(),
  bodyMd: text("body_md").notNull(),
  status: text("status").notNull().default("draft"),
}, (t) => ({ uniq: uniqueIndex("seo_uniq").on(t.issuerId, t.chargeSlug) }));

export const ruleMetrics = pgTable("rule_metrics", {
  id: text("id").primaryKey(),
  ruleSlug: text("rule_slug").notNull(),
  ruleVersion: integer("rule_version").notNull(),
  day: date("day").notNull(),
  fired: integer("fired").notNull().default(0),
  dismissed: integer("dismissed").notNull().default(0),
  confirmed: integer("confirmed").notNull().default(0),
  contested: integer("contested").notNull().default(0),
  resolved: integer("resolved").notNull().default(0),
}, (t) => ({ uniq: uniqueIndex("rule_metrics_uniq").on(t.ruleSlug, t.ruleVersion, t.day) }));

export const agentProposals = pgTable("agent_proposals", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),   // adjust_confidence|pause_rule|promote_variant|new_rule_draft|prompt_edit
  target: text("target").notNull(),
  payload: jsonb("payload").notNull(),
  evidence: jsonb("evidence").$type<string[]>().notNull(),
  status: text("status").notNull().default("pending"), // pending|approved|rejected
  decidedBy: text("decided_by"),
  decisionReason: text("decision_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

### 6.3 Extensões e migrações iniciais

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

**Regras de migração:** nunca `DROP COLUMN` na mesma release que remove o uso; renomear é sempre em dois passos (adicionar, backfill, migrar leitura, remover em release posterior); toda migração roda em CI antes do deploy.

---

## 7. CONTRATOS DE DOMÍNIO

### 7.1 `InvoiceCanonical`

```ts
export const InvoiceCanonical = z.object({
  issuer: z.object({
    name: z.string().min(2),
    cnpj: z.string().regex(/^\d{14}$/).optional(),
    category: z.enum(["telecom", "card", "energy", "water"]),
  }),
  period: z.object({ start: z.string().date(), end: z.string().date() }),
  dueDate: z.string().date(),
  totalCents: z.number().int().nonnegative(),
  sections: z.array(z.object({
    name: z.string(),
    items: z.array(z.object({
      description: z.string().min(1),
      amountCents: z.number().int(),
      qty: z.number().optional(),
      unitPriceCents: z.number().int().optional(),
      periodRef: z.string().optional(),
      meta: z.record(z.union([z.string(), z.number()])).optional(),
    })).min(1),
  })).min(1),
  readings: z.object({
    previous: z.number(),
    current: z.number(),
    kwh: z.number().optional(),
    m3: z.number().optional(),
    estimated: z.boolean(),
    days: z.number().int().optional(),
  }).optional(),
  tariffs: z.object({
    teCentsKwh: z.number().optional(),
    tusdCentsKwh: z.number().optional(),
    flag: z.string().optional(),
    pis: z.number().optional(),
    cofins: z.number().optional(),
    icms: z.number().optional(),
  }).optional(),
  extraction: z.object({
    confidence: z.number().min(0).max(1),
    warnings: z.array(z.string()),
  }),
});
export type InvoiceCanonical = z.infer<typeof InvoiceCanonical>;
```

### 7.2 `RuleSpec`

```ts
export type LegalRef = {
  law: string;                 // "CDC" | "REN 1.000/2021" | "Res. CMN 3.919/2010"
  article: string;             // "art. 39, III, p.u."
  effect: "dobro" | "suspensao" | "cancelamento" | "amostra_gratis" | "vedada" | "limite";
  note?: string;
};

export type RuleSpec =
  | { kind: "pattern"; sections?: string[]; match: string; notMatch?: string;
      valueRange?: [number, number]; requireRecurrence?: number }
  | { kind: "delta"; field: "item_present" | "amount" | "section_total";
      comparedTo: "previous_invoice"; changeAtLeastPct?: number }
  | { kind: "threshold"; expr: string; operator: ">" | "<" | ">=" | "<="; value: number }
  | { kind: "reference"; source: "aneel_tariff" | "aneel_flag" | "cdc_limits";
      tolerancePct: number }
  | { kind: "confirm"; question: string; options: string[]; onNo: "create_finding" }
  | { kind: "arithmetic"; formula: string; expect: string; tolerancePct: number }
  | { kind: "suppressor"; blocks: string[]; reason: string };
```

### 7.3 `Finding`

```ts
export type Finding = {
  ruleSlug: string;
  ruleVersion: number;
  itemId: string | null;          // null = achado de fatura inteira (aritmético)
  amountCents: number;
  doubledCents: number | null;
  confidence: number;             // 0..1
  evidence: string[];             // frases curtas, prontas para exibir
  legalBasis: LegalRef[];
  askUser?: { question: string; options: string[] };
  shadow: boolean;
};
```

### 7.4 `Playbook`

```ts
export type Stage =
  | "draft" | "sac" | "ombudsman" | "consumidor_gov"
  | "regulator" | "procon" | "jec_ready" | "closed";

export type Playbook = {
  stages: Array<{
    stage: Stage;
    channel: string;               // "SAC 1052" | "app Anatel" | "consumidor.gov.br"
    deepLink?: string;
    responseDays: number;
    businessDays: boolean;
    requiresPreviousProtocol: boolean;
    asks: string[];                // o que pedir nesta etapa
    legalRefs: LegalRef[];
  }>;
  notes?: string;
};
```

### 7.5 `ContestDocument`

```ts
export const ContestDocument = z.object({
  subject: z.string().max(120),
  body: z.string().min(200).max(4000),
  requests: z.array(z.string().max(200)).min(1).max(6),
  legalRefs: z.array(z.object({ law: z.string(), article: z.string() })).max(6),
  scriptForCall: z.array(z.string().max(200)).max(8),
  attachmentsChecklist: z.array(z.string().max(120)).max(8),
});
```

---

## 8. API

Rotas em `apps/web/app/api`. Autenticação por sessão (cookie httpOnly) ou sessão anônima. Todas as respostas de erro seguem `{ error: { code, message, details? } }` com `message` em português, pronta para exibir.

### 8.1 Códigos de erro

| Código | HTTP | Mensagem ao usuário |
|---|---|---|
| `file_too_large` | 413 | "Esse arquivo é maior que 15 MB. Tente enviar só as páginas da fatura." |
| `unsupported_type` | 415 | "Esse formato não é aceito. Envie PDF ou foto." |
| `extraction_failed` | 422 | "Não conseguimos ler essa fatura com segurança. Tente uma foto mais nítida." |
| `quota_exceeded` | 402 | "Você já usou sua análise gratuita deste mês." |
| `rate_limited` | 429 | "Muitos envios seguidos. Aguarde um minuto." |
| `not_found` | 404 | "Não encontramos esse item." |
| `forbidden` | 403 | "Você não tem acesso a esse item." |

### 8.2 Endpoints

```
POST   /api/uploads/sign
       → { uploadUrl, fileKey, invoiceId }
       body: { contentHash, mimeType, sizeBytes }
       Cria invoice em status=queued. Se contentHash já existe para o dono, retorna o invoice existente.

POST   /api/invoices/:id/process
       → 202 { invoiceId, status }
       Dispara o job de ingestão. Idempotente.

GET    /api/invoices/:id/status        (SSE)
       → stream de { status, step, progressPct }
       Passos: classifying | extracting | validating | analyzing | done | needs_review | failed

GET    /api/invoices/:id/report
       → { invoice, findings[], totals: { suspectCents, doubledCents }, issuer }

POST   /api/findings/:id/feedback
       → 200 { ok: true }
       body: { action: "dismiss" | "confirm", answer?: string }

POST   /api/cases
       → 201 { caseId }
       body: { invoiceId, findingIds[] }

GET    /api/cases/:id
       → { case, documents[], protocols[], timeline[] }

POST   /api/cases/:id/documents/:docId/edit
       body: { body: ContestDocument }

POST   /api/cases/:id/protocol
       → 200 { nextDeadlineAt }
       body: { stage, protocolNumber, channel, registeredAt }
       Libera o token de espera do workflow.

POST   /api/cases/:id/advance
       body: { reason: "user_request" | "response_received", responseSummary?: string }

POST   /api/cases/:id/close
       body: { outcome, recoveredCents?, note? }

POST   /api/sessions/claim
       body: { email }
       Envia código; ao confirmar, migra invoices da sessão anônima para o usuário.

GET    /api/card/:invoiceId                (ImageResponse, público por token)
GET    /api/l/:token                        (página pública do laudo, anonimizada)

POST   /api/webhooks/stripe                 (assinatura verificada)
POST   /api/webhooks/revenuecat             (assinatura verificada)
POST   /api/webhooks/email-inbound          (Resend; roteia por email_forward_token)

GET    /api/me/export                       (JSON + links assinados)
DELETE /api/me                              (exclusão de conta; purga em 24h)
```

### 8.3 Rate limits

| Rota | Limite |
|---|---|
| `POST /api/uploads/sign` | 5/min por IP; 20/dia por sessão anônima |
| `POST /api/invoices/:id/process` | 10/min por usuário |
| `POST /api/sessions/claim` | 3/hora por e-mail |
| Demais | 60/min por sessão |

---

## 9. MÁQUINAS DE ESTADO

### 9.1 Caso

```
draft ──(usuário cria contestação)──▶ sac
  sac ──(protocolo colado)──▶ [espera responseDays]
      ├─(resolvido pelo diff ou usuário)──▶ closed
      ├─(prazo vencido)──▶ ombudsman (só card) ou consumidor_gov
      └─(30d sem protocolo)──▶ stalled (sub-estado, volta a sac)
  ombudsman ──▶ consumidor_gov
  consumidor_gov ──▶ regulator
  regulator ──▶ procon (opcional) ──▶ jec_ready
  jec_ready ──▶ closed
  qualquer ──(60d sem ação do usuário)──▶ closed{outcome:abandoned}
```

**`nextStage` é função pura.** Assinatura:

```ts
function nextStage(
  current: { stage: Stage; category: Category; hasProtocol: boolean },
  playbook: Playbook,
  event: { type: "protocol_entered" | "deadline_expired" | "response_received"
                | "resolved" | "user_abandon"; at: Date }
): { stage: Stage; nextDeadlineAt: Date | null; stampDeadline: boolean };
```

Tabela de decisão completa em `packages/core/cases/nextStage.table.ts`, com teste que cobre **todas** as combinações `stage × event × category`.

### 9.2 Fatura

```
queued → extracting → validating → analyzed
                          └─(falha 2×)──▶ needs_review
                          └─(erro fatal)─▶ failed
```

---

## 10. REQUISITOS FUNCIONAIS

Formato: `RF-xxx` · descrição · **Aceite:** critério verificável.

### E1 · Ingestão

**RF-101** Upload direto ao R2 com URL assinada, sem passar pelo servidor.
**Aceite:** requisição de upload não aparece nos logs do servidor com corpo do arquivo; URL expira em 5 minutos.

**RF-102** Cliente calcula SHA-256 e envia junto. Hash já existente para o mesmo dono retorna a fatura existente sem reprocessar.
**Aceite:** enviar o mesmo arquivo duas vezes cria uma única linha em `invoices` e não gera segunda chamada de IA.

**RF-103** Foto é redimensionada para 2000 px no maior lado, HEIC convertido para JPEG, rotação corrigida por EXIF, antes do upload.
**Aceite:** foto de 12 MP em HEIC chega ao R2 com menos de 2 MB, em JPEG, orientação correta.

**RF-104** Limites: 15 MB e 12 páginas por arquivo; tipos aceitos `application/pdf`, `image/jpeg`, `image/png`, `image/heic`.
**Aceite:** arquivo de 20 MB retorna `file_too_large`; `.docx` retorna `unsupported_type`; validação por magic bytes, não por extensão.

**RF-105** Detecção de emissor por heurística barata (CNPJ no texto, palavras-chave de cabeçalho, aliases) antes de qualquer chamada de modelo.
**Aceite:** em 90% do golden set o emissor é detectado sem chamada de IA.

**RF-106** Emissor não cadastrado cria `issuers` com `status=unknown` e o fluxo continua com regras genéricas.
**Aceite:** fatura de operadora regional desconhecida gera laudo, sem erro.

**RF-107** Extração: `unpdf` para PDF com texto; se `extractionQuality` < 0,6, cair para visão.
**Aceite:** PDF nativo não chama modelo de visão; PDF escaneado chama.

**RF-108** Validações determinísticas pós-extração: soma dos itens dentro de 1% do total; `periodEnd > periodStart`; `dueDate ≥ periodEnd`; nenhum item acima de 50× a mediana.
**Aceite:** JSON que falha em qualquer validação forte dispara segunda tentativa com modelo maior; falhando de novo, `status=needs_review`.

**RF-109** Mascaramento antes de gravar: CPF, CNPJ do titular, endereço, código de barras e linha digitável viram marcadores.
**Aceite:** `INV-007`. Regex de CPF não encontra ocorrência em `canonical` gravado no golden set.

**RF-110** `fileExpiresAt` = +30 dias, ou +7 dias após o fechamento do caso, o que vier antes. Job diário apaga do R2.
**Aceite:** arquivo com `fileExpiresAt` no passado não existe mais no bucket após a execução do job.

**RF-111** Ingestão por e-mail: mensagem recebida no endereço do usuário com anexo PDF entra no mesmo pipeline com `source=email`.
**Aceite:** e-mail com dois anexos gera duas faturas; anexo não-PDF é ignorado com evento registrado.

### E2 · Motor de regras

**RF-120** O motor avalia todas as regras `active` da categoria (e as do emissor) sobre a fatura, a anterior do mesmo emissor (se houver), referências e respostas já dadas pelo usuário.
**Aceite:** função pura; mesma entrada produz sempre a mesma saída; sem I/O.

**RF-121** Seis avaliadores implementados: `pattern`, `delta`, `threshold`, `reference`, `confirm`, `arithmetic`. Mais `suppressor`, que remove achados.
**Aceite:** cada tipo tem teste unitário com caso positivo e negativo.

**RF-122** Normalização antes de casar: caixa alta, remoção de acentos, `Ç→C`, colapso de espaços, remoção de números variáveis.
**Aceite:** `"Serviços de valor adicionado(SVA)"` e `"SERVICOS DE VALOR ADICIONADO (SVA)"` casam com o mesmo padrão.

**RF-123** Regra específica de emissor tem precedência sobre a genérica de mesmo `slug`.
**Aceite:** com as duas ativas, apenas o achado da específica é criado.

**RF-124** Limiar de exibição: confiança < 0,55 não vira achado visível — vira pergunta (`confirm`). De 0,55 a 0,8 exibe como "verificar". Acima de 0,8, "provável cobrança a contestar".
**Aceite:** teste com achado de confiança 0,5 não aparece no `report` e aparece como pergunta.

**RF-125** Regra nova nasce `draft`; ao ser ativada entra em `shadow` por 7 dias, gravando achados com `shadow=true` e sem exibir.
**Aceite:** achado `shadow` não aparece na resposta de `/report`; aparece no admin.

**RF-126** Promoção automática de `shadow` para `active` só se `dismissed / fired < 0,15` com pelo menos 30 disparos.
**Aceite:** job diário promove ou mantém, com evento registrado.

**RF-127** Pausa automática: regra `active` com `dismissed / fired > 0,15` em 50+ disparos passa a `paused` e gera alerta.
**Aceite:** simulação com feedback negativo pausa a regra sem intervenção.

**RF-128** Detecção de cluster: 3+ achados na mesma seção e ciclo geram um achado agregado exibido no topo do laudo.
**Aceite:** laudo com 5 SVAs mostra "R$ 51,60 em 5 serviços digitais" antes das linhas individuais.

**RF-129** Todo achado carrega `evidence` com pelo menos uma frase curta exibível e `legalBasis` com ao menos uma referência.
**Aceite:** schema valida; achado sem evidência é rejeitado no motor.

### E3 · Laudo e card

**RF-140** Laudo acessível sem cadastro, via sessão anônima em cookie assinado, validade 30 dias.
**Aceite:** navegador sem conta vê o laudo completo.

**RF-141** Progresso em tempo real por SSE, com passos nomeados e porcentagem.
**Aceite:** cliente recebe pelo menos 4 eventos distintos entre `queued` e `analyzed`.

**RF-142** Tempo até o laudo: p50 ≤ 8 s e p95 ≤ 20 s para PDF com texto; p95 ≤ 35 s para visão.
**Aceite:** medido em `ai_calls` + tempo de fila; painel mostra a série.

**RF-143** Laudo exibe: total a verificar, total em dobro quando a base legal permite, lista de achados com confiança visível, evidência em uma frase, e botão "isso eu contratei".
**Aceite:** todos os campos presentes; feedback grava evento e remove o item da vista.

**RF-144** Faturas com `needs_review` mostram mensagem honesta, sem laudo parcial inventado.
**Aceite:** tela específica com opção de reenviar foto melhor.

**RF-145** Card compartilhável gerado no servidor (`ImageResponse`), 1200×630, sem nome, CPF, número de linha ou endereço.
**Aceite:** teste visual e teste que verifica ausência de PII no payload do card.

**RF-146** Página pública do laudo em `/l/[token]` com dados anonimizados e CTA de upload. Token aleatório, revogável.
**Aceite:** acesso sem sessão funciona; revogar token retorna 404.

**RF-147** Reivindicação por e-mail migra faturas e casos da sessão anônima para o usuário.
**Aceite:** após confirmar código, `invoices.sessionId` vira `userId`, sem perda de achados.

### E4 · Contestação

**RF-160** Geração recebe entrada estruturada (achados, protocolos, prazos vencidos, playbook) e devolve `ContestDocument` validado.
**Aceite:** saída fora do schema é rejeitada e regenerada uma vez; falhando, erro claro ao usuário.

**RF-161** `legalRefs` provém dos achados, nunca do modelo.
**Aceite:** teste injeta achados com base X e verifica que só X aparece no documento.

**RF-162** Lint determinístico de termos proibidos roda antes de exibir (`INV-004`).
**Aceite:** documento contendo "advogado" é rejeitado e regenerado; teste com fixture forçada.

**RF-163** Roteiro do atendimento gerado junto, com o que dizer, o que pedir e o que anotar.
**Aceite:** `scriptForCall` com no mínimo 3 itens, incluindo pedido de protocolo e de gravação.

**RF-164** Documento editável; edição grava `userEdited=true` e mantém a versão original.
**Aceite:** as duas versões consultáveis; diff disponível no admin.

**RF-165** Checklist de anexos por etapa.
**Aceite:** etapa `consumidor_gov` lista fatura, protocolo anterior e print da conversa.

### E5 · Escalada

**RF-180** Cada caso executa um workflow durável; estado espelhado em `cases.stage`.
**Aceite:** reiniciar o serviço no meio de uma espera não perde o caso; teste com deploy simulado.

**RF-181** Prazos vêm do playbook do emissor, com cálculo correto de dias corridos e dias úteis (calendário nacional de feriados).
**Aceite:** prazo de 10 dias úteis iniciado numa quinta antes de feriado cai na data correta.

**RF-182** Ao avançar por prazo vencido, o gerador recebe `deadlinesExpired` e o texto sai com canal, protocolo e datas.
**Aceite:** documento contém a frase com número de protocolo e as duas datas.

**RF-183** Deep link por canal, com texto copiado para a área de transferência e checklist.
**Aceite:** botão copia e abre; nenhum dado é enviado ao canal pelo sistema (`INV-002`).

**RF-184** Campo de protocolo libera o token de espera do workflow e agenda o próximo prazo.
**Aceite:** POST de protocolo faz o workflow retomar em menos de 30 s.

**RF-185** Lembretes em camadas: push (app) → e-mail. Suprimidos se o usuário abriu o caso nas últimas 24 h.
**Aceite:** teste com abertura recente não dispara e-mail.

**RF-186** Caso sem protocolo por 30 dias entra em `stalled` e recebe um lembrete final; sem ação por mais 30 dias, fecha como `abandoned`.
**Aceite:** simulação temporal fecha o caso com evento.

**RF-187** Estágio `jec_ready` gera dossiê cronológico em PDF com todos os documentos, protocolos e datas.
**Aceite:** PDF abre, contém a linha do tempo completa e a lista de anexos.

### E6 · Diff e desfecho

**RF-200** Pareamento de itens entre fatura N e N+1: `normalizedDesc` exata → trigrama ≥ 0,8 → sem par.
**Aceite:** teste com variações de grafia parea corretamente.

**RF-201** Item contestado sem par na fatura seguinte é marcado como desaparecido; item de crédito com valor igual ao contestado ou ao dobro é marcado como estorno.
**Aceite:** fixtures de par de faturas com os dois casos.

**RF-202** Desfecho conservador: "desapareceu" só conta como `resolved` se havia protocolo. Sem protocolo, o sistema pergunta ao usuário.
**Aceite:** caso sem protocolo não fecha automaticamente.

**RF-203** Reabertura automática se o item voltar na fatura N+2, com histórico carimbado.
**Aceite:** caso reabre no estágio anterior ao fechamento, com evento.

**RF-204** `recoveredCents` só é somado quando `outcomeConfirmedBy = diff` e havia protocolo.
**Aceite:** métrica pública nunca inclui auto-relato sem protocolo.

### E7 · Monitor

**RF-220** Cada usuário recebe endereço de encaminhamento único.
**Aceite:** endereço exibido na conta; e-mail para ele cria fatura.

**RF-221** Previsão da próxima fatura por emissor pela mediana dos intervalos; lembrete 2 dias após a data prevista.
**Aceite:** com 3 faturas mensais, previsão fica dentro de ±3 dias.

**RF-222** Toda fatura nova roda diff contra a anterior; item novo em seção de adicionais vira pergunta de confirmação.
**Aceite:** notificação com o nome e o valor do item.

**RF-223** Resumo mensal por e-mail com total auditado, sinalizado, casos abertos e recuperado confirmado.
**Aceite:** e-mail renderiza em cliente móvel e desktop.

### E8 · Contas, privacidade e LGPD

**RF-240** Autenticação por código de e-mail, Google e Apple.
**Aceite:** os três fluxos completam; Apple obrigatório na build iOS.

**RF-241** Todo acesso a dado de usuário passa por `withUser`.
**Aceite:** `INV-008`; lint falha em query direta.

**RF-242** Exportação completa dos dados em JSON, com links assinados para arquivos ainda retidos.
**Aceite:** download contém faturas, achados, casos, documentos e eventos do usuário.

**RF-243** Exclusão de conta apaga tudo em até 24 h e grava evento de auditoria sem PII.
**Aceite:** após o job, nenhuma linha do usuário existe; evento permanece com `user_id` hasheado.

**RF-244** Tela de transparência lista as finalidades de compartilhamento com provedores de IA.
**Aceite:** texto presente e versionado.

**RF-245** Consentimento separado e destacado para uso em base agregada anônima; padrão é desligado.
**Aceite:** sem consentimento, a fatura não alimenta `aggregates`.

### E9 · Cobrança

**RF-260** Planos: `free` (1 fatura auditada/mês, 1 contestação) e `premium` (ilimitado), R$ 14,90/mês ou R$ 99/ano, trial de 14 dias com cartão.
**Aceite:** cota do grátis calculada a partir de `events`, não de contador mutável.

**RF-261** Stripe na web com Pix e cartão; webhooks assinados escrevem `entitlements`.
**Aceite:** assinatura por Pix ativa o plano; webhook com assinatura inválida é rejeitado.

**RF-262** RevenueCat no app escreve na mesma tabela; plano vale nas duas plataformas.
**Aceite:** assinar no app libera na web.

**RF-263** Falha de cobrança: 7 dias de carência com plano ativo, com aviso por push e e-mail.
**Aceite:** simulação de `payment_failed` mantém acesso e envia avisos.

**RF-264** Posição do paywall controlada por feature flag (`none | second_contest | before_contest`), padrão `none`.
**Aceite:** mudar a flag altera o comportamento sem deploy.

### E10 · SEO e páginas públicas

**RF-280** Rota `/cobranca/[issuer]/[charge]` estática com revalidação diária, conteúdo vindo de `seo_pages`.
**Aceite:** build gera as páginas publicadas; `sitemap.xml` inclui todas.

**RF-281** Dado agregado exibido apenas com `invoicesSeen ≥ 50` no período.
**Aceite:** abaixo do limite, o bloco não renderiza.

**RF-282** Página `/empresa/[issuer]` com cobranças mais sinalizadas, taxa de resolução observada e prazos do playbook.
**Aceite:** números batem com `aggregates` e `cases`.

**RF-283** OG image por página via `ImageResponse`; metadados completos; JSON-LD `FAQPage` onde houver perguntas.
**Aceite:** validação de rich results passa.

### E11 · Admin e motor adaptativo

**RF-300** Painel interno com: faturas do dia, custo de IA, regras e métricas, propostas do agente, casos parados, páginas SEO.
**Aceite:** acesso restrito por papel; ausente do sitemap e com `noindex`.

**RF-301** CRUD de regras com versionamento: editar cria nova versão, a anterior vira histórico.
**Aceite:** não existe UPDATE destrutivo em `rules.spec`.

**RF-302** Job noturno materializa `rule_metrics` a partir de `events`.
**Aceite:** recalcular o mesmo dia produz o mesmo resultado.

**RF-303** Agente semanal lê métricas e os últimos 200 eventos de feedback e grava propostas tipadas com evidência.
**Aceite:** proposta sem evidência é rejeitada pelo schema.

**RF-304** Autonomia por faixa: ajuste de confiança em ±0,1 e promoção de variante com n ≥ 100 por braço são automáticos; regra nova, base legal e prompt de contestação exigem aprovação.
**Aceite:** proposta fora da faixa fica `pending`; dentro, aplica e registra evento.

**RF-305** Item marcado como "não contratei" que não casou com nenhuma regra vira `new_rule_draft`.
**Aceite:** ocorre no job semanal, agrupando por `normalizedDesc` e emissor.

### E12 · App mobile

**RF-320** Telas: laudo, câmera com guia de enquadramento, lista de casos, detalhe do caso, conta.
**Aceite:** paridade funcional com a web para essas telas.

**RF-321** Card do laudo gerado com Skia e compartilhado pelo share nativo.
**Aceite:** imagem idêntica à da web em conteúdo.

**RF-322** Push de prazo com deep link para o caso.
**Aceite:** tocar na notificação abre o caso correto com o app fechado.

**RF-323** Requisitos de loja: página de privacidade, exclusão de conta dentro do app, login com Apple.
**Aceite:** checklist de submissão completo.

---

## 11. REQUISITOS NÃO FUNCIONAIS

| ID | Requisito | Alvo | Verificação |
|---|---|---|---|
| **RNF-01** | Tempo até o laudo (PDF texto) | p50 ≤ 8 s · p95 ≤ 20 s | Painel de latência |
| **RNF-02** | Tempo até o laudo (visão) | p95 ≤ 35 s | idem |
| **RNF-03** | LCP da landing e das páginas SEO | ≤ 2,0 s em 4G | Lighthouse CI no PR |
| **RNF-04** | CLS | ≤ 0,05 | idem |
| **RNF-05** | Bundle JS inicial da web | ≤ 120 kB gzip | `next build` com orçamento |
| **RNF-06** | Custo técnico de IA por fatura de 4 páginas | ≤ R$ 0,15 no caminho feliz | `ai_calls` agregado |
| **RNF-07** | Disponibilidade das rotas públicas | ≥ 99,5% mensal | Monitor externo |
| **RNF-08** | Perda de caso por falha de infraestrutura | zero | Workflow durável + teste de reinício |
| **RNF-09** | Acessibilidade | WCAG 2.1 AA nas telas principais | axe no CI + teste de teclado |
| **RNF-10** | Contraste e tema | Claro e escuro, tokens completos | Teste visual nos dois temas |
| **RNF-11** | Segurança de arquivo | URL assinada 5 min, validação por magic bytes, sem execução de PDF no servidor | Teste de upload malicioso |
| **RNF-12** | Segredos | Apenas em Vercel, Trigger.dev e EAS; nunca em arquivo | `gitleaks` no CI |
| **RNF-13** | Migração | Sempre compatível para trás; rollback é redeploy | Teste de migração em branch |
| **RNF-14** | Backup | PITR de 7 dias; export semanal de `rules` e `aggregates` | Restauração testada uma vez por trimestre |
| **RNF-15** | Cobertura de teste do núcleo | ≥ 90% em `packages/core` | Vitest coverage no CI |
| **RNF-16** | Extração no golden set | ≥ 95% de acerto por campo-chave | Job de CI |
| **RNF-17** | Internacionalização | pt-BR apenas; textos centralizados para permitir extração futura | Sem string literal em componente |
| **RNF-18** | Observabilidade | Todo erro com `invoiceId`/`caseId` como tag, nunca PII | Revisão de PR |

---

## 12. REGRAS DE NEGÓCIO

Formato: `RN-xxx` · condição → efeito · base.

### 12.1 Determinísticas (implementar primeiro)

**RN-001 · Base da multa em energia.** Multa não incide sobre COSIP, atividades acessórias nem penalidades anteriores. Recalcular base = total − COSIP − serviços − multas anteriores. Multa ≤ 2%; juros ≤ 1% a.m. *pro rata die*; correção por IPCA. *REN 1.000, art. 343 e §2º.*
**Aceite:** fixture com COSIP na base dispara achado com valor exato da diferença.

**RN-002 · Acerto de faturamento em energia.** Rubrica de acerto do art. 324 cobrindo mais de 3 ciclos é indevida. *REN 1.000, art. 324.*

**RN-003 · Custo de disponibilidade.** É o **maior entre** mínimo e consumo, nunca a soma. Mínimos 30 kWh (monofásico), 50 (bifásico), 100 (trifásico). Não cabe se o ciclo teve menos de 27 dias. *REN 1.000, art. 655-I.*

**RN-004 · Leitura de água.** `leituraAtual − leituraAnterior ≠ consumo`, ou atual < anterior sem troca de hidrômetro, ou `Consumo-FAT > Consumo-MED` sem rubrica que justifique. *Aritmética + NR 11/ANA/2024.*

**RN-005 · Média sem acerto em água.** Ciclos estimados seguidos de leitura real sem lançamento de ajuste. *NR 11/ANA/2024.*

**RN-006 · Encargo com fatura paga.** Juros, mora ou rotativo no ciclo N com pagamento integral e tempestivo no ciclo N−1. *CDC art. 42 p.u. + STJ Tema 929.*

**RN-007 · Teto de 100% no cartão.** Soma de juros + mora + rotativo + parcelamento (excluindo IOF) maior que o principal, para dívidas originadas a partir de 01/01/2024. *Lei 14.690/2023 + Res. CMN 5.112/2023.*

**RN-008 · Renovação cadastral.** Qualquer cobrança de tarifa de renovação de cadastro é vedada. *Circular BCB 3.466/2009.*

**RN-009 · Avaliação emergencial de crédito.** Mais de uma cobrança em 30 dias. *Res. CMN 3.919/2010.*

**RN-010 · Serviços essenciais gratuitos.** Mais de 4 saques/mês em conta corrente, 2 em poupança, 2 extratos/mês. *Res. CMN 3.919/2010.*

**RN-011 · Pacote de serviços.** Valor do pacote maior que a soma das tarifas individuais correspondentes. *Res. CMN 3.919/2010, art. 6º.*

### 12.2 Padrão e recorrência

**RN-020 · SVA em telecom.** Item em seção de serviços digitais, adicionais ou terceiros, ausente na fatura anterior ou casando com o léxico. Confiança base 0,80 (0,88 quando a seção é a âncora confirmada). *CDC art. 39 III p.u.; RGC art. 64; precedente MP-GO proc. 5223695.65.2019.8.09.0051.*

**RN-021 · Seguro embutido em cartão.** Linha recorrente, valor estável (variação < 5%), presente por 3+ ciclos, abaixo de 8% do total, casando com o léxico de seguros. Confiança base 0,72; se não casar com o léxico mas o padrão bater, vira `confirm`. *CDC art. 39 I e III; Súmula 532 STJ.*

**RN-022 · Cluster.** 3+ achados na mesma seção e ciclo geram achado agregado exibido primeiro.

**RN-023 · Assinatura recorrente por processador.** Descritor casando prefixo de processador, com mesmo valor ±2% em 3+ ciclos, é classificado como assinatura recorrente e o app mostra onde cancelar. Não é achado de cobrança indevida por si.

**RN-024 · Cobrança após cancelamento.** Item com período posterior à data de cancelamento informada pelo usuário. *Decreto 11.034 art. 14 II.*

**RN-025 · Multa e juros de atraso.** Multa > 2% ou juros > 1% a.m. *CDC art. 52 §1º.*

**RN-026 · Item duplicado.** Mesma descrição e valor duas vezes no mesmo ciclo.

### 12.3 Referência

**RN-040 · Tarifa de energia.** `(TUSD + TE) / 1000` da tabela homologada, com gross-up de tributos por dentro, comparado ao valor unitário da fatura. Tolerância ±0,5% para investigar, ±2% para sinalizar.
**Armadilhas obrigatórias:** filtrar `DscBaseTarifa = "Tarifa de Aplicação"`; unidade em R$/MWh; `tarifa_com = tarifa_sem / (1 − (pis+cofins)) / (1 − icms)`; PIS e COFINS lidos da fatura, nunca fixos; pró-rata quando houver reajuste no meio do ciclo; join por CNPJ, nunca por sigla.
**Aceite:** teste de regressão dedicado ao filtro de base tarifária.

**RN-041 · Bandeira tarifária.** Adicional ≠ valor vigente para a competência, ou aplicado em mês de bandeira verde.

**RN-042 · Tarifa social de energia.** Desde janeiro/2026 é redução de 100% até 80 kWh, não mais faixas de 65/40/10%. Fatura posterior aplicando faixas antigas é erro. *Lei 15.235/2025; REN 1.147/2025.*

### 12.4 Supressores (`INV-010`)

**RN-090 · Não sinalizar ICMS sobre TUSD/TUST.** O STJ decidiu no Tema 986 (13/03/2024) que integram a base. Modulação protege apenas quem tinha liminar sem depósito até 27/03/2017.

**RN-091 · Não sinalizar COSIP por ausência de poste.** Há precedente de que se paga mesmo sem iluminação no logradouro. A tese válida é ausência de lei municipal ou isenção legal expressa.

**RN-092 · Não sinalizar tarifa mínima de água por economia.** O STJ reviu o Tema 414 em 27/06/2024: a parcela fixa por economia é lícita. Continua ilegal tratar o condomínio como economia única e aplicar a faixa ao volume total sem dividir pelas economias.

### 12.5 Cota e plano

**RN-100 · Cota do plano grátis.** 1 fatura auditada e 1 contestação por mês corrente, contadas a partir de `events`.
**RN-101 · Trial.** 14 dias, exige cartão, cancelável a qualquer momento; ao fim sem cancelamento, cobra.
**RN-102 · Carência.** Falha de pagamento mantém acesso por 7 dias.

---

## 13. ESPECIFICAÇÃO DE INTERFACE

### 13.1 Tokens

```
--paper  #FBF8F3    --card #FFFFFF    --ink #191411
--ink-2  #54483F    --ink-3 #8A7C71   --line #E4DCD1
--mark   #C0432A  (achado, acento)    --mark-soft #FAEAE5
--ok     #1F6B4F  (resolvido)         --ok-soft #E3F0E9
--deep   #1E2A2E  (seções de confiança)
Escuro: paper #14100E · card #1D1815 · ink #F3EEE7 · mark #F0836A · ok #7ECBA4
```

Tipografia: **Fraunces** (display, `SOFT 20 / WONK 1`), **IBM Plex Sans** (texto), **IBM Plex Mono** (linhas de fatura, protocolos, valores). Números sempre `tabular-nums`.

Componentes base do shadcn/ui, com skin próprio. **Não usar o visual padrão do shadcn**, que já é reconhecível como "app de IA genérico".

### 13.2 Telas e estados

| Tela | Estados obrigatórios |
|---|---|
| Upload | vazio · arrastando · enviando (%) · erro por tipo/tamanho · duplicado (mostra laudo existente) |
| Processando | fila · lendo · conferindo · quase lá · falha |
| Laudo | com achados · sem achados · `needs_review` · com perguntas pendentes |
| Achado | verificar (0,55–0,8) · provável (>0,8) · pergunta (<0,55) · descartado pelo usuário |
| Caso | rascunho · aguardando protocolo · aguardando resposta · prazo vencido · resolvido · parado · pronto para JEC |
| Documento | gerado · editado · copiado · marcado como enviado |
| Conta | grátis · trial · premium · pagamento com falha · exclusão em andamento |

### 13.3 Regras de interface

- Nunca spinner mudo: todo processamento mostra passo nomeado.
- Confiança sempre visível junto ao achado, em linguagem simples e não em número cru.
- Valor em dobro exibido ao lado do valor cobrado, quando a base legal permitir.
- Ação destrutiva (excluir conta, revogar link) exige confirmação com digitação.
- Toda tela tem estado vazio escrito, nunca em branco.
- Foco visível em todo elemento interativo; `prefers-reduced-motion` respeitado.

---

## 14. CONTEÚDO E MICROCOPY

### 14.1 Princípios

Frases curtas. Números concretos. Zero jargão jurídico. O produto organiza, não promete. Voz de aliado competente, nunca de justiceiro.

### 14.2 Pares obrigatórios

| Dizer | Não dizer |
|---|---|
| Encontramos R$ 25,45 para você verificar | Encontramos R$ 25,45 de cobrança ilegal |
| Texto pronto para você enviar | Nós entramos com a reclamação |
| A norma prevê devolução em dobro | Você tem direito a receber em dobro |
| O prazo de 7 dias venceu sem resposta | A empresa descumpriu a lei |
| Não ficamos com nada do que você recuperar | Só cobramos se você ganhar |
| Não conseguimos ler essa fatura com segurança | Erro ao processar arquivo |

### 14.3 Lista de termos proibidos (`INV-004`)

```
advogado, advogada, advocacia, jurídico, jurídica, assessoria jurídica,
consultoria jurídica, parecer, patrocínio, representamos, em seu nome,
entraremos com, processo judicial, ação judicial, garantimos, garantia de,
vamos ganhar, você vai receber, com certeza receberá, indevido (afirmativo),
ilegal (afirmativo sobre caso concreto)
```

O lint aceita "indevido" e "ilegal" apenas em citação de norma ou em texto de terceiro (resposta da empresa), nunca como afirmação do sistema sobre o caso do usuário.

---

## 15. OBSERVABILIDADE

### 15.1 Catálogo de eventos

```ts
export const EVENTS = [
  "invoice_uploaded", "invoice_extracted", "invoice_needs_review",
  "report_viewed", "finding_dismissed", "finding_confirmed",
  "card_shared", "public_report_viewed",
  "case_created", "contest_generated", "contest_edited", "contest_marked_sent",
  "protocol_entered", "stage_advanced", "deadline_expired",
  "diff_run", "outcome_confirmed", "case_reopened",
  "monitor_email_received", "monthly_digest_sent",
  "session_claimed", "subscription_started", "subscription_failed",
  "rule_promoted", "rule_paused", "proposal_created", "proposal_decided",
] as const;
```

Nomes são contrato. Adicionar é livre; renomear exige migração de dashboards.

### 15.2 Funil principal

`invoice_uploaded → report_viewed → contest_generated → contest_marked_sent → protocol_entered → outcome_confirmed`

### 15.3 Alertas

| Alerta | Condição | Ação |
|---|---|---|
| Layout mudou | `needs_review` > 10% por emissor em 24 h | Pausar emissor, rodar golden set, avisar usuários afetados |
| Custo fora da curva | Custo médio por fatura > 2× a média de 7 dias | Verificar roteamento de modelo |
| Regra ruim | Falso positivo > 15% em 50+ disparos | Pausa automática + revisão |
| Fila atrasada | Trigger.dev com espera > 5 min | Reprocessar (idempotente) |
| Provedor de IA fora | Taxa de erro > 5% em 10 min | Roteamento para o segundo provedor |

### 15.4 Traces

Um trace por fatura cobrindo `classify → extract → validate → rules`, e um por documento gerado. Custo e latência por etapa. Prompts versionados sincronizados com a tabela `prompts`.

---

## 16. TESTES E DEFINITION OF DONE

### 16.1 Pirâmide

| Nível | Escopo | Ferramenta |
|---|---|---|
| Unitário | `packages/core`: regras, `nextStage`, diff, normalização | Vitest |
| Contrato | Schemas Zod, respostas de API | Vitest + zod |
| Golden set | Extração por emissor | Vitest + fixtures |
| Eval | Contestação, com rubrica | Langfuse |
| Integração | Workflows com prazos encurtados | Trigger.dev test mode |
| E2E web | upload → laudo → e-mail → contestação | Playwright |
| E2E app | câmera → laudo → compartilhar | Maestro |
| Visual | Componentes nos dois temas | Playwright screenshots |
| Acessibilidade | Telas principais | axe |

### 16.2 Golden set

- 10 faturas reais anonimizadas por emissor no início; meta de 50.
- Cada uma com PDF/imagem, `InvoiceCanonical` esperado e lista de achados esperados.
- Anonimização por script, preservando layout: troca CPF, nome, endereço, números de linha.
- Roda em CI. Qualquer queda de acerto bloqueia o merge.
- Contém casos **negativos**: faturas sem nenhum achado, para medir falso positivo.

### 16.3 Testes obrigatórios das invioláveis

| Teste | Verifica |
|---|---|
| `invariants/billing.spec.ts` | `INV-001` |
| `invariants/credentials.spec.ts` | `INV-002` |
| `invariants/authorship.spec.ts` | `INV-003` |
| `invariants/lint.spec.ts` | `INV-004`, `INV-005` |
| `invariants/sensitive.spec.ts` | `INV-006` |
| `invariants/masking.spec.ts` | `INV-007` |
| `invariants/with-user.spec.ts` | `INV-008` |
| `invariants/suppressors.spec.ts` | `INV-010`, `RN-090` a `RN-092` |

### 16.4 Definition of Done

Uma entrega só está pronta quando:

1. Todos os `RF-` do escopo têm teste que cobre o critério de aceite.
2. Nenhuma inviolável foi violada; a suíte `invariants/` passa.
3. Cobertura de `packages/core` ≥ 90%.
4. Golden set sem regressão.
5. Lighthouse dentro do orçamento nas rotas públicas tocadas.
6. axe sem violação crítica nas telas tocadas.
7. Migração testada em branch e compatível para trás.
8. Eventos novos adicionados ao catálogo e ao funil.
9. Texto revisado contra a lista de termos proibidos.
10. Sem segredo no repositório (`gitleaks` limpo).

---

## 17. AMBIENTES E ENTREGA

| Ambiente | Banco | Workflows | Pagamento |
|---|---|---|---|
| `dev` | Neon branch por PR | Trigger.dev dev | Stripe test |
| `staging` | Branch fixa com dados sintéticos + golden set | Trigger.dev staging | Stripe test |
| `prod` | Principal, PITR 7 dias | Trigger.dev prod | Stripe live |

**Pipeline:** lint → typecheck → unit → contrato → golden set → build → migração → deploy → smoke.
**Rollback:** redeploy da versão anterior. Migração nunca quebra a versão anterior.
**App:** EAS Update para JS; build nativo por versão de SDK.

### 17.1 Runbooks

| Situação | Procedimento |
|---|---|
| Extração de um emissor caiu | Pausar o emissor no admin → rodar golden set → ajustar prompt ou heurística → reprocessar faturas em `needs_review` |
| Provedor de IA fora | Trocar o roteamento no admin (configuração) → reprocessar fila |
| Trigger.dev atrasado | Verificar fila → reprocessar (jobs são idempotentes) |
| Regra gerando falso positivo | Pausar no admin → analisar disparos → nova versão em shadow |
| Vazamento suspeito | Revogar chaves → invalidar URLs assinadas → auditar `events` → notificar titulares se confirmado |

---

## 18. ORDEM DE EXECUÇÃO

Dependências entre épicos. Não pule a fundação.

```
E0 Fundação ──▶ E1 Ingestão ──▶ E2 Regras ──▶ E3 Laudo ──▶ E4 Contestação
                                    │                          │
                                    │                          ▼
                                    │                    E5 Escalada ──▶ E6 Diff
                                    │                                       │
                                    ▼                                       ▼
                              E11 Admin ◀────────────────────────────  E7 Monitor
                                                                            │
                    E8 Contas/LGPD ──▶ E9 Cobrança ──▶ E10 SEO ──▶ E12 App
```

| Bloco | Entrega | Pronto quando |
|---|---|---|
| **E0** | Monorepo, schema completo, `events`, Better Auth, R2 assinado, Trigger.dev, golden set inicial (10 faturas × 3 operadoras) | `pnpm test` verde e uma fatura de fixture percorre o pipeline vazio |
| **E1** | Pipeline classify → extract → validate → mask, PDF texto | RNF-16 atingido no golden set |
| **E2** | Motor com 7 avaliadores, 7 regras determinísticas, 9 de telecom, supressores, modo sombra, métricas | Suíte `invariants/suppressors` verde; regra em shadow não aparece no report |
| **E3** | Laudo sem login, SSE, card, reivindicação por e-mail | RNF-01 e RNF-03 atingidos |
| **E4** | Gerador com saída tipada, lint, roteiro, edição | Eval com rubrica ≥ 8/10; `invariants/lint` verde |
| **E5** | Workflow, playbooks de 3 emissores, protocolos, lembretes, deep links | Teste de reinício não perde caso |
| **E6** | Diff, desfecho, reabertura | Fixtures de par de faturas passam |
| **E7** | Endereço de encaminhamento, previsão de ciclo, digest | E-mail cria fatura e dispara diff |
| **E8** | Exportação, exclusão, transparência, consentimento | `invariants/masking` e `with-user` verdes |
| **E9** | Stripe com Pix, RevenueCat, cota, flags de paywall | `invariants/billing` verde |
| **E10** | 30 páginas, sitemap, OG, página de emissor | Rich results válidos |
| **E11** | Painel, CRUD versionado, métricas, agente semanal | Proposta aplicada gera evento |
| **E12** | App com laudo, câmera, casos, push, card | Checklist de loja completo |

**Marco de qualidade antes de abrir ao público:** falso positivo agregado < 15% medido em pelo menos 200 laudos reais, com leitura manual de cada descarte.

---

## 19. RISCOS TÉCNICOS

| Risco | Severidade | Mitigação |
|---|---|---|
| Falso positivo em escala | Crítico | Limiar, modo sombra, pausa automática, vocabulário de "verificar", leitura manual no piloto |
| Emissor muda layout | Alto | Schema canônico tolerante, alerta de `needs_review`, golden set por emissor |
| Alucinação de base legal | Alto | `legalRefs` vem das regras, nunca do modelo; lint; eval |
| Provedor de IA indisponível | Médio | Dois provedores com roteamento em configuração |
| Custo de IA fora da curva | Médio | Roteamento por complexidade, batch para assíncrono, alerta em 2× a média |
| Filtro errado no dataset de tarifas | Médio | Teste de regressão dedicado ao `DscBaseTarifa` |
| Perda de caso em deploy | Médio | Workflow durável; teste de reinício |
| Incidente com dado de fatura | Médio | Mascaramento na origem, retenção curta, URLs curtas, sem dado sensível |

---

## 20. ANEXOS

### 20.1 Seed inicial de emissores (telecom)

```
claro-movel · Claro Móvel · telecom · seções: ["Aplicativos Digitais"]
vivo-movel  · Vivo · telecom · seções: ["Serviços Digitais","Serviços Digitais avulsos",
              "Cobrança de Serviços de terceiros","Adicionais Contratados"]
tim-movel   · TIM · telecom · seções: ["Serviços de valor adicionado(SVA)"]
oi          · Oi · telecom · seções: ["Serviços Digitais","Outros Pacotes e Serviços Mensais"]
sky         · Sky · telecom · seções: ["lançamentos diversos"]
algar       · Algar · telecom · seções: ["Outros Valores","SERVICOS FACILIDADES","OUTRAS COBRANCAS"]
```

O léxico completo de itens, agregadoras, prefixos de processador e as camadas de regex está em `CLAUDE.md` §7. O seed de `rules` deve ser gerado a partir dele, uma regra por item confirmado, com `status=draft`.

### 20.2 Playbook de referência (telecom)

```json
{
  "stages": [
    { "stage": "sac", "channel": "SAC da operadora", "responseDays": 7,
      "businessDays": false, "requiresPreviousProtocol": false,
      "asks": ["número de protocolo",
               "suspensão imediata da cobrança contestada",
               "envio do histórico da demanda em 5 dias",
               "cópia da gravação do atendimento"],
      "legalRefs": [{ "law": "Decreto 11.034/2022", "article": "art. 13 e §3º", "effect": "suspensao" },
                    { "law": "Decreto 11.034/2022", "article": "art. 12, §2º e §3º", "effect": "limite" }] },
    { "stage": "consumidor_gov", "channel": "consumidor.gov.br",
      "deepLink": "https://www.consumidor.gov.br/pages/reclamacao/abrir",
      "responseDays": 10, "businessDays": false, "requiresPreviousProtocol": true,
      "asks": ["estorno em dobro com correção", "cancelamento com efeito imediato"],
      "legalRefs": [{ "law": "CDC", "article": "art. 42, parágrafo único", "effect": "dobro" }] },
    { "stage": "regulator", "channel": "Anatel", "responseDays": 5, "businessDays": true,
      "requiresPreviousProtocol": true,
      "asks": ["cobrança apenas da parte incontroversa", "novo boleto sem custo",
               "devolução em dobro"],
      "legalRefs": [{ "law": "Res. Anatel 765/2023", "article": "arts. 60 a 62", "effect": "suspensao" },
                    { "law": "Res. Anatel 765/2023", "article": "art. 64", "effect": "dobro" }] },
    { "stage": "jec_ready", "channel": "Juizado Especial Cível", "responseDays": 0,
      "businessDays": false, "requiresPreviousProtocol": true,
      "asks": ["dossiê cronológico completo"], "legalRefs": [] }
  ]
}
```

### 20.3 Prompt de extração (v1, imutável em espírito)

```
Você recebe o conteúdo de uma fatura brasileira.
Extraia EXATAMENTE o que está impresso, no schema fornecido.
Não interprete. Não classifique. Não julgue se algo é correto ou incorreto.
Não omita nenhum item, nem os que parecerem irrelevantes.
Preserve a grafia original das descrições, inclusive abreviações e erros.
Se um campo não estiver na fatura, omita-o em vez de inferir.
Registre em `extraction.warnings` qualquer trecho ilegível.
```

### 20.4 Rubrica de eval da contestação

| Critério | Peso |
|---|---|
| Contém todos os pedidos do playbook para a etapa | 3 |
| Cita apenas as bases legais fornecidas | 3 |
| Zero termos da lista proibida | 2 |
| Menciona protocolos e prazos vencidos quando existirem | 1 |
| Tamanho entre 200 e 4000 caracteres, tom neutro | 1 |

Aprovação: ≥ 8/10 em amostra de 20 casos por versão de prompt.

---

**Fim do PRD. Contexto de domínio, léxico completo e fontes de pesquisa estão em `CLAUDE.md`.**

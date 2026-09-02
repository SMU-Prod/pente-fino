export {
  createIngestTask, ingestErrorReason, type IngestDeps, type IngestErrorReason,
} from "./tasks/ingest.js";
export { createExpireFilesTask, type ExpireFilesDeps } from "./tasks/expire-files.js";
export { createRuleMetricsTask, type RuleMetricsDeps } from "./tasks/rule-metrics.js";
export { createRuleLifecycleTask, type RuleLifecycleDeps } from "./tasks/rule-lifecycle.js";
// `renderDossierPdf` is deliberately NOT re-exported here. Its only
// production consumer is `tasks/dossier.ts`, which imports it relatively,
// and both of its test files do the same — so keeping it off the barrel
// costs nothing and makes "pdf-lib cannot reach a browser bundle through
// `@pentefino/jobs`" a structural property rather than a fact that merely
// happens to hold. See the module header of `pdf/render-dossier.ts`.
export { createDossierTask, type DossierDeps } from "./tasks/dossier.js";

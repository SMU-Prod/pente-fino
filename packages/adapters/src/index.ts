// Composition root for @pentefino/adapters. Each port declared in
// @pentefino/core/ports gets exactly one adapter factory exported here.
// Storage is the only one implemented so far; the queue, AI and mailer
// adapters (and a composition root wiring all of them together) land in a
// later task and should be added to this same file.

export { createLocalStorage } from "./storage/local.js";

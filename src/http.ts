#!/usr/bin/env node
/* v8 ignore start */
// tool.js (T8a) supplies the real actions; eager so its module state exists
// before main() wires the server. Unresolved until T8a merges by design.
import "./modules/ocm/tool.js";
import { main } from "./modules/ocm/http-server.js";
import { errorFields, log } from "./modules/ocm/log.js";

void main().catch((error) => {
  log("error", "server.start_failed", errorFields(error));
  process.exit(1);
});
/* v8 ignore stop */

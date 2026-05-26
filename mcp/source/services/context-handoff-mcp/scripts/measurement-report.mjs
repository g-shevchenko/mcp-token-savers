#!/usr/bin/env node
import { getStats } from "../dist/store.js";

const stats = await getStats();
console.log(JSON.stringify({
  schema_version: "context-handoff.measurement.v1",
  generated_at: new Date().toISOString(),
  data_policy: {
    aggregate_only: true,
    raw_prompts_returned: false,
    raw_logs_returned: false,
    raw_code_returned: false,
  },
  stats,
}, null, 2));

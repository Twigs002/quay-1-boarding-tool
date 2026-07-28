// Loads the canonical queue-tab column contract from tests/contracts.json, which
// is transcribed from docs/CONTRACTS.md (the authoritative frozen wire). Both this
// node module and tests/contracts.py read the SAME json, so the cross-check test
// (TEST item #4) compares the real backend writer and python worker reader
// against one shared source. If CONTRACTS.md changes, update contracts.json only.
//
// Column order matters: index 0 == column A, index 1 == column B, etc.

const fs = require('fs');
const path = require('path');

const raw = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'contracts.json'), 'utf8')
);

module.exports = {
  PROVISIONING_QUEUE_COLUMNS: raw.provisioning_queue_columns,
  OFFBOARDING_QUEUE_COLUMNS: raw.offboarding_queue_columns,
  PROVISIONING_STATUS: raw.provisioning_status,
  PROVISIONING_SYSTEMS: raw.provisioning_systems,
  PROVISIONING_ACTIONS: raw.provisioning_actions,
  OFFBOARDING_STATUS: raw.offboarding_status,
  INLINE_SYSTEMS: raw.inline_systems,
  WORKER_SYSTEMS: raw.worker_systems,
  SYSTEMS_MASTER: raw.systems_master,
  OFFBOARDING_SYSTEMS_DEFAULT: raw.offboarding_systems_default,
  ENTITIES: raw.entities,
  MAX_ATTEMPTS_DEFAULT: raw.max_attempts_default,
  FIRE_DELAY_MS: raw.fire_delay_ms,
  QUEUE_ID_FORMAT: raw.queue_id_format,
  OFFB_ID_FORMAT: raw.offb_id_format,
};

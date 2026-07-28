"""Loads the canonical queue-tab column contract from tests/contracts.json.

Same source the node harness reads (docs/CONTRACTS.md), so the python worker's
reader column layout is checked against the exact same contract the backend writer
is checked against. Cross-check test = TEST item #4.
"""
import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(_HERE, "contracts.json"), encoding="utf-8") as _f:
    _RAW = json.load(_f)

PROVISIONING_QUEUE_COLUMNS = _RAW["provisioning_queue_columns"]
OFFBOARDING_QUEUE_COLUMNS = _RAW["offboarding_queue_columns"]
PROVISIONING_STATUS = _RAW["provisioning_status"]
PROVISIONING_SYSTEMS = _RAW["provisioning_systems"]
PROVISIONING_ACTIONS = _RAW["provisioning_actions"]
OFFBOARDING_STATUS = _RAW["offboarding_status"]
INLINE_SYSTEMS = _RAW["inline_systems"]
WORKER_SYSTEMS = _RAW["worker_systems"]
SYSTEMS_MASTER = _RAW["systems_master"]
OFFBOARDING_SYSTEMS_DEFAULT = _RAW["offboarding_systems_default"]
ENTITIES = _RAW["entities"]
MAX_ATTEMPTS_DEFAULT = _RAW["max_attempts_default"]
FIRE_DELAY_MS = _RAW["fire_delay_ms"]
QUEUE_ID_FORMAT = _RAW["queue_id_format"]
OFFB_ID_FORMAT = _RAW["offb_id_format"]

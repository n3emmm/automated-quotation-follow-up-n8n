# Publication verification

Checked on 2026-11-23 against the supplied GitHub archive and the tested V2 Final release.

- The workflow SHA-256 matches the tested export: `cbb6dde537b116d83587b15c382d2c1dffc4c405166c0f6eb983426f60b968bd`.
- The independent handoff omitted the Python integration driver. This package restores the original driver and includes both test suites.
- All 20 Node.js checks passed. A fresh run using the n8n 2.20.0 CLI exercised all 14 enabled nodes against local HTTP fixtures, including draft recovery and WhatsApp failure handling. See [TESTS.md](TESTS.md).
- The editor image shows a local V2 import with unconfigured credentials. The schedule, live access and WhatsApp are disabled in the release.
- Live account permissions, provider delivery and scheduled execution remain outside the scope of these tests.

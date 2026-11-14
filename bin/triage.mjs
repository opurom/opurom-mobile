#!/usr/bin/env node
// Thin CLI over lib/startup-triage.mjs: `triage <artifact-dir>` prints the
// layered startup-crash report and exits 1 only when a layer reports FAIL.
'use strict';

import { runCli } from '../lib/startup-triage.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: triage <artifact-dir> [--ir <asset-name>]');
  process.exit(2);
}
const irIndex = process.argv.indexOf('--ir');
const options = irIndex > 0 && process.argv[irIndex + 1] ? { irAsset: process.argv[irIndex + 1] } : {};
// The report exit code separates a real FAIL from a SKIP-only host run.
process.exit(runCli(dir, options));

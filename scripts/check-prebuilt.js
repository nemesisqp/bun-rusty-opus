#!/usr/bin/env node
'use strict';

/**
 * postinstall guard: fail the install when no prebuilt native binary fits
 * this machine — instead of silently succeeding and failing at first use,
 * and instead of falling back to a source build (there is none).
 *
 * Runs as the package's `postinstall` script. It only *loads* the binding;
 * it never invokes cargo / node-gyp / any compiler.
 *
 * Skipped (warning only) in a source checkout — where Cargo.toml and .git
 * are present — so developers can install deps and then `npm run build`
 * the binding themselves. Published packages do not ship Cargo.toml or
 * .git, so the check is hard there.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const isSourceCheckout = fs.existsSync(path.join(root, 'Cargo.toml')) && fs.existsSync(path.join(root, '.git'));
const skipEnv = process.env.BUN_RUSTY_OPUS_SKIP_PREBUILT_CHECK === '1';

if (skipEnv) {
  console.log('bun-rusty-opus: prebuilt check skipped (BUN_RUSTY_OPUS_SKIP_PREBUILT_CHECK=1)');
  process.exit(0);
}

try {
  require('../index.js');
  console.log('bun-rusty-opus: prebuilt native binary OK');
} catch (err) {
  console.error(`\n${err.message}\n`);
  if (isSourceCheckout) {
    console.error(
      'bun-rusty-opus: source checkout detected — continuing anyway. ' +
        'Build the binding locally with `npm run build` (or `npm run build:local` for a native-CPU build).\n',
    );
    process.exit(0);
  }
  console.error(
    'bun-rusty-opus: install failed — no prebuilt binary for this platform and ' +
      'this package does not build from source on install.\n',
  );
  process.exit(1);
}

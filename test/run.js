#!/usr/bin/env node
/**
 * Runs every test in test/ — the files named *.test.js — each in its own process, and fails
 * if any of them fails. They use in-process mocks of OpenVibe.Live and OpenVibe.Network only;
 * none of them needs the network or a running site.
 *
 *   npm test                 # everything
 *   npm test -- seo proxy    # only files whose name contains one of the words
 *   npm test -- --strict     # a skipped test fails the run too
 *
 * A test that cannot run something here prints `<label>: skipped (<why>)`: that file is listed with
 * ○ and not counted as passed (openvibe-shared/test-runner).
 */
'use strict';
require('openvibe-shared/test-runner').main({ dir: __dirname, timeoutMs: 60000, pad: 32, parallel: 1 });

/**
 * Cross-repo global model parity: 'partial' global artifacts.
 *
 * One of five per-mode entry points into the shared parity harness; the modes
 * run as separate files so the CI weighted partitioner can spread their cost
 * across unit shards (HOK-2939). See cross-repo-parity-suite.ts.
 */

import { runParityModeSuite } from './cross-repo-parity-suite.ts';

runParityModeSuite('partial');

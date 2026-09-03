// One artifact mode of the cross-repo parity suite. The modes run as separate
// registered test files so weighted CI sharding can spread their ~60-90s
// bodies across shards; see cross-repo-parity-suite.ts for the rationale.
import { runParityModeSuite } from './cross-repo-parity-suite.ts';

runParityModeSuite('partial');

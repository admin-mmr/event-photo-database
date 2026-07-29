/**
 * fakeDb.test.ts — the DocumentStore contract, run against the shared in-memory
 * fake that the rest of the test suite uses.
 *
 * The cases live in `helpers/documentStoreContract.ts` because
 * `cosmosDb.test.ts` runs the identical set against the Cosmos adapter. If the
 * fake and Cosmos ever disagree, one of them is a bug — and the tests say so
 * instead of each backend quietly asserting its own behaviour.
 */

import { runDocumentStoreContract } from './helpers/documentStoreContract.js';
import { fakeHarness } from './helpers/fakeDb.js';

runDocumentStoreContract('FakeStore', fakeHarness);

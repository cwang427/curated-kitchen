/**
 * The Worker's entry point. Everything lives in importer.ts, so the tests
 * (scripts/test-worker.ts) can import its pieces without them becoming
 * exports of the Worker itself.
 */
import { worker } from './importer'

export default worker

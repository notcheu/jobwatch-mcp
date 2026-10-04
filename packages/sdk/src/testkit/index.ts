/**
 * @jobwatch/sdk/testkit: fakes and the contract test runner for adapter packages. For tests only
 * (it imports vitest and the file system); never import it from adapter source.
 */
export {
  FakeBrowserSession,
  FakeHttpClient,
  FakeJobStore,
  FakePlatformMemory,
  createBrowserTestContext,
  createHttpTestContext,
} from './fakes';
export type { FakePage, FakeHttpRoute, RecordedRequest, CapturedLog, TestContext, TestContextOptions } from './fakes';
export { describeAdapterContract } from './contract';
export type { ContractOptions, ContractSample } from './contract';

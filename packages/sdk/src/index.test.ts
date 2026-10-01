import { describe, expect, it } from 'vitest';
import { SDK_API_VERSION } from './index';

describe('@jobwatch/sdk', () => {
  it('exposes the adapter API version as a positive integer', () => {
    expect(Number.isInteger(SDK_API_VERSION)).toBe(true);
    expect(SDK_API_VERSION).toBeGreaterThan(0);
  });
});

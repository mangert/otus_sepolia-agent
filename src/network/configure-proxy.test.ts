import { describe, expect, it, vi } from 'vitest';

import { configureOutboundProxy } from './configure-proxy.js';

describe('configureOutboundProxy', () => {
  it('передаёт типизированные настройки глобальному прокси Node.js', () => {
    const restore = vi.fn();
    const setProxy = vi.fn(() => restore);

    const result = configureOutboundProxy(
      {
        httpProxyUrl: 'http://127.0.0.1:10808',
        httpsProxyUrl: 'http://127.0.0.1:10808',
        noProxy: 'localhost,127.0.0.1',
      },
      setProxy,
    );

    expect(setProxy).toHaveBeenCalledWith({
      HTTP_PROXY: 'http://127.0.0.1:10808',
      HTTPS_PROXY: 'http://127.0.0.1:10808',
      NO_PROXY: 'localhost,127.0.0.1',
    });
    expect(result).toBe(restore);
  });

  it('ничего не меняет без настроенного прокси', () => {
    const setProxy = vi.fn(() => vi.fn());

    expect(configureOutboundProxy({}, setProxy)).toBeUndefined();
    expect(setProxy).not.toHaveBeenCalled();
  });
});

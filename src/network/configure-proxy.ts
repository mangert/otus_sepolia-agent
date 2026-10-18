import { setGlobalProxyFromEnv } from 'node:http';

import type { AppConfig } from '../config/index.js';

type ProxySetter = (proxyEnv?: NodeJS.ProcessEnv) => () => void;

/** Настраивает глобальный HTTP-прокси Node.js для исходящих запросов. */
export const configureOutboundProxy = (
  config: AppConfig['network'],
  setProxy: ProxySetter = setGlobalProxyFromEnv,
): (() => void) | undefined => {
  if (config.httpProxyUrl === undefined && config.httpsProxyUrl === undefined) {
    return undefined;
  }

  return setProxy({
    ...(config.httpProxyUrl === undefined ? {} : { HTTP_PROXY: config.httpProxyUrl }),
    ...(config.httpsProxyUrl === undefined ? {} : { HTTPS_PROXY: config.httpsProxyUrl }),
    ...(config.noProxy === undefined ? {} : { NO_PROXY: config.noProxy }),
  });
};

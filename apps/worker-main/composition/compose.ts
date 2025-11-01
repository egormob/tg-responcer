import { DialogEngine, type DialogEngineOptions } from '../core';
import { createNoopPorts, type NoopPorts } from '../adapters-noop';
import { createRateLimitToggle, type LimitsFlagKvNamespace } from '../features/limits';
import type { AiPort, MessagingPort, RateLimitPort, StoragePort } from '../ports';

export interface ComposeEnv {
  TELEGRAM_WEBHOOK_SECRET?: string;
  RATE_LIMIT_KV?: LimitsFlagKvNamespace;
}

export interface PortOverrides {
  messaging: MessagingPort;
  ai: AiPort;
  storage: StoragePort;
  rateLimit: RateLimitPort;
}

export interface ComposeOptions {
  env: ComposeEnv;
  adapters?: Partial<PortOverrides>;
  dialogOptions?: DialogEngineOptions;
  now?: () => Date;
}

export interface CompositionResult {
  dialogEngine: DialogEngine;
  ports: PortOverrides;
  webhookSecret?: string;
}

const mergePorts = (
  overrides: Partial<PortOverrides> | undefined,
  fallback: NoopPorts,
): PortOverrides => ({
  messaging: overrides?.messaging ?? fallback.messaging,
  ai: overrides?.ai ?? fallback.ai,
  storage: overrides?.storage ?? fallback.storage,
  rateLimit: overrides?.rateLimit ?? fallback.rateLimit,
});

export const composeWorker = (options: ComposeOptions): CompositionResult => {
  const noopPorts = createNoopPorts();
  const basePorts = mergePorts(options.adapters, noopPorts);

  const rateLimitPort = options.env.RATE_LIMIT_KV
    ? createRateLimitToggle({
        kv: options.env.RATE_LIMIT_KV,
        rateLimit: basePorts.rateLimit,
      })
    : basePorts.rateLimit;

  const ports: PortOverrides = {
    ...basePorts,
    rateLimit: rateLimitPort,
  };

  const dialogEngine = new DialogEngine(
    {
      messaging: ports.messaging,
      ai: ports.ai,
      storage: ports.storage,
      rateLimit: ports.rateLimit,
      now: options.now,
    },
    options.dialogOptions,
  );

  return {
    dialogEngine,
    ports,
    webhookSecret: options.env.TELEGRAM_WEBHOOK_SECRET,
  };
};

import { DialogEngine, type DialogEngineOptions } from '../core/DialogEngine';
import { createNoopPorts, type NoopPorts } from '../adapters-noop';
import type { AiPort, MessagingPort, RateLimitPort, StoragePort } from '../ports';

export interface ComposeEnv {
  TELEGRAM_WEBHOOK_SECRET?: string;
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
  const ports = mergePorts(options.adapters, noopPorts);

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

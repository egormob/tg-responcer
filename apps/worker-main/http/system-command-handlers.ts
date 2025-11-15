import type { IncomingMessage } from '../core';
import type { SystemCommandMatch } from './system-commands';

export interface RouterCommandHandlerContext {
  message: IncomingMessage;
  match: SystemCommandMatch;
  sendText(options: { text: string; route: string }): Promise<string | null>;
}

export type RouterCommandHandlerResult =
  | { kind: 'handled'; messageId?: string | null }
  | { kind: 'invalid_usage'; examples?: readonly string[] };

export type RouterCommandHandler = (
  context: RouterCommandHandlerContext,
) => Promise<RouterCommandHandlerResult>;

export const createStartCommandHandler = (): RouterCommandHandler => async ({
  message,
  sendText,
}) => {
  const firstName = message.user.firstName?.trim();
  const greeting = firstName && firstName.length > 0 ? `Привет, ${firstName}!` : 'Привет!';
  const messageId = await sendText({ text: greeting, route: 'system_start' });
  return { kind: 'handled', messageId };
};

export const createAdminStatusCommandHandler = (): RouterCommandHandler => async ({
  sendText,
}) => {
  const messageId = await sendText({ text: 'admin-ok', route: 'system_admin_status' });
  return { kind: 'handled', messageId };
};

export const createAdminCommandInvalidUsageHandler = (
  examples: readonly string[],
): RouterCommandHandler => async () => ({ kind: 'invalid_usage', examples });

import type { IncomingMessage } from '../../core';

export type SystemCommandRole = 'global' | 'scoped';

export interface SystemCommandDescriptor {
  name: string;
  bareName: string;
  roles: readonly SystemCommandRole[];
  handler: SystemCommandHandler;
}

export interface SystemCommandHandlerContext {
  command: string;
  descriptor: SystemCommandDescriptor;
  userId: string;
  allowGlobal(command: string): void;
  allowScoped(command: string, userId: string): void;
}

export type SystemCommandHandler = (context: SystemCommandHandlerContext) => void;

export interface SystemCommandRegistry {
  readonly descriptors: readonly SystemCommandDescriptor[];
  register(command: string, userId: string): void;
  isAllowed(command: string, userId?: string): boolean;
  getDescriptor(command: string): SystemCommandDescriptor | undefined;
}

export interface SystemCommandMatch {
  command: string;
  descriptor: SystemCommandDescriptor;
}

const stripCommandMention = (command: string): string => {
  const atIndex = command.indexOf('@');
  return atIndex === -1 ? command : command.slice(0, atIndex);
};

const normalizeCommandToken = (command: string): string => stripCommandMention(command.toLowerCase());

const scopedHandler: SystemCommandHandler = ({ allowScoped, command, userId }) => {
  allowScoped(command, userId);
};

const globalHandler: SystemCommandHandler = ({ allowGlobal, command }) => {
  allowGlobal(command);
};

export const SYSTEM_COMMAND_DESCRIPTORS: readonly SystemCommandDescriptor[] = [
  {
    name: '/start',
    bareName: '/start',
    roles: ['global'],
    handler: globalHandler,
  },
  {
    name: '/admin',
    bareName: '/admin',
    roles: ['scoped'],
    handler: scopedHandler,
  },
  {
    name: '/admin status',
    bareName: '/admin',
    roles: ['scoped'],
    handler: scopedHandler,
  },
  {
    name: '/export',
    bareName: '/export',
    roles: ['scoped'],
    handler: scopedHandler,
  },
  {
    name: '/broadcast',
    bareName: '/broadcast',
    roles: ['scoped'],
    handler: scopedHandler,
  },
];

const descriptorsByBareName = new Map<string, SystemCommandDescriptor[]>();
for (const descriptor of SYSTEM_COMMAND_DESCRIPTORS) {
  const existing = descriptorsByBareName.get(descriptor.bareName);
  if (existing) {
    existing.push(descriptor);
  } else {
    descriptorsByBareName.set(descriptor.bareName, [descriptor]);
  }
}

type MutableSystemCommandRegistry = SystemCommandRegistry & {
  allowGlobal(command: string): void;
  allowScoped(command: string, userId: string): void;
};

export const isCommandAllowedForRole = (
  descriptor: SystemCommandDescriptor,
  role: SystemCommandRole,
): boolean => descriptor.roles.includes(role);

export const createSystemCommandRegistry = (
  descriptors: readonly SystemCommandDescriptor[] = SYSTEM_COMMAND_DESCRIPTORS,
): SystemCommandRegistry => {
  const descriptorMap = new Map<string, SystemCommandDescriptor>();
  const globalCommands = new Set<string>();
  const scopedCommands = new Map<string, Set<string>>();

  for (const descriptor of descriptors) {
    descriptorMap.set(descriptor.name, descriptor);
  }

  const allowGlobal = (command: string) => {
    if (!descriptorMap.has(command)) {
      return;
    }

    globalCommands.add(command);
  };

  const allowScoped = (command: string, userId: string) => {
    if (!descriptorMap.has(command) || typeof userId !== 'string' || userId.length === 0) {
      return;
    }

    const existing = scopedCommands.get(command);
    if (existing) {
      existing.add(userId);
      return;
    }

    scopedCommands.set(command, new Set([userId]));
  };

  const registry: MutableSystemCommandRegistry = {
    descriptors: [...descriptorMap.values()],
    register: (command, userId) => {
      const descriptor = descriptorMap.get(command);
      if (!descriptor) {
        return;
      }

      descriptor.handler({
        command,
        descriptor,
        userId,
        allowGlobal,
        allowScoped,
      });
    },
    isAllowed: (command, userId) => {
      if (!descriptorMap.has(command)) {
        return false;
      }

      if (globalCommands.has(command)) {
        return true;
      }

      if (typeof userId === 'string' && userId.length > 0) {
        return scopedCommands.get(command)?.has(userId) ?? false;
      }

      return false;
    },
    getDescriptor: (command) => descriptorMap.get(command),
    allowGlobal,
    allowScoped,
  };

  for (const descriptor of descriptorMap.values()) {
    if (isCommandAllowedForRole(descriptor, 'global')) {
      registry.allowGlobal(descriptor.name);
    }
  }

  return registry;
};

export const normalizeCommand = (text: string): string | undefined => {
  if (typeof text !== 'string') {
    return undefined;
  }

  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) {
    return undefined;
  }

  const whitespaceIndex = trimmed.search(/\s/u);
  const commandToken = whitespaceIndex === -1 ? trimmed : trimmed.slice(0, whitespaceIndex);
  const bareName = normalizeCommandToken(commandToken);
  if (!bareName) {
    return undefined;
  }

  const argument = whitespaceIndex === -1 ? '' : trimmed.slice(whitespaceIndex).trim();
  if (argument.length === 0) {
    return bareName;
  }

  const candidates = descriptorsByBareName.get(bareName);
  if (!candidates) {
    return bareName;
  }

  const lowerArgument = argument.toLowerCase();
  for (const candidate of candidates) {
    const candidateArgument = candidate.name.slice(candidate.bareName.length).trim();
    if (candidateArgument.length === 0) {
      continue;
    }

    if (lowerArgument.startsWith(candidateArgument)) {
      return candidate.name;
    }
  }

  return bareName;
};

export const matchSystemCommand = (
  text: string,
  message: IncomingMessage,
  registry: SystemCommandRegistry,
): SystemCommandMatch | undefined => {
  const normalized = normalizeCommand(text);
  if (!normalized) {
    return undefined;
  }

  const descriptor = registry.getDescriptor(normalized);
  if (!descriptor) {
    return undefined;
  }

  const userId = typeof message.user.userId === 'string' ? message.user.userId : undefined;
  if (!registry.isAllowed(normalized, userId)) {
    return undefined;
  }

  return { command: normalized, descriptor };
};

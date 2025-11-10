export interface KnownUser {
  utmSource?: string;
}

export interface KnownUsersSnapshot {
  size: number;
  userIds: string[];
}

export interface KnownUsersCache {
  remember(userId: string, user: KnownUser): void;
  forget(userId: string): void;
  get(userId: string): KnownUser | undefined;
  clear(): number;
  snapshot(): KnownUsersSnapshot;
}

export const createKnownUsersCache = (): KnownUsersCache => {
  const knownUsers = new Map<string, KnownUser>();

  return {
    remember(userId, user) {
      knownUsers.set(userId, user);
    },
    forget(userId) {
      knownUsers.delete(userId);
    },
    get(userId) {
      return knownUsers.get(userId);
    },
    clear() {
      const cleared = knownUsers.size;
      knownUsers.clear();
      return cleared;
    },
    snapshot() {
      return {
        size: knownUsers.size,
        userIds: Array.from(knownUsers.keys()),
      };
    },
  };
};

const adminAiModes = new Map<string, 'on' | 'off'>();

export const setAdminAiMode = (userId: string | undefined, mode: 'on' | 'off') => {
  if (typeof userId !== 'string' || userId.length === 0) {
    return;
  }

  adminAiModes.set(userId, mode);
};

export const isAdminAiModeOff = (userId: string | undefined): boolean =>
  typeof userId === 'string' && adminAiModes.get(userId) === 'off';

export const resetAdminAiModes = () => adminAiModes.clear();

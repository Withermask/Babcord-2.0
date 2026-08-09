export const Permissions = Object.freeze({
  VIEW_CHANNEL: 1,
  SEND_MESSAGES: 2,
  MANAGE_MESSAGES: 4,
  MANAGE_CHANNELS: 8,
  MANAGE_ROLES: 16,
  MANAGE_SERVER: 32,
  CREATE_INVITES: 64,
  KICK_MEMBERS: 128,
  BAN_MEMBERS: 256,
  MUTE_MEMBERS: 512,
  VIEW_AUDIT_LOG: 1024,
  MANAGE_DISCOVERY: 2048,
  ADMINISTRATOR: 4096,
});

export const DEFAULT_PERMISSIONS =
  Permissions.VIEW_CHANNEL |
  Permissions.SEND_MESSAGES |
  Permissions.CREATE_INVITES;

export const ALL_PERMISSIONS = Object.values(Permissions).reduce((total, bit) => total | bit, 0);

export function hasBit(bits, permission) {
  return (Number(bits) & permission) === permission;
}

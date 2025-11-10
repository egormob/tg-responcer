const TELEGRAM_ID_HASH_PREFIX_LENGTH = 12;
const textEncoder = new TextEncoder();
const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);
const INITIAL_HASH = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
  0x5be0cd19,
]);
const WORKSPACE = new Uint32Array(64);

const rotateRight = (value: number, shift: number): number =>
  (value >>> shift) | (value << (32 - shift));

const hashToHex = (message: Uint8Array): string => {
  const paddedLength = (message.length + 9 + 63) & ~63;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(message);
  buffer[message.length] = 0x80;

  const view = new DataView(buffer.buffer);
  const bitLengthLow = (message.length << 3) >>> 0;
  const bitLengthHigh = Math.floor(message.length / 0x20000000);
  view.setUint32(paddedLength - 8, bitLengthHigh);
  view.setUint32(paddedLength - 4, bitLengthLow);

  const hash = new Uint32Array(INITIAL_HASH);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      WORKSPACE[i] = view.getUint32(offset + i * 4);
    }

    for (let i = 16; i < 64; i++) {
      const w15 = WORKSPACE[i - 15];
      const w2 = WORKSPACE[i - 2];
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      WORKSPACE[i] = (WORKSPACE[i - 16] + s0 + WORKSPACE[i - 7] + s1) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + ROUND_CONSTANTS[i] + WORKSPACE[i]) >>> 0;
      const S0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < hash.length; i++) {
    hex += hash[i].toString(16).padStart(8, '0');
  }

  return hex;
};

const hashTelegramId = (id: string): string =>
  hashToHex(textEncoder.encode(id)).slice(0, TELEGRAM_ID_HASH_PREFIX_LENGTH);

export const toTelegramIdString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'bigint') {
    return value.toString(10);
  }

  if (typeof value === 'number') {
    throw new Error('UNSAFE_TELEGRAM_ID');
  }

  return undefined;
};

export const describeTelegramIdForLogs = (
  value: unknown,
): { value: string; length: number; hash: string } | undefined => {
  const asString = toTelegramIdString(value);
  if (!asString) {
    return undefined;
  }

  return {
    value: asString,
    length: asString.length,
    hash: hashTelegramId(asString),
  };
};

export interface ApplyTelegramIdLogFieldsOptions {
  includeValue?: boolean;
}

export const applyTelegramIdLogFields = <T extends Record<string, unknown>>(
  target: T,
  field: string,
  value: unknown,
  options: ApplyTelegramIdLogFieldsOptions = {},
): T => {
  const described = describeTelegramIdForLogs(value);
  if (!described) {
    return target;
  }

  if (options.includeValue ?? true) {
    target[field] = described.value;
  }
  target[`${field}Length`] = described.length;
  target[`${field}Hash`] = described.hash;
  return target;
};

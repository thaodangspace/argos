/**
 * A dependency-free ULID (Crockford base32, 48-bit time + 80-bit randomness).
 *
 * Run ids are ULIDs so `GET /runs` sorts chronologically without a timestamp column and so two
 * runs started in the same millisecond stay distinct. Within one process the generator is
 * monotonic: calling it twice in the same millisecond increments the random component instead of
 * drawing fresh entropy, which keeps ids strictly increasing (D14).
 */

import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

let lastTime = -1;
let lastRandom: Uint8Array | undefined;

/** Encode `value` as `length` Crockford base32 characters, most significant first. */
function encode(value: bigint, length: number): string {
  let remaining = value;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    const digit = Number(remaining % 32n);
    output = `${ENCODING[digit] ?? "0"}${output}`;
    remaining /= 32n;
  }
  return output;
}

/** Increment an 80-bit big-endian byte array in place; overflow wraps (practically impossible). */
function incrementRandom(bytes: Uint8Array): Uint8Array {
  const next = Uint8Array.from(bytes);
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const current = next[index] ?? 0;
    if (current < 255) {
      next[index] = current + 1;
      return next;
    }
    next[index] = 0;
  }
  return next;
}

function randomValue(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * Generate a ULID. `now` is injectable so tests and the durable host can use the same clock as the
 * rest of the engine; production callers omit it.
 */
export function ulid(now: number = Date.now()): string {
  let time = Math.floor(now);
  if (lastRandom === undefined || time > lastTime) {
    lastRandom = Uint8Array.from(randomBytes(10));
  } else {
    // Same millisecond (or a clock that stepped backwards): stay monotonic.
    time = lastTime;
    lastRandom = incrementRandom(lastRandom);
  }
  lastTime = time;

  const timePart = encode(BigInt(time), TIME_LENGTH);
  const randomPart = encode(randomValue(lastRandom), RANDOM_LENGTH);
  return `${timePart}${randomPart}`;
}

/**
 * FR4.3: the deterministic id of a schedule fire.
 *
 * The time part is the fire time, so ids sort by fire time and a re-fired schedule keeps its id;
 * the random part comes from `seed` (the caller's hash of `uid:fireAt`), so two schedules firing at
 * the same instant never collide, and the same schedule re-firing one instant yields the same id
 * after a crash.
 *
 * It deliberately reads and writes **none** of the module state: the monotonic `lastTime` /
 * `lastRandom` pair belongs to `ulid()`, and a deterministic id that advanced it would make a
 * later manual run id sort before a fire that already happened.
 */
export function ulidFrom(timeMs: number, seed: Uint8Array): string {
  const time = Math.floor(timeMs);
  const timePart = encode(BigInt(time), TIME_LENGTH);
  const randomPart = encode(randomValue(seed.slice(0, 10)), RANDOM_LENGTH);
  return `${timePart}${randomPart}`;
}

/** Reset the monotonic state. Test-only; production never needs it. */
export function resetUlidState(): void {
  lastTime = -1;
  lastRandom = undefined;
}

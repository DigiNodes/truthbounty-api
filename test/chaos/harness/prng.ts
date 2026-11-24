import { createHash } from 'crypto';

/**
 * Deterministic Pseudo-Random Number Generator (Mulberry32).
 *
 * Guarantees identical sequence of random numbers across Node environments
 * given the same initial seed.
 */
export class DeterministicPRNG {
  private state: number;
  private readonly initialSeed: string;

  constructor(seed: number | string = 1337) {
    this.initialSeed = String(seed);
    if (typeof seed === 'string') {
      const hash = createHash('sha256').update(seed).digest('hex');
      this.state = parseInt(hash.slice(0, 8), 16) >>> 0;
    } else {
      this.state = seed >>> 0;
    }
    if (this.state === 0) {
      this.state = 1;
    }
  }

  getSeed(): string {
    return this.initialSeed;
  }

  /**
   * Returns a float in [0, 1).
   */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Returns an integer in [min, max] inclusive.
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * Returns a random item from the list deterministically.
   */
  nextChoice<T>(items: T[]): T {
    if (items.length === 0) {
      throw new Error('Cannot select choice from empty array');
    }
    const idx = this.nextInt(0, items.length - 1);
    return items[idx];
  }

  /**
   * Shuffles an array deterministically.
   */
  shuffle<T>(array: T[]): T[] {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  /**
   * Mutates a byte in a string or buffer deterministically.
   */
  corruptString(input: string): string {
    if (input.length === 0) return 'corrupted';
    const idx = this.nextInt(0, input.length - 1);
    const charCode = input.charCodeAt(idx) ^ this.nextInt(1, 255);
    return input.slice(0, idx) + String.fromCharCode(charCode) + input.slice(idx + 1);
  }
}

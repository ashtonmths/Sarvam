import { inspect } from "node:util";

/**
 * A secret that cannot be logged by accident. Every serializer a value can
 * fall into — JSON.stringify, template interpolation, console.log — yields
 * `[REDACTED]`; only `reveal()` returns the plaintext, and its call sites are
 * few enough to audit by eye.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  /** Last four characters — enough to answer "is this the key I pasted?". */
  fingerprint(): string {
    return this.#value.slice(-4);
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }

  [inspect.custom](): string {
    return "[REDACTED]";
  }
}

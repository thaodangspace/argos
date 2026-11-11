import { describe, expect, it } from "vitest";

import { canonicalJson, playbookHash, sha256Hex } from "./hash.js";

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    const value = { z: 1, a: { d: 2, b: [{ y: 3, x: 4 }] } };
    expect(canonicalJson(value)).toBe('{"a":{"b":[{"x":4,"y":3}],"d":2},"z":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("drops undefined properties like JSON.stringify and keeps null", () => {
    expect(canonicalJson({ a: undefined, b: null, c: [1, 2] })).toBe('{"b":null,"c":[1,2]}');
  });

  it("is stable for the same object", () => {
    const value = { steps: [{ id: "b" }, { id: "a" }], hash: "ignored" };
    expect(canonicalJson(value)).toBe(canonicalJson(value));
  });
});

describe("playbookHash", () => {
  const ir = { version: 1, id: "demo", steps: [{ id: "a", needs: ["b", "c"] }] };

  it("hashes the content without the hash field", () => {
    expect(playbookHash(ir)).toBe(playbookHash({ ...ir, hash: "stale" }));
    expect(playbookHash(ir)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the content changes", () => {
    expect(playbookHash({ ...ir, title: "other" })).not.toBe(playbookHash(ir));
  });

  it("uses sha256 hex", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

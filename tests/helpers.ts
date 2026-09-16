import { expect } from "bun:test";

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function loadFixture(relativePath: string): Promise<unknown> {
  const url = new URL(`../fixtures/${relativePath}`, import.meta.url);
  const text = await Bun.file(url).text();
  return JSON.parse(text) as unknown;
}

export function expectOk<T>(value: { ok: true } | { ok: false }): T {
  expect(value.ok).toBe(true);
  if (!value.ok) {
    throw new Error("expected ok result");
  }
  return value as T;
}

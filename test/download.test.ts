import { describe, expect, it } from "vitest";
import { createDownload } from "../src/web/download";

function fakeEnv() {
  const made: Blob[] = [];
  const revoked: string[] = [];
  return {
    made,
    revoked,
    urls: {
      createObjectURL: (blob: Blob) => (made.push(blob), `blob:test/${made.length}`),
      revokeObjectURL: (url: string) => void revoked.push(url),
    },
  };
}

describe("createDownload", () => {
  it("wraps the bytes in an octet-stream Blob, sets href and a safe download name, and revokes on release", async () => {
    const env = fakeEnv();
    const anchor = { href: "", download: "" };
    const bytes = new Uint8Array([9, 8, 7]);
    const dl = createDownload(bytes, "../evil.html", anchor, env.urls);
    expect(env.made).toHaveLength(1);
    expect(env.made[0]!.type).toBe("application/octet-stream");
    expect(new Uint8Array(await env.made[0]!.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    expect(anchor.href).toBe("blob:test/1");
    expect(anchor.download).toBe("evil.html");
    dl.release();
    expect(env.revoked).toEqual(["blob:test/1"]);
    expect(Array.from(bytes)).toEqual([0, 0, 0]);
    expect(anchor.href).toBe("");
    expect(anchor.download).toBe("");
    dl.release();
    expect(env.revoked).toHaveLength(1);
  });

  it("forces the type even for a hostile-looking name", () => {
    const env = fakeEnv();
    createDownload(new Uint8Array(1), "x.svg", { href: "", download: "" }, env.urls);
    expect(env.made[0]!.type).toBe("application/octet-stream");
  });
});

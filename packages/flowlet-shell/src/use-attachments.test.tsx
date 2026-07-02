import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAttachments } from "./use-attachments";

const file = (name: string, type: string, size = 1000): File => {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
};

describe("useAttachments", () => {
  beforeEach(() => {
    let n = 0;
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:${++n}`),
      revokeObjectURL: vi.fn(),
    });
  });

  it("accepts images and PDFs and rejects other types", () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.add([file("a.png", "image/png"), file("b.txt", "text/plain")]));
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]!.isImage).toBe(true);
    expect(result.current.error).toMatch(/images and PDFs/i);
  });

  it("rejects files over the size limit", () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.add([file("big.pdf", "application/pdf", 20 * 1024 * 1024)]));
    expect(result.current.attachments).toHaveLength(0);
    expect(result.current.error).toMatch(/10 MB/);
  });

  it("removes an attachment and revokes its object URL", () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.add([file("a.png", "image/png")]));
    const id = result.current.attachments[0]!.id;
    act(() => result.current.remove(id));
    expect(result.current.attachments).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("converts pending files to SDK file parts", async () => {
    const { result } = renderHook(() => useAttachments());
    act(() => result.current.add([file("a.png", "image/png")]));
    const parts = await result.current.toParts();
    expect(parts[0]).toMatchObject({ type: "file", mediaType: "image/png", filename: "a.png" });
    expect(parts[0]!.url).toMatch(/^data:/);
  });
});

import { useCallback, useEffect, useRef, useState } from "react";
import type { FileUIPart } from "ai";

/** Media types the composer accepts: common images plus PDF. */
export const ACCEPTED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
];
export const ACCEPT_ATTR = ACCEPTED_TYPES.join(",");

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_COUNT = 6;

export interface PendingAttachment {
  id: string;
  file: File;
  /** Object URL for local preview; revoked on removal. */
  url: string;
  isImage: boolean;
}

export interface UseAttachments {
  attachments: PendingAttachment[];
  error: string | null;
  add: (files: FileList | File[]) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** Read the pending files into SDK file parts (data URLs) for sending. */
  toParts: () => Promise<FileUIPart[]>;
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

let seq = 0;

/**
 * Holds the composer's pending attachments: validates type/size/count, owns the
 * preview object-URL lifecycle, and converts to SDK file parts on send.
 */
export function useAttachments(): UseAttachments {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Mirror for cleanup on unmount without re-subscribing effects to state.
  const ref = useRef<PendingAttachment[]>([]);
  ref.current = attachments;

  useEffect(() => () => ref.current.forEach((a) => URL.revokeObjectURL(a.url)), []);

  const add = useCallback((incoming: FileList | File[]) => {
    const files = Array.from(incoming);
    setError(null);
    setAttachments((prev) => {
      const next = [...prev];
      let rejected: string | null = null;
      for (const file of files) {
        if (!ACCEPTED_TYPES.includes(file.type)) {
          rejected = "Only images and PDFs can be attached.";
          continue;
        }
        if (file.size > MAX_BYTES) {
          rejected = "Files must be under 10 MB.";
          continue;
        }
        if (next.length >= MAX_COUNT) {
          rejected = `Up to ${MAX_COUNT} attachments.`;
          continue;
        }
        next.push({
          id: `att-${++seq}`,
          file,
          url: URL.createObjectURL(file),
          isImage: file.type.startsWith("image/"),
        });
      }
      if (rejected) setError(rejected);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach((a) => URL.revokeObjectURL(a.url));
      return [];
    });
    setError(null);
  }, []);

  const toParts = useCallback(async (): Promise<FileUIPart[]> => {
    return Promise.all(
      ref.current.map(async (a) => ({
        type: "file" as const,
        mediaType: a.file.type,
        filename: a.file.name,
        url: await readAsDataURL(a.file),
      })),
    );
  }, []);

  return { attachments, error, add, remove, clear, toParts };
}

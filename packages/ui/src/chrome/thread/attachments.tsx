import type { UIMessage } from "ai";

/** A picked File → an ai-SDK FileUIPart (data URL) so it can ride the turn.
    The optional `onProgress` (0..1) feeds the chip's read ring:
    attachments are now read eagerly at attach time (progress visible, failures
    surfaced per-chip with retry) instead of silently at send time. */
export function fileToPart(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<{ type: "file"; mediaType: string; filename: string; url: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    if (onProgress) {
      reader.onprogress = event => {
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
      };
    }
    reader.onload = () => {
      onProgress?.(1);
      resolve({
        type: "file",
        mediaType: file.type || "application/octet-stream",
        filename: file.name,
        url: String(reader.result),
      });
    };
    reader.readAsDataURL(file);
  });
}

/** The `.fl-att-ext` badge text — the filename's extension, bounded so a long
    or missing one still reads as a badge. */
export function fileExt(name: string | undefined): string {
  const ext = name?.match(/\.([a-z0-9]+)$/i)?.[1];
  return (ext ?? "file").slice(0, 4).toUpperCase();
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export type FilePart = Extract<UIMessage["parts"][number], { type: "file" }>;

/** A part that names a file in the user's own files rather than carrying it.
    The prefix is the workspace's frozen `/user/files` (build contract §3.1). */
export const isSavedFile = (url: string): boolean => url.startsWith("/user/files/");

/** A sent attachment in the transcript: images render as the designed
    `.fl-msg-img` thumbnail, anything else as a `.fl-msg-file` pill.

    A SAVED file is a reference, not bytes in the transcript — it lives in the
    user's own files — so its pill names it and has nothing to download. Only a
    part still carrying its own data keeps the download link. */
export function SentAttachment({ part }: { part: FilePart }) {
  const name = part.filename ?? "attachment";
  if (part.mediaType?.startsWith("image/") === true) {
    return (
      <span className="fl-msg-img">
        <img src={part.url} alt={name} />
      </span>
    );
  }
  const pill = (
    <>
      <span className="fl-att-ext" aria-hidden="true">{fileExt(part.filename)}</span>
      <span className="fl-att-name">{name}</span>
    </>
  );
  if (isSavedFile(part.url)) return <span className="fl-msg-file">{pill}</span>;
  return <a className="fl-msg-file" href={part.url} download={name}>{pill}</a>;
}

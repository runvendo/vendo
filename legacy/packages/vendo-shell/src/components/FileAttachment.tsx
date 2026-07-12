export interface FileAttachmentProps {
  mediaType: string;
  filename?: string;
  url: string;
}

/** A sent attachment rendered in the transcript: image thumbnail or file chip. */
export function FileAttachment({ mediaType, filename, url }: FileAttachmentProps) {
  if (mediaType.startsWith("image/")) {
    return (
      <a className="fl-msg-img" href={url} target="_blank" rel="noopener noreferrer">
        <img src={url} alt={filename ?? "attachment"} />
      </a>
    );
  }
  return (
    <a className="fl-msg-file" href={url} target="_blank" rel="noopener noreferrer" download={filename}>
      <span className="fl-att-ext" aria-hidden="true">{mediaType === "application/pdf" ? "PDF" : "FILE"}</span>
      <span className="fl-att-name">{filename ?? "attachment"}</span>
    </a>
  );
}

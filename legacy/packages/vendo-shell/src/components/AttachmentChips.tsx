import type { PendingAttachment } from "../use-attachments";

export interface AttachmentChipsProps {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}

/** Human file size, e.g. 240 KB / 1.4 MB. */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The preview row above the composer: image thumbnails and PDF file chips. */
export function AttachmentChips({ attachments, onRemove }: AttachmentChipsProps) {
  if (attachments.length === 0) return null;
  return (
    <div className="fl-att-chips" data-testid="attachment-chips">
      {attachments.map((a) =>
        a.isImage ? (
          <div key={a.id} className="fl-att-img">
            <img src={a.url} alt={a.file.name} />
            <button type="button" className="fl-att-rm" aria-label={`Remove ${a.file.name}`} onClick={() => onRemove(a.id)}>×</button>
          </div>
        ) : (
          <div key={a.id} className="fl-att-file">
            <span className="fl-att-ext" aria-hidden="true">PDF</span>
            <span className="fl-att-meta">
              <span className="fl-att-name">{a.file.name}</span>
              <small>{fileSize(a.file.size)}</small>
            </span>
            <button type="button" className="fl-att-rm fl-att-rm-file" aria-label={`Remove ${a.file.name}`} onClick={() => onRemove(a.id)}>×</button>
          </div>
        ),
      )}
    </div>
  );
}

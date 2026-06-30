import type { Flowlet } from "../seams/store";

export interface FlowGalleryProps {
  flows: Flowlet[];
  onOpen: (flow: Flowlet) => void;
}

export function FlowGallery({ flows, onOpen }: FlowGalleryProps) {
  if (flows.length === 0) return null;
  return (
    <div className="fl-gallery">
      {flows.map((f) => (
        <button type="button" key={f.id} className="fl-flowcard" onClick={() => onOpen(f)}>{f.name}</button>
      ))}
    </div>
  );
}

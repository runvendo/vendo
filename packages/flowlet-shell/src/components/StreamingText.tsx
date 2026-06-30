export interface StreamingTextProps {
  text: string;
  streaming?: boolean;
}

export function StreamingText({ text, streaming = false }: StreamingTextProps) {
  return (
    <span>
      {text}
      {streaming && <span className="fl-caret" aria-hidden="true" />}
    </span>
  );
}

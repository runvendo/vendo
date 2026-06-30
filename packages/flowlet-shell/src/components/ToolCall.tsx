export interface ToolCallProps {
  toolName: string;
  state: string;
}

export function ToolCall({ toolName, state }: ToolCallProps) {
  return (
    <div className="fl-tool" data-testid="tool-call">
      <span>● {toolName}</span> <span>{state}</span>
    </div>
  );
}

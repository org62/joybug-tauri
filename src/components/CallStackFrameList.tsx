import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { TruncatedSymbol } from '@/components/ui/truncated-symbol';
import { cn, LINK_VALUE_CLASS } from '@/lib/utils';

export interface CallStackFrame {
  frame_number: number;
  instruction_pointer: string;
  stack_pointer: string;
  frame_pointer: string;
  symbol_info: string | null;
}

interface CallStackFrameListProps {
  frames: CallStackFrame[];
  onClickAddress?: (address: string) => void;
  onClickMemory?: (address: string) => void;
  compact?: boolean;
  maxHeight?: number;
}

/** Monospace address that becomes a link button when a handler is provided. */
function MonoAddress({
  value,
  onClick,
}: {
  value: string;
  onClick?: (value: string) => void;
}) {
  if (!onClick) return <span className="font-mono">{value}</span>;
  return (
    <Button
      variant="link"
      className={`h-auto p-0 font-mono text-[length:inherit] ${LINK_VALUE_CLASS}`}
      onClick={() => onClick(value)}
    >
      {value}
    </Button>
  );
}

export function CallStackFrameList({ frames, onClickAddress, onClickMemory, compact, maxHeight }: CallStackFrameListProps) {
  // Two lines per frame: the title line is the symbol alone (or the raw
  // address when unresolved) and IS the frame's RIP link — it navigates to the
  // instruction pointer, so there is no separate RIP entry. SP/FP live on the
  // muted second line.
  const content = (
    <div>
      {frames.map((frame) => (
        <div
          key={frame.frame_number}
          data-testid="callstack-frame"
          className={`font-mono text-xs px-2 border-b hover:bg-muted/30 ${compact ? 'py-0' : 'py-0.5'}`}
        >
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground shrink-0">#{frame.frame_number}</span>
            <TruncatedSymbol
              // Symbol when resolved, raw address otherwise.
              text={frame.symbol_info || frame.instruction_pointer}
              className={cn('flex-1 font-medium', onClickAddress && LINK_VALUE_CLASS)}
              onClick={onClickAddress && (() => onClickAddress(frame.instruction_pointer))}
            />
          </div>
          <div className="truncate text-muted-foreground">
            SP: <MonoAddress value={frame.stack_pointer} onClick={onClickMemory} />
            {' FP: '}
            <MonoAddress value={frame.frame_pointer} onClick={onClickMemory} />
          </div>
        </div>
      ))}
    </div>
  );

  if (maxHeight) {
    return (
      <ScrollArea
        style={{ maxHeight }}
        className="overflow-hidden [&>[data-slot=scroll-area-viewport]]:!h-auto [&>[data-slot=scroll-area-viewport]]:!max-h-[inherit]"
      >
        {content}
      </ScrollArea>
    );
  }

  return content;
}

import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';

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

function formatSymbol(symbol: string | null) {
  return symbol || 'Unknown';
}

const MONO_LINK_COLOR = {
  blue: 'hover:text-blue-600 dark:hover:text-blue-400',
  green: 'hover:text-green-600 dark:hover:text-green-400',
} as const;

/** Monospace address that becomes a link button when a handler is provided. */
function MonoAddress({
  value,
  color,
  onClick,
}: {
  value: string;
  color: keyof typeof MONO_LINK_COLOR;
  onClick?: (value: string) => void;
}) {
  if (!onClick) return <span className="font-mono">{value}</span>;
  return (
    <Button
      variant="link"
      className={`h-auto p-0 font-mono text-muted-foreground cursor-pointer ${MONO_LINK_COLOR[color]}`}
      onClick={() => onClick(value)}
    >
      {value}
    </Button>
  );
}

export function CallStackFrameList({ frames, onClickAddress, onClickMemory, compact, maxHeight }: CallStackFrameListProps) {
  const content = (
    <div className={compact ? 'space-y-0' : 'space-y-1'}>
      {frames.map((frame) => (
        <div
          key={frame.frame_number}
          className={`flex items-center justify-between px-2 border-b hover:bg-gray-50 dark:hover:bg-gray-900 ${compact ? 'py-0.5' : 'py-1'}`}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-muted-foreground text-xs">#{frame.frame_number}</span>
              {onClickAddress ? (
                <Button
                  variant="link"
                  className="h-auto min-w-0 justify-start truncate p-0 font-medium text-left text-foreground hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer"
                  onClick={() => onClickAddress(frame.instruction_pointer)}
                >
                  {formatSymbol(frame.symbol_info)}
                </Button>
              ) : (
                <p className="font-medium truncate">{formatSymbol(frame.symbol_info)}</p>
              )}
            </div>
            <p className={`text-muted-foreground truncate ${compact ? 'text-[10px]' : 'text-xs'}`}>
              RIP:{' '}
              <MonoAddress value={frame.instruction_pointer} color="blue" onClick={onClickAddress} />
              {' | SP: '}
              <MonoAddress value={frame.stack_pointer} color="green" onClick={onClickMemory} />
              {' | FP: '}
              <MonoAddress value={frame.frame_pointer} color="green" onClick={onClickMemory} />
            </p>
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

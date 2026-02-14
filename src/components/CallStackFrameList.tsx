import { ScrollArea } from '@/components/ui/scroll-area';

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
                <button
                  className="font-medium truncate text-left hover:text-blue-600 dark:hover:text-blue-400 hover:underline cursor-pointer"
                  onClick={() => onClickAddress(frame.instruction_pointer)}
                >
                  {formatSymbol(frame.symbol_info)}
                </button>
              ) : (
                <p className="font-medium truncate">{formatSymbol(frame.symbol_info)}</p>
              )}
            </div>
            <p className={`text-muted-foreground truncate ${compact ? 'text-[10px]' : 'text-xs'}`}>
              RIP:{' '}
              {onClickAddress ? (
                <button
                  className="font-mono hover:text-blue-600 dark:hover:text-blue-400 hover:underline cursor-pointer"
                  onClick={() => onClickAddress(frame.instruction_pointer)}
                >
                  {frame.instruction_pointer}
                </button>
              ) : (
                <span className="font-mono">{frame.instruction_pointer}</span>
              )}
              {' | SP: '}
              {onClickMemory ? (
                <button
                  className="font-mono hover:text-green-600 dark:hover:text-green-400 hover:underline cursor-pointer"
                  onClick={() => onClickMemory(frame.stack_pointer)}
                >
                  {frame.stack_pointer}
                </button>
              ) : (
                <span className="font-mono">{frame.stack_pointer}</span>
              )}
              {' | FP: '}
              {onClickMemory ? (
                <button
                  className="font-mono hover:text-green-600 dark:hover:text-green-400 hover:underline cursor-pointer"
                  onClick={() => onClickMemory(frame.frame_pointer)}
                >
                  {frame.frame_pointer}
                </button>
              ) : (
                <span className="font-mono">{frame.frame_pointer}</span>
              )}
            </p>
          </div>
        </div>
      ))}
    </div>
  );

  if (maxHeight) {
    return (
      <ScrollArea style={{ maxHeight }}>
        {content}
      </ScrollArea>
    );
  }

  return content;
}

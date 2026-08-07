/**
 * Shared component for displaying dereference chains
 * Used by both RegisterView and HexView for consistent styling
 */

import { DereferenceEntry, DereferenceValue } from "@/lib/hexUtils";
import { CopyTooltipContent, MiddleTruncate } from "@/components/ui/truncated-symbol";
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface DereferenceDisplayProps {
  entry: DereferenceEntry | undefined;
  /**
   * If true, skip the first chain item (used when pointer value is already shown, like in HexView).
   * If false, show all chain items (used in RegisterView where we want to see what the register points to).
   */
  skipFirst?: boolean;
  /** Maximum number of chain items to display */
  maxItems?: number;
}

/**
 * Format a single dereference value for display
 */
function formatValue(value: DereferenceValue): string {
  switch (value.type) {
    case 'Pointer':
      const addr = value.address.replace(/^0x0+/, '0x');
      if (value.symbol) {
        return `${addr} (${value.symbol})`;
      }
      return addr;
    case 'Value':
      return value.value;
    case 'String':
      return value.value;
    case 'Instruction':
      if (value.symbol) {
        return `(${value.symbol}) <${value.value}>`;
      }
      return `<${value.value}>`;
    case 'LoopDetected':
      return '[loop]';
  }
}

/**
 * Get symbol from first chain item if it's a pointer with symbol
 */
function getSymbol(chain: DereferenceValue[]): string | null {
  if (chain.length === 0) return null;
  const first = chain[0];
  if (first.type === 'Pointer' && first.symbol) {
    return first.symbol;
  }
  return null;
}

/**
 * Component to display a dereference chain with consistent styling
 */
export function DereferenceDisplay({ entry, skipFirst = false, maxItems = 4 }: DereferenceDisplayProps) {
  if (!entry || entry.chain.length === 0) {
    return null;
  }

  const chain = entry.chain;
  // skipFirst drops the chain's leading element because the caller already shows
  // the raw slot value. When the target is executable but unreadable the backend
  // emits no Pointer element and the chain starts directly with an Instruction —
  // nothing is duplicated then, so there is nothing to skip.
  const startIndex = skipFirst && chain[0]?.type !== 'Instruction' ? 1 : 0;

  // If we skipped the leading pointer and it carried a symbol, show it in parens
  const symbol = startIndex > 0 ? getSymbol(chain) : null;

  // Build the chain string
  const items: string[] = [];
  for (let i = startIndex; i < Math.min(chain.length, startIndex + maxItems); i++) {
    const value = chain[i];
    if (!value) break;
    items.push(formatValue(value));
  }

  const hasMore = chain.length > startIndex + maxItems;
  const chainStr = items.join(' \u2192 ') + (hasMore ? ' \u2192 ...' : '');
  // Tooltip always shows the complete chain from the beginning
  const fullChain = chain.map(formatValue).join(' \u2192 ');

  if (!symbol && !chainStr) {
    return null;
  }

  // Determine if we need a leading arrow:
  // - skipFirst=true (hex view): always need arrow (showing what the displayed pointer points to)
  // - skipFirst=false (register view): need arrow unless first item is Instruction (register IS the instruction)
  const firstItem = chain[0];
  const needsLeadingArrow = skipFirst || (firstItem && firstItem.type !== 'Instruction');

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-muted-foreground text-xs inline-flex items-center gap-1 min-w-0 cursor-default">
            {symbol && <MiddleTruncate text={`(${symbol})`} />}
            {chainStr && (
              <span className="truncate">
                {needsLeadingArrow && '\u2192 '}{chainStr}
              </span>
            )}
          </span>
        </TooltipTrigger>
        <CopyTooltipContent text={fullChain} label="Chain" />
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Simplified display for register view - shows full chain from index 0
 */
export function RegisterDereferenceDisplay({ entry, maxItems = 4 }: { entry: DereferenceEntry | undefined; maxItems?: number }) {
  return <DereferenceDisplay entry={entry} skipFirst={false} maxItems={maxItems} />;
}

/**
 * Display for hex view pointer mode - skips first item since pointer value is already shown
 */
export function PointerDereferenceDisplay({ entry, maxItems = 8 }: { entry: DereferenceEntry | undefined; maxItems?: number }) {
  return <DereferenceDisplay entry={entry} skipFirst={true} maxItems={maxItems} />;
}

import { Button } from '@/components/ui/button';
import { PanelFooter } from '@/components/ui/panel';
import { ChevronLeft, ChevronRight } from 'lucide-react';

// Prev/next pager fixed under scan-result panels. Renders nothing while
// everything fits on one page.
export function PaginationFooter({ currentPage, totalPages, totalCount, onPageChange }: {
  currentPage: number; totalPages: number; totalCount: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <PanelFooter className="justify-between text-xs text-muted-foreground">
      <Button
        size="icon-xs"
        variant="ghost"
        disabled={currentPage === 0}
        onClick={() => onPageChange(currentPage - 1)}
      >
        <ChevronLeft />
      </Button>
      <span>
        Page {currentPage + 1} of {totalPages} ({totalCount.toLocaleString()} total)
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        disabled={currentPage >= totalPages - 1}
        onClick={() => onPageChange(currentPage + 1)}
      >
        <ChevronRight />
      </Button>
    </PanelFooter>
  );
}

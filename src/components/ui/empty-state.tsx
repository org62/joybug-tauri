import * as React from 'react';

// Centered icon + title + subtitle, shared by every non-results panel state.
export function EmptyState({ icon, title, subtitle, danger }: {
  icon: React.ReactNode; title: string; subtitle?: React.ReactNode; danger?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
      <div className="text-center">
        {icon}
        <p className="text-base font-medium">{title}</p>
        {subtitle != null && <p className={`text-sm mt-1${danger ? ' text-destructive' : ''}`}>{subtitle}</p>}
      </div>
    </div>
  );
}

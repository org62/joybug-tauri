import { Input } from "./input";

/**
 * In-row inline editor (20px `inputSize="inline"`): commits on Enter/blur,
 * cancels on Escape. Keyboard and click events don't propagate, so it can sit
 * inside clickable rows/headers. The caller owns the draft state.
 */
export function InlineEditInput({
  value,
  onChange,
  onCommit,
  onCancel,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={onCommit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onCommit();
        if (e.key === "Escape") onCancel();
      }}
      inputSize="inline"
      placeholder={placeholder}
      className={className}
    />
  );
}

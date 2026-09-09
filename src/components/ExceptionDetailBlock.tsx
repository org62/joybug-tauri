import { CallStackFrameList } from "@/components/CallStackFrameList";
import { HoverPopupPanel } from "@/components/ui/hover-popup";
import type { HoverPopupState } from "@/hooks/useHoverPopup";
import type { ExceptionDetail } from "@/contexts/SessionContext";
import { formatExceptionCode } from "@/lib/exceptionNames";

/**
 * The decoded record as label/value pairs, in display order. The single source
 * for both renderings — the popup grid below and the Logs page's flattened
 * virtual rows — so a new decoded field shows up in both. `includeCode` adds
 * the code and chance rows that the log line already carries in its message.
 */
export function exceptionFields(detail: ExceptionDetail, includeCode: boolean): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  if (includeCode) {
    fields.push(["code", `${detail.name ?? ""} ${formatExceptionCode(detail.code)}`.trim()]);
    fields.push(["chance", detail.first_chance ? "first" : "second"]);
  }
  fields.push(["at", detail.address_symbol ? `${detail.address_symbol} (${detail.address})` : detail.address]);
  if (detail.access_clause) fields.push(["memory", detail.access_clause]);
  if (detail.nt_status != null) fields.push(["status", formatExceptionCode(detail.nt_status)]);
  if (detail.parameters.length > 0) fields.push(["params", detail.parameters.join(" ")]);
  return fields;
}

interface ExceptionDetailBlockProps {
  detail: ExceptionDetail;
  /** Frame click → navigate; omitted renders plain text (e.g. the Logs page). */
  onClickAddress?: (address: string) => void;
}

/**
 * The decoded exception record as a compact key/value block followed by its
 * captured callstack. Shared by the session header badge popup and the Logs
 * page hover popup so both read the same way.
 */
export function ExceptionDetailBlock({ detail, onClickAddress }: ExceptionDetailBlockProps) {
  return (
    <div data-testid="exception-detail" className="text-xs font-mono">
      <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 mb-1 pb-1 border-b border-border/50">
        {exceptionFields(detail, true).map(([k, v]) => (
          <div key={k} className="contents">
            <span className="text-muted-foreground">{k}</span>
            <span className="break-all">{v}</span>
          </div>
        ))}
      </div>
      {detail.callstack.length > 0 ? (
        <CallStackFrameList frames={detail.callstack} compact maxHeight={220} onClickAddress={onClickAddress} />
      ) : (
        <div className="text-muted-foreground">No callstack captured.</div>
      )}
    </div>
  );
}

interface ExceptionHoverPopupProps {
  popup: HoverPopupState<ExceptionDetail>;
  testId: string;
  onClickAddress?: (address: string) => void;
  /** Optional prose above the record (the program-single-step warning). */
  header?: React.ReactNode;
}

/** The hover popup wrapper around `ExceptionDetailBlock`, sized identically
 *  wherever an exception record is hovered. Renders nothing while closed. */
export function ExceptionHoverPopup({ popup, testId, onClickAddress, header }: ExceptionHoverPopupProps) {
  if (!popup.target) return null;
  return (
    <HoverPopupPanel
      data-testid={testId}
      x={popup.pos.x}
      y={popup.pos.y}
      width={480}
      height={360}
      className="w-[480px]"
      {...popup.popupProps}
    >
      {header && <div className="mb-1 pb-1 border-b border-border/50 font-sans whitespace-normal">{header}</div>}
      <ExceptionDetailBlock detail={popup.target} onClickAddress={onClickAddress} />
    </HoverPopupPanel>
  );
}

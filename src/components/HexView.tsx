import { useState, useRef, KeyboardEvent } from "react";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Binary, RefreshCw, Save, X, ArrowRight } from "lucide-react";
import { useHexEditor } from "@/hooks/useHexEditor";
import {
  ViewMode,
  VIEW_MODE_CONFIGS,
  formatAddress,
  byteToAscii,
  BYTES_PER_ROW,
  RegisterContext,
  SymbolResolver,
} from "@/lib/hexUtils";

interface HexViewProps {
  sessionId?: string;
  memoryViewId?: string;
  sessionStatus?: string;
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
  initialAddress?: bigint;
}

export function HexView({ sessionId, memoryViewId = 'memory', sessionStatus, registers = {}, resolveSymbol, initialAddress }: HexViewProps) {
  const {
    baseAddress,
    memoryData,
    viewMode,
    isLoading,
    error,
    selectedOffset,
    editingOffset,
    pendingChanges,
    littleEndian,
    goToAddress,
    refresh,
    setViewMode,
    startEdit,
    commitEdit,
    cancelEdit,
    applyPendingChanges,
    discardPendingChanges,
    setSelectedOffset,
  } = useHexEditor({ sessionId, memoryViewId, sessionStatus, registers, resolveSymbol, initialAddress });

  const [addressInput, setAddressInput] = useState("");
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  // Handle goto address
  const handleGoto = () => {
    if (addressInput.trim()) {
      goToAddress(addressInput.trim());
      setAddressInput("");
    }
  };

  // Handle enter key in address input
  const handleAddressKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleGoto();
    }
  };

  // Start editing a cell
  const handleCellDoubleClick = (offset: number) => {
    const config = VIEW_MODE_CONFIGS[viewMode];
    const bytes = memoryData.slice(offset, offset + config.bytesPerUnit);
    if (bytes.length === config.bytesPerUnit) {
      setEditValue(config.formatValue(bytes, littleEndian));
      startEdit(offset);
      // Focus input after render
      setTimeout(() => editInputRef.current?.focus(), 0);
    }
  };

  // Handle edit input key events
  const handleEditKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      commitEdit(editValue);
    } else if (e.key === "Escape") {
      cancelEdit();
    }
  };

  // Calculate rows
  const config = VIEW_MODE_CONFIGS[viewMode];
  const unitsPerRow = Math.floor(BYTES_PER_ROW / config.bytesPerUnit);
  const totalRows = Math.ceil(memoryData.length / BYTES_PER_ROW);

  // Empty state
  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <div className="text-center">
          <Binary className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p className="text-base font-medium">No session active</p>
          <p className="text-sm mt-1">Memory view will appear when debugging</p>
        </div>
      </div>
    );
  }

  // Check if session is active (can interact with memory)
  const isSessionActive = sessionStatus === 'Running' || sessionStatus === 'Paused';

  if (memoryData.length === 0 && !isLoading && !error) {
    // If session is active, show toolbar so user can enter address
    if (isSessionActive) {
      return (
        <div className="absolute inset-0 flex flex-col overflow-hidden">
          <div className="shrink-0">
            <HexToolbar
              addressInput={addressInput}
              setAddressInput={setAddressInput}
              handleAddressKeyDown={handleAddressKeyDown}
              handleGoto={handleGoto}
              viewMode={viewMode}
              setViewMode={setViewMode}
              refresh={refresh}
              isLoading={isLoading}
              pendingChanges={pendingChanges}
              applyPendingChanges={applyPendingChanges}
              discardPendingChanges={discardPendingChanges}
            />
          </div>
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
            <div className="text-center">
              <Binary className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-base font-medium">No memory loaded</p>
              <p className="text-sm mt-1">Enter an address above to view memory</p>
            </div>
          </div>
        </div>
      );
    }

    // Session is stopped - show simple empty state
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <div className="text-center">
          <Binary className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p className="text-base font-medium">No memory loaded</p>
          <p className="text-sm mt-1">Start debugging to view memory</p>
        </div>
      </div>
    );
  }

  if (error) {
    // Show toolbar so user can try a different address
    return (
      <div className="absolute inset-0 flex flex-col overflow-hidden">
        <div className="shrink-0">
          <HexToolbar
            addressInput={addressInput}
            setAddressInput={setAddressInput}
            handleAddressKeyDown={handleAddressKeyDown}
            handleGoto={handleGoto}
            viewMode={viewMode}
            setViewMode={setViewMode}
            refresh={refresh}
            isLoading={isLoading}
            pendingChanges={pendingChanges}
            applyPendingChanges={applyPendingChanges}
            discardPendingChanges={discardPendingChanges}
          />
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
          <div className="text-center">
            <Binary className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Could not load memory</p>
            <p className="text-sm mt-1">{error}</p>
            <p className="text-sm mt-2">Try a different address</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {/* Toolbar - Fixed */}
      <div className="shrink-0">
        <HexToolbar
          addressInput={addressInput}
          setAddressInput={setAddressInput}
          handleAddressKeyDown={handleAddressKeyDown}
          handleGoto={handleGoto}
          viewMode={viewMode}
          setViewMode={setViewMode}
          refresh={refresh}
          isLoading={isLoading}
          pendingChanges={pendingChanges}
          applyPendingChanges={applyPendingChanges}
          discardPendingChanges={discardPendingChanges}
        />
      </div>

      {/* Column Header - Fixed */}
      <div className="shrink-0 font-mono text-sm px-2 pt-2 pb-1 border-b border-border text-muted-foreground text-xs">
        <div className="flex items-center">
          <span className="w-36 shrink-0">Address</span>
          <span className="flex-1">Hex</span>
          <span className="w-[136px] shrink-0 text-right pr-2">ASCII</span>
        </div>
      </div>

      {/* Hex Data - Scrollable */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="font-mono text-sm p-2 pt-1">
          {/* Rows */}
          {Array.from({ length: totalRows }).map((_, rowIndex) => {
            const rowOffset = rowIndex * BYTES_PER_ROW;
            const rowAddress = baseAddress + BigInt(rowOffset);
            const rowBytes = memoryData.slice(rowOffset, rowOffset + BYTES_PER_ROW);

            return (
              <div
                key={rowIndex}
                className="flex items-center hover:bg-muted/30 py-0.5"
              >
                {/* Address column */}
                <span className="w-36 shrink-0 text-muted-foreground text-xs">
                  {formatAddress(rowAddress)}
                </span>

                {/* Hex values column */}
                <div className="flex-1 flex flex-wrap gap-x-1">
                  {Array.from({ length: unitsPerRow }).map((_, unitIndex) => {
                    const unitOffset = rowOffset + unitIndex * config.bytesPerUnit;
                    const unitBytes = memoryData.slice(
                      unitOffset,
                      unitOffset + config.bytesPerUnit
                    );

                    if (unitBytes.length < config.bytesPerUnit) {
                      return (
                        <span
                          key={unitIndex}
                          className="text-muted-foreground/30"
                          style={{ width: `${config.displayWidth}ch` }}
                        >
                          {"".padEnd(config.displayWidth, "-")}
                        </span>
                      );
                    }

                    const isSelected = selectedOffset === unitOffset;
                    const isEditing = editingOffset === unitOffset;
                    const hasPendingChange = Array.from(
                      { length: config.bytesPerUnit },
                      (_, i) => pendingChanges.has(unitOffset + i)
                    ).some(Boolean);

                    if (isEditing) {
                      return (
                        <Input
                          key={unitIndex}
                          ref={editInputRef}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value.toUpperCase())}
                          onKeyDown={handleEditKeyDown}
                          onBlur={() => cancelEdit()}
                          className="h-5 px-0.5 text-xs font-mono border-primary"
                          style={{ width: `${config.displayWidth + 1}ch` }}
                        />
                      );
                    }

                    return (
                      <span
                        key={unitIndex}
                        className={`cursor-pointer rounded px-0.5 ${
                          isSelected
                            ? "bg-primary text-primary-foreground"
                            : hasPendingChange
                            ? "bg-yellow-200 dark:bg-yellow-800"
                            : "hover:bg-muted/50"
                        }`}
                        style={{ width: `${config.displayWidth}ch` }}
                        onClick={() => setSelectedOffset(unitOffset)}
                        onDoubleClick={() => handleCellDoubleClick(unitOffset)}
                      >
                        {config.formatValue(unitBytes, littleEndian)}
                      </span>
                    );
                  })}
                </div>

                {/* ASCII column */}
                <span className="w-[136px] shrink-0 text-right pr-2 text-muted-foreground">
                  {Array.from(rowBytes)
                    .map((byte, i) => {
                      const offset = rowOffset + i;
                      const hasPending = pendingChanges.has(offset);
                      const char = byteToAscii(byte);
                      if (hasPending) {
                        return (
                          <span key={i} className="bg-yellow-200 dark:bg-yellow-800">
                            {char}
                          </span>
                        );
                      }
                      return char;
                    })}
                </span>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Status Bar - Fixed */}
      <div className="shrink-0">
        <HexStatusBar
          baseAddress={baseAddress}
          memoryData={memoryData}
          selectedOffset={selectedOffset}
          pendingChanges={pendingChanges}
          isLoading={isLoading}
        />
      </div>
    </div>
  );
}

// Toolbar component
interface HexToolbarProps {
  addressInput: string;
  setAddressInput: (value: string) => void;
  handleAddressKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  handleGoto: () => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  refresh: () => void;
  isLoading: boolean;
  pendingChanges: Map<number, number>;
  applyPendingChanges: () => void;
  discardPendingChanges: () => void;
}

function HexToolbar({
  addressInput,
  setAddressInput,
  handleAddressKeyDown,
  handleGoto,
  viewMode,
  setViewMode,
  refresh,
  isLoading,
  pendingChanges,
  applyPendingChanges,
  discardPendingChanges,
}: HexToolbarProps) {
  return (
    <div className="flex items-center gap-2 p-2 border-b border-border bg-muted/30">
      {/* Address input */}
      <div className="flex items-center gap-2">
        <Input
          placeholder="rsp, rax+0x10, symbol..."
          value={addressInput}
          onChange={(e) => setAddressInput(e.target.value)}
          onKeyDown={handleAddressKeyDown}
        />
        <Button
          variant="outline"
          onClick={handleGoto}
          title="Go to address"
        >
          <ArrowRight />
          <span>Go</span>
        </Button>
      </div>

      {/* View mode selector */}
      <Select value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="byte">Byte</SelectItem>
          <SelectItem value="word">Word</SelectItem>
          <SelectItem value="dword">DWord</SelectItem>
          <SelectItem value="qword">QWord</SelectItem>
          <SelectItem value="float">Float</SelectItem>
          <SelectItem value="pointer">Pointer</SelectItem>
        </SelectContent>
      </Select>

      {/* Refresh */}
      <Button
        variant="outline"
        onClick={refresh}
        disabled={isLoading}
        title="Refresh memory"
      >
        <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
      </Button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Pending changes actions */}
      {pendingChanges.size > 0 && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-yellow-600 dark:text-yellow-400">
            {pendingChanges.size} pending
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={applyPendingChanges}
            className="h-7 px-2 rounded-sm"
            title="Apply changes"
          >
            <Save className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={discardPendingChanges}
            className="h-7 px-2 rounded-sm"
            title="Discard changes"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

// Status bar component
interface HexStatusBarProps {
  baseAddress: bigint;
  memoryData: Uint8Array;
  selectedOffset: number | null;
  pendingChanges: Map<number, number>;
  isLoading: boolean;
}

function HexStatusBar({
  baseAddress,
  memoryData,
  selectedOffset,
  pendingChanges,
  isLoading,
}: HexStatusBarProps) {
  const endAddress = baseAddress + BigInt(memoryData.length);

  return (
    <div className="flex items-center gap-4 px-2 py-1 border-t border-border bg-muted/30 text-xs text-muted-foreground">
      {/* Address range */}
      <span>
        {formatAddress(baseAddress)} - {formatAddress(endAddress)}
      </span>

      {/* Size */}
      <span>{memoryData.length} bytes</span>

      {/* Selected offset */}
      {selectedOffset !== null && (
        <span>
          Selected: {formatAddress(baseAddress + BigInt(selectedOffset))} (offset +0x
          {selectedOffset.toString(16).toUpperCase()})
        </span>
      )}

      {/* Loading indicator */}
      {isLoading && <span className="text-primary">Loading...</span>}

      {/* Pending changes count */}
      {pendingChanges.size > 0 && (
        <span className="text-yellow-600 dark:text-yellow-400">
          {pendingChanges.size} unsaved changes
        </span>
      )}
    </div>
  );
}

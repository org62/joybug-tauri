import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toastError } from '@/lib/logger';
import {
  parseAddressExpression,
  RegisterContext,
  SymbolResolver,
} from '@/lib/hexUtils';
import { formatTauriError } from '@/lib/sessionHelpers';
import { useNavigationChannel } from '@/hooks/useNavigationChannel';
import { disassemblyNavigation } from '@/lib/navigationStore';

// Instruction interface matching backend SerializableInstruction
export interface Instruction {
  address: string;
  symbol: string;
  bytes: string;
  mnemonic: string;
  op_str: string;
  is_jump: boolean;
  is_call: boolean;
  is_ret: boolean;
  jump_target: string | null;
  is_patched?: boolean;
}

// Expected when the session is running or mid-teardown — not a user-facing
// failure; the view clears itself on session end.
const isBenignStateError = (msg: string) =>
  msg.includes('InvalidSessionState') || msg.includes('must be paused');

// Event payloads from Tauri
interface FunctionDisassemblyResult {
  session_id: string;
  address: number;
  instructions: Instruction[];
  function_start: string | null;
  function_end: string | null;
  function_name: string | null;
}

interface FunctionDisassemblyError {
  session_id: string;
  address: number;
  error: string;
}

// Settings stored in localStorage
interface AssemblyViewSettings {
  showBytes: boolean;
}

const SETTINGS_KEY = 'assembly-view-settings';
const MAX_HISTORY_SIZE = 50;
// Fallback limit when function bounds aren't available
// The backend will use actual function bounds when possible
const DEFAULT_MAX_INSTRUCTIONS = 2000;

function loadSettings(): AssemblyViewSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load assembly view settings:', e);
  }
  return { showBytes: true };
}

function saveSettings(settings: AssemblyViewSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save assembly view settings:', e);
  }
}

export interface AssemblyViewState {
  instructions: Instruction[];
  currentAddress: bigint | null;
  pcAddress: bigint | null;
  functionStart: bigint | null;
  functionEnd: bigint | null;
  functionName: string | null;
  isLoading: boolean;
  error: string | null;
  showBytes: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  // Address to highlight temporarily (after navigation)
  jumpTargetAddress: bigint | null;
}

export interface AssemblyViewActions {
  goToAddress: (expression: string) => Promise<void>;
  goToAddressDirect: (address: bigint) => void;
  scrollToAddressInView: (address: bigint) => void;
  goBack: () => void;
  goForward: () => void;
  refresh: () => void;
  toggleBytesColumn: () => void;
  scrollToPC: () => void;
}

export interface UseAssemblyViewOptions {
  sessionId: string | undefined;
  isPaused?: boolean;
  pcAddress?: number; // Current PC from debug event
  registers?: RegisterContext;
  resolveSymbol?: SymbolResolver;
  /** Changes when a module's symbols finish loading in the background; triggers
   * a refresh so raw addresses upgrade to symbol names. */
  symbolsRefreshKey?: string;
}

export function useAssemblyView(options: UseAssemblyViewOptions): AssemblyViewState & AssemblyViewActions {
  const { sessionId, isPaused, pcAddress: pcAddressProp, registers = {}, resolveSymbol, symbolsRefreshKey } = options;

  // State
  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [currentAddress, setCurrentAddress] = useState<bigint | null>(null);
  const [functionStart, setFunctionStart] = useState<bigint | null>(null);
  const [functionEnd, setFunctionEnd] = useState<bigint | null>(null);
  const [functionName, setFunctionName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBytes, setShowBytes] = useState(() => loadSettings().showBytes);
  // Address to highlight temporarily after navigation (for jump targets)
  const [jumpTargetAddress, setJumpTargetAddress] = useState<bigint | null>(null);

  // Navigation history
  const [navigationHistory, setNavigationHistory] = useState<bigint[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Refs
  const lastRequestedAddress = useRef<bigint | null>(null);
  const requestInFlight = useRef(false);
  const scrollToPCRef = useRef<(() => void) | null>(null);
  // Track the last PC we auto-navigated to, to detect when PC actually changes (stepping)
  const lastAutoPcAddress = useRef<bigint | null>(null);
  // Track if user manually navigated away from PC
  const userNavigatedAway = useRef<boolean>(false);

  // Derived PC address
  const pcAddress = pcAddressProp != null ? BigInt(pcAddressProp) : null;

  // Computed
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < navigationHistory.length - 1;

  // Load disassembly for an address
  const loadDisassembly = useCallback(async (address: bigint) => {
    if (!sessionId) return;

    // Skip duplicate request if already loading the same address
    if (lastRequestedAddress.current === address && requestInFlight.current) return;

    lastRequestedAddress.current = address;
    requestInFlight.current = true;
    setIsLoading(true);
    setError(null);

    try {
      await invoke('request_function_disassembly', {
        sessionId,
        address: Number(address),
        maxInstructions: DEFAULT_MAX_INSTRUCTIONS,
      });
      setCurrentAddress(address);
    } catch (err) {
      const errorMessage = formatTauriError(err);
      if (!isBenignStateError(errorMessage)) {
        console.error('Failed to request function disassembly:', err);
        setError(errorMessage);
        toastError(`Failed to request disassembly: ${errorMessage}`, sessionId);
      }
      requestInFlight.current = false;
      setIsLoading(false);
    }
  }, [sessionId]);

  // Go to address with history management
  // isAutoNavigation: true when called by the PC-following effect, false for user actions
  const goToAddressDirect = useCallback((address: bigint, isAutoNavigation = false) => {
    // Mark that user navigated away from PC (unless this is auto-navigation)
    if (!isAutoNavigation) {
      userNavigatedAway.current = true;
      // Set jump target for highlighting and scrolling
      setJumpTargetAddress(address);
    } else {
      // Auto-navigation (following PC) - no jump target highlight
      setJumpTargetAddress(null);
    }

    // Add to history
    setNavigationHistory(prev => {
      // Truncate forward history if we're not at the end
      const truncated = prev.slice(0, historyIndex + 1);
      // Add new address
      const updated = [...truncated, address];
      // Limit size
      if (updated.length > MAX_HISTORY_SIZE) {
        return updated.slice(-MAX_HISTORY_SIZE);
      }
      return updated;
    });
    setHistoryIndex(prev => Math.min(prev + 1, MAX_HISTORY_SIZE - 1));

    loadDisassembly(address);
  }, [historyIndex, loadDisassembly]);

  // Scroll to address already in view (no history, no reload)
  const scrollToAddressInView = useCallback((address: bigint) => {
    setJumpTargetAddress(address);
  }, []);

  // Go to address with expression parsing
  const goToAddress = useCallback(async (expression: string) => {
    if (!expression.trim()) return;

    const result = await parseAddressExpression(expression, registers, resolveSymbol);
    if (result.address === null) {
      toastError(result.error || 'Invalid address expression', sessionId);
      return;
    }

    goToAddressDirect(result.address);
  }, [registers, resolveSymbol, goToAddressDirect, sessionId]);

  // Navigate back
  const goBack = useCallback(() => {
    if (!canGoBack) return;
    const newIndex = historyIndex - 1;
    const targetAddress = navigationHistory[newIndex];
    setHistoryIndex(newIndex);
    setJumpTargetAddress(targetAddress);
    loadDisassembly(targetAddress);
  }, [canGoBack, historyIndex, navigationHistory, loadDisassembly]);

  // Navigate forward
  const goForward = useCallback(() => {
    if (!canGoForward) return;
    const newIndex = historyIndex + 1;
    const targetAddress = navigationHistory[newIndex];
    setHistoryIndex(newIndex);
    setJumpTargetAddress(targetAddress);
    loadDisassembly(targetAddress);
  }, [canGoForward, historyIndex, navigationHistory, loadDisassembly]);

  // Refresh current view
  const refresh = useCallback(() => {
    if (currentAddress !== null) {
      loadDisassembly(currentAddress);
    } else if (pcAddress !== null) {
      loadDisassembly(pcAddress);
    }
  }, [currentAddress, pcAddress, loadDisassembly]);

  // Toggle bytes column
  const toggleBytesColumn = useCallback(() => {
    setShowBytes(prev => {
      const newValue = !prev;
      saveSettings({ showBytes: newValue });
      return newValue;
    });
  }, []);

  // Scroll to PC (placeholder - actual implementation in component)
  const scrollToPC = useCallback(() => {
    if (scrollToPCRef.current) {
      scrollToPCRef.current();
    }
  }, []);

  // Re-request the current view when background symbol loading completes so raw
  // addresses upgrade to symbol names. The ref starts at the mount value, so no
  // refresh fires until the key actually changes.
  const prevSymbolsKey = useRef(symbolsRefreshKey);
  useEffect(() => {
    if (symbolsRefreshKey === prevSymbolsKey.current) return;
    prevSymbolsKey.current = symbolsRefreshKey;
    refresh();
  }, [symbolsRefreshKey, refresh]);

  // Listen for disassembly events
  useEffect(() => {
    if (!sessionId) return;

    const unlistenSuccess = listen<FunctionDisassemblyResult>(
      'function-disassembly-updated',
      (event) => {
        if (event.payload.session_id === sessionId) {
          setInstructions(event.payload.instructions);
          setFunctionStart(event.payload.function_start ? BigInt(event.payload.function_start) : null);
          setFunctionEnd(event.payload.function_end ? BigInt(event.payload.function_end) : null);
          setFunctionName(event.payload.function_name);
          requestInFlight.current = false;
          setIsLoading(false);
          setError(null);
        }
      }
    );

    const unlistenError = listen<FunctionDisassemblyError>(
      'function-disassembly-error',
      (event) => {
        if (event.payload.session_id === sessionId) {
          const msg = event.payload.error || '';
          if (!isBenignStateError(msg)) {
            setError(msg);
            toastError(`Disassembly failed: ${msg}`, sessionId);
          }
          requestInFlight.current = false;
          setIsLoading(false);
        }
      }
    );

    // Also listen for the old event for backwards compatibility
    const unlistenOldSuccess = listen<{session_id: string, address: number, instructions: Instruction[]}>(
      'disassembly-updated',
      (event) => {
        if (event.payload.session_id === sessionId) {
          setInstructions(event.payload.instructions);
          setFunctionStart(null);
          setFunctionEnd(null);
          setFunctionName(null);
          requestInFlight.current = false;
          setIsLoading(false);
          setError(null);
        }
      }
    );

    // Refresh disassembly when patches change so patched instructions are shown
    const unlistenPatches = listen<{session_id: string}>(
      'patches-updated',
      (event) => {
        if (event.payload.session_id === sessionId && lastRequestedAddress.current !== null) {
          // Re-request the current disassembly to pick up is_patched flags and new bytes
          invoke('request_function_disassembly', {
            sessionId,
            address: Number(lastRequestedAddress.current),
            maxInstructions: DEFAULT_MAX_INSTRUCTIONS,
          }).catch(() => {
            // Ignore errors (e.g., session ended between patch and refresh)
          });
        }
      }
    );

    return () => {
      unlistenSuccess.then(unlisten => unlisten());
      unlistenError.then(unlisten => unlisten());
      unlistenOldSuccess.then(unlisten => unlisten());
      unlistenPatches.then(unlisten => unlisten());
    };
  }, [sessionId]);

  // External navigation (e.g., symbol click). MUST be declared before the
  // PC-following effect so it runs first on mount and sets userNavigatedAway.
  useNavigationChannel(disassemblyNavigation, (addr) => {
    goToAddress(addr);
  });

  // Auto-load when PC changes (stepping)
  // When user steps, ALWAYS follow PC regardless of where they were looking
  useEffect(() => {
    if (pcAddress === null || !sessionId) return;

    // Detect if PC actually changed (i.e., user stepped)
    const pcActuallyChanged = lastAutoPcAddress.current === null || pcAddress !== lastAutoPcAddress.current;

    // Initial load - no address set yet or no navigation history
    // Skip if user already navigated (e.g., pending symbol navigation consumed in same render)
    if ((currentAddress === null || navigationHistory.length === 0) && !userNavigatedAway.current) {
      lastAutoPcAddress.current = pcAddress;
      goToAddressDirect(pcAddress, true);
      return;
    }

    // If PC actually changed (user stepped), always follow PC
    if (pcActuallyChanged) {
      const isRealStep = lastAutoPcAddress.current !== null;
      lastAutoPcAddress.current = pcAddress;

      // Real step (PC moved to a new address) — always follow PC
      if (isRealStep) {
        userNavigatedAway.current = false;
        // Clear any previous jump target so PC scroll effect can work
        setJumpTargetAddress(null);

        // Check if PC is outside current function bounds - need to load new function
        const pcOutsideFunction = functionStart === null || functionEnd === null ||
          pcAddress < functionStart || pcAddress >= functionEnd;

        if (pcOutsideFunction) {
          // PC moved to different function - load it
          goToAddressDirect(pcAddress, true);
        }
        // If PC is still in current function, scroll effect will handle scrolling to it
      }
      // First time seeing PC (mount) — skip if user already navigated (e.g., symbol click)
    }
    // If PC didn't change, user can freely navigate without being pulled back
  }, [pcAddress, sessionId, currentAddress, navigationHistory.length, functionStart, functionEnd, goToAddressDirect]);

  // Clear state when session ends or stops
  useEffect(() => {
    if (!sessionId || isPaused === false) {
      setInstructions([]);
      setCurrentAddress(null);
      setFunctionStart(null);
      setFunctionEnd(null);
      setFunctionName(null);
      setError(null);
      setIsLoading(false);
      setNavigationHistory([]);
      setHistoryIndex(-1);
      lastAutoPcAddress.current = null;
      lastRequestedAddress.current = null;
      requestInFlight.current = false;
      userNavigatedAway.current = false;
    }
  }, [sessionId, isPaused]);

  return {
    // State
    instructions,
    currentAddress,
    pcAddress,
    functionStart,
    functionEnd,
    functionName,
    isLoading,
    error,
    showBytes,
    canGoBack,
    canGoForward,
    jumpTargetAddress,
    // Actions
    goToAddress,
    goToAddressDirect,
    scrollToAddressInView,
    goBack,
    goForward,
    refresh,
    toggleBytesColumn,
    scrollToPC,
  };
}

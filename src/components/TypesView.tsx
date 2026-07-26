import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTypes, type UseTypes } from "@/hooks/useTypes";
import { useNavigationChannel } from "@/hooks/useNavigationChannel";
import { typesNavigation } from "@/lib/navigationStore";
import { useLiveRefresh } from "@/hooks/useLiveRefresh";
import {
  usePopoverDismiss,
  computeAnchoredDropdownRect,
  type AnchoredDropdownRect,
} from "@/hooks/usePopoverDismiss";
import { usePanelFocus } from "@/hooks/usePanelFocus";
import { cn, CHANGED_VALUE_CLASS } from "@/lib/utils";
import type { RegisterContext, SymbolResolver } from "@/lib/hexUtils";
import { AddressExpressionInput } from "@/components/AddressExpressionInput";
import {
  addHex,
  isExpandable,
  renderValue,
  toHex,
  type CustomFieldDef,
  type CustomTypeDef,
  type TypeLayout,
  type TypeMember,
  type TypeRef,
  type TypeSummary,
} from "@/lib/typeSystem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { DockPanel, PanelToolbar, PanelBody } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ChevronRight,
  ChevronDown,
  Plus,
  Trash2,
  Boxes,
  Loader2,
} from "lucide-react";

// Fixed x64 address of the shared user data page.
const KUSER_SHARED_DATA_ADDR = "0x7FFE0000";
const MAX_ARRAY_EXPAND = 64;

type Mode = "inspect" | "custom";

export interface TypesViewProps {
  sessionId: string | undefined;
  /** Memory ops available (process open/attached/running). */
  isActive: boolean;
  /** Target runs live (Running or non-invasive Open) — drives overlay polling. */
  isLive: boolean;
  registers: RegisterContext;
  resolveSymbol: SymbolResolver;
  onNavigateToMemory?: (address: string) => void;
  /** Dock tab id — "Go to" that tab focuses the type-name input. */
  focusTabId?: string;
}

export const TypesView = ({
  sessionId,
  isActive,
  isLive,
  registers,
  resolveSymbol,
  onNavigateToMemory,
  focusTabId,
}: TypesViewProps) => {
  const ts = useTypes(sessionId);

  const [mode, setMode] = useState<Mode>("inspect");
  const [customTypes, setCustomTypes] = useState<CustomTypeDef[]>([]);
  // Cross-tab "open _TEB at this address" navigation (e.g. from the Threads view):
  // flip to inspect mode without consuming — the payload stays pending in the
  // channel until the (possibly just-mounted) InspectMode consumes it.
  const navVersion = useSyncExternalStore(typesNavigation.subscribe, typesNavigation.getSnapshot);
  useEffect(() => {
    setMode("inspect");
  }, [navVersion]);

  const reloadCustom = useCallback(async () => {
    try {
      setCustomTypes(await ts.listCustomTypes());
    } catch (e) {
      console.error("Failed to load custom types:", e);
    }
  }, [ts]);

  useEffect(() => {
    reloadCustom();
  }, [reloadCustom]);

  return (
    <DockPanel>
      <PanelToolbar>
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant={mode === "inspect" ? "default" : "ghost"}
            onClick={() => setMode("inspect")}
          >
            Inspect
          </Button>
          <Button
            size="xs"
            variant={mode === "custom" ? "default" : "ghost"}
            onClick={() => setMode("custom")}
          >
            Custom Types
          </Button>
        </div>
      </PanelToolbar>
      {mode === "inspect" ? (
        <InspectMode
          ts={ts}
          sessionId={sessionId}
          isActive={isActive}
          isLive={isLive}
          registers={registers}
          resolveSymbol={resolveSymbol}
          onNavigateToMemory={onNavigateToMemory}
          focusTabId={focusTabId}
        />
      ) : (
        <CustomMode ts={ts} customTypes={customTypes} onChanged={reloadCustom} />
      )}
    </DockPanel>
  );
};

// -------------------------------------------------------------------------
// Inspect mode: pick a type, overlay it on an address, expand nested members.
// -------------------------------------------------------------------------

interface InspectProps {
  ts: UseTypes;
  sessionId: string | undefined;
  isActive: boolean;
  isLive: boolean;
  registers: RegisterContext;
  resolveSymbol: SymbolResolver;
  onNavigateToMemory?: (address: string) => void;
  focusTabId?: string;
}

function InspectMode({
  ts,
  sessionId,
  isActive,
  isLive,
  registers,
  resolveSymbol,
  onNavigateToMemory,
  focusTabId,
}: InspectProps) {
  const focusRef = usePanelFocus<HTMLInputElement>(focusTabId);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TypeSummary[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [rootLayout, setRootLayout] = useState<TypeLayout | null>(null);
  // Raw expression text vs the resolved overlay address: the input accepts the
  // shared expression grammar (registers, symbols, rax+0x10 math) and resolves
  // to a concrete address on submit, like the memory/disassembly inputs.
  const [addressInput, setAddressInput] = useState("");
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The results dropdown is portaled to <body> with fixed positioning so the
  // DockPanel's overflow-hidden can't clip it; anchored under the search input
  // and height-clamped to the viewport.
  const anchorRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownRect, setDropdownRect] = useState<AnchoredDropdownRect | null>(null);

  useLayoutEffect(() => {
    if (!showResults || results.length === 0 || !anchorRef.current) {
      setDropdownRect(null);
      return;
    }
    setDropdownRect(computeAnchoredDropdownRect(anchorRef.current));
  }, [showResults, results]);

  const closeResults = useCallback(() => setShowResults(false), []);
  usePopoverDismiss(showResults, closeResults, anchorRef, dropdownRef);

  // One lifted refresh tick drives every mounted TypeNode's re-read, so all
  // nodes read in the same pass (coherent snapshot) instead of per-node timers.
  // (useLiveRefresh re-captures the callback each render, so the closure below
  // always sees the current rootLayout/address.)
  const [refreshTick, setRefreshTick] = useState(0);
  useLiveRefresh(sessionId, isLive, () => {
    if (rootLayout && address.trim()) setRefreshTick((t) => t + 1);
  });

  // Reset when the session becomes inactive.
  useEffect(() => {
    if (!isActive) {
      setResults([]);
      setRootLayout(null);
    }
  }, [isActive]);

  const runSearch = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const trimmed = q.trim();
      if (!trimmed) {
        setResults([]);
        setShowResults(false);
        return;
      }
      debounceRef.current = setTimeout(async () => {
        // The backend merges custom types into the list (customs first).
        setResults(isActive ? await ts.searchTypes(trimmed, undefined, 300) : []);
        setShowResults(true);
      }, 250);
    },
    [ts, isActive],
  );

  const loadType = useCallback(
    async (name: string, moduleBase?: string, addr?: string) => {
      setLoading(true);
      setShowResults(false);
      setQuery(name);
      try {
        const layout = await ts.getType(name, moduleBase);
        setRootLayout(layout);
        if (addr !== undefined) {
          setAddress(addr);
          setAddressInput(addr);
        }
      } catch (e) {
        console.error("Failed to load type:", e);
        setRootLayout(null);
      } finally {
        setLoading(false);
      }
    },
    [ts],
  );

  const loadTebPeb = useCallback(
    async (which: "teb" | "peb") => {
      const { teb, peb } = await ts.getTebPeb();
      const addr = which === "teb" ? teb : peb;
      if (!addr) {
        console.warn(`${which.toUpperCase()} address unavailable`);
        return;
      }
      await loadType(which === "teb" ? "_TEB" : "_PEB", undefined, addr);
    },
    [ts, loadType],
  );

  // Fulfil an external navigation request (e.g. Threads → "TEB: 0x…"): overlay the
  // requested type on the requested address. The channel buffers the payload
  // across the custom→inspect remount, so a fresh mount consumes it here; a
  // request against an inactive session is dropped, never replayed later.
  useNavigationChannel(typesNavigation, (req) => {
    if (isActive) loadType(req.typeName, undefined, req.address);
  });

  return (
    <>
      <PanelToolbar stack>
        <div ref={anchorRef}>
          <Input
            ref={focusRef}
            inputSize="xs"
            placeholder={isActive ? "Type name (e.g. _PEB, _TEB)…" : "Open, attach, or run a process"}
            value={query}
            disabled={!isActive}
            onChange={(e) => {
              setQuery(e.target.value);
              runSearch(e.target.value);
            }}
            onFocus={() => query && runSearch(query)}
          />
          {showResults && results.length > 0 && dropdownRect &&
            createPortal(
              <div
                ref={dropdownRef}
                className="fixed z-50"
                style={{ left: dropdownRect.left, top: dropdownRect.top, width: dropdownRect.width }}
              >
                <ScrollArea
                  className="rounded-md border bg-popover shadow-md"
                  style={{ maxHeight: dropdownRect.maxHeight }}
                >
                  {results.slice(0, 200).map((r, i) => (
                    <Button
                      key={`${r.source}-${r.module_base}-${r.name}-${i}`}
                      size="xs"
                      variant="ghost"
                      className="flex h-auto w-full items-center justify-between gap-2 rounded-none px-2 py-1 text-left font-normal"
                      onClick={() => loadType(r.name, r.source === "custom" ? undefined : r.module_base)}
                    >
                      <span className="font-mono truncate">{r.name}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {r.module_name} · {r.size}B
                      </span>
                    </Button>
                  ))}
                </ScrollArea>
              </div>,
              document.body,
            )}
        </div>
        <AddressExpressionInput
          value={addressInput}
          onChange={setAddressInput}
          onResolve={(addr) => setAddress(toHex(addr))}
          registers={registers}
          resolveSymbol={resolveSymbol}
          sessionId={sessionId}
          disabled={!isActive}
          inputClassName="flex-1"
          historyKey="types-address"
        />
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={!isActive}
            onClick={() => loadType("_KUSER_SHARED_DATA", undefined, KUSER_SHARED_DATA_ADDR)}
          >
            KUSER
          </Button>
          <Button size="xs" variant="outline" disabled={!isActive} onClick={() => loadTebPeb("teb")}>
            TEB
          </Button>
          <Button size="xs" variant="outline" disabled={!isActive} onClick={() => loadTebPeb("peb")}>
            PEB
          </Button>
        </div>
      </PanelToolbar>
      <PanelBody>
        {loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : !rootLayout ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4 text-center">
            <Boxes className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm font-medium">Pick a type to inspect its layout</p>
            <p className="text-xs mt-1">
              Search by name, or use the KUSER / TEB / PEB shortcuts. Set an address to
              overlay live values.
            </p>
          </div>
        ) : (
          // pr-3 keeps ml-auto values clear of the overlay scrollbar (w-2.5).
          <div className="p-1 pr-3 text-xs">
            <div className="flex items-center gap-2 px-1 py-1 font-mono">
              <span className="font-semibold">{rootLayout.name}</span>
              <span className="text-muted-foreground">
                {rootLayout.kind} · {rootLayout.size} bytes
              </span>
              {rootLayout.source === "custom" && (
                <Badge size="xs" variant="secondary">
                  custom
                </Badge>
              )}
            </div>
            <TypeNode
              ts={ts}
              layout={rootLayout}
              address={address.trim() || null}
              depth={0}
              refreshTick={refreshTick}
              onNavigateToMemory={onNavigateToMemory}
            />
          </div>
        )}
      </PanelBody>
    </>
  );
}

// -------------------------------------------------------------------------
// Recursive struct/enum node: reads its own memory blob and renders members.
// -------------------------------------------------------------------------

interface TypeNodeProps {
  ts: UseTypes;
  layout: TypeLayout;
  address: string | null;
  depth: number;
  refreshTick: number;
  onNavigateToMemory?: (address: string) => void;
}

interface ChildInstance {
  label: string;
  layout: TypeLayout;
  address: string | null;
}

function TypeNode({ ts, layout, address, depth, refreshTick, onNavigateToMemory }: TypeNodeProps) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, ChildInstance[]>>(new Map());

  // Previous read (change-detection baseline) and the last array identity seen
  // by the baseline effect.
  const prevBytesRef = useRef<{ data: Uint8Array; address: string } | null>(null);
  const lastSeenBytesRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (address) {
      ts.readMemory(address, Math.max(layout.size, 1)).then((b) => {
        if (!cancelled) setBytes(b);
      });
    } else {
      setBytes(null);
    }
    return () => {
      cancelled = true;
    };
  }, [ts, address, layout.size, layout.index, layout.name, refreshTick]);

  // Members whose bytes differ from the previous read (red highlight). The
  // diff only applies while the address is unchanged — an address edit yields
  // no highlight, it's a fresh overlay. (Byte-window diff against a per-node
  // blob, so the shared useChangedValues string-value hook doesn't fit here.)
  const changedMemberKeys = useMemo(() => {
    const set = new Set<string>();
    const prev = prevBytesRef.current;
    if (!prev || !bytes || !address || prev.address !== address) return set;
    layout.members.forEach((m, idx) => {
      const end = Math.min(m.offset + Math.max(m.type_ref.size, 1), bytes.length, prev.data.length);
      for (let i = m.offset; i < end; i++) {
        if (bytes[i] !== prev.data[i]) {
          set.add(`${m.name}-${m.offset}-${idx}`);
          break;
        }
      }
    });
    return set;
  }, [bytes, address, layout]);

  // Advance the baseline only on genuinely-new data (reference identity).
  // Deliberately not reset on status changes, so it survives Running→Paused
  // and a step highlights what changed — same semantics as the hex view.
  useEffect(() => {
    if (!bytes) {
      prevBytesRef.current = null;
      lastSeenBytesRef.current = null;
      return;
    }
    if (bytes === lastSeenBytesRef.current) return;
    lastSeenBytesRef.current = bytes;
    prevBytesRef.current = { data: bytes, address: address ?? "" };
  }, [bytes, address]);

  // Enum layout: render its enumerators, marking the live value.
  if (layout.kind === "enum") {
    const current = bytes ? renderValue({ name: layout.name, size: layout.size || 4, class: { kind: "enum", index: layout.index } }, bytes, 0, null, null).numeric : undefined;
    return (
      <div>
        {layout.enum_values.map((ev) => (
          <div
            key={ev.name}
            className="flex items-center gap-2 px-1 py-0.5 font-mono"
            style={{ paddingLeft: depth * 12 + 4 }}
          >
            <span className={current !== undefined && BigInt(ev.value) === current ? "text-primary font-semibold" : "text-muted-foreground"}>
              {ev.value}
            </span>
            <span>{ev.name}</span>
          </div>
        ))}
      </div>
    );
  }

  const toggle = async (m: TypeMember, key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) {
      next.delete(key);
      setExpanded(next);
      return;
    }
    next.add(key);
    setExpanded(next);
    if (children.has(key)) return;

    const instances = await resolveChildren(ts, layout, m, address, bytes);
    setChildren((prev) => new Map(prev).set(key, instances));
  };

  return (
    <div>
      {layout.members.map((m, idx) => {
        const key = `${m.name}-${m.offset}-${idx}`;
        const expandable = isExpandable(m.type_ref);
        const isOpen = expanded.has(key);
        const val = renderValue(m.type_ref, bytes, m.offset, m.bit_position, m.bit_length);
        const bitNote =
          m.bit_length != null ? `:${m.bit_length}` + (m.bit_position != null ? ` @${m.bit_position}` : "") : "";
        return (
          <div key={key}>
            <div
              className={`flex items-center gap-2 px-1 py-0.5 font-mono hover:bg-accent/50 ${expandable ? "cursor-pointer" : ""}`}
              style={{ paddingLeft: depth * 12 + 4 }}
              onClick={() => expandable && toggle(m, key)}
            >
              <span className="w-3 shrink-0 text-muted-foreground">
                {expandable ? (isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />) : null}
              </span>
              <span className="w-14 shrink-0 text-muted-foreground">+0x{m.offset.toString(16)}</span>
              <span className="shrink-0">{m.name}</span>
              <span className="shrink-0 text-syn-link">
                {m.type_ref.name}
                {bitNote}
              </span>
              {val.text && (
                <span
                  data-member-value
                  data-changed={changedMemberKeys.has(key) || undefined}
                  className={cn(
                    "ml-auto truncate",
                    changedMemberKeys.has(key)
                      ? CHANGED_VALUE_CLASS
                      : val.pointer
                        ? "text-syn-link"
                        : "text-foreground",
                    val.pointer && "cursor-pointer hover:underline",
                  )}
                  onClick={(e) => {
                    if (val.pointer && onNavigateToMemory) {
                      e.stopPropagation();
                      onNavigateToMemory(val.pointer);
                    }
                  }}
                >
                  {val.text}
                </span>
              )}
            </div>
            {isOpen &&
              (children.get(key) ?? []).map((child, ci) => (
                <div key={`${key}-c${ci}`}>
                  {child.label && (
                    <div
                      className="px-1 py-0.5 font-mono text-muted-foreground"
                      style={{ paddingLeft: (depth + 1) * 12 + 4 }}
                    >
                      {child.label} <span className="text-syn-link">{child.layout.name}</span>
                    </div>
                  )}
                  <TypeNode
                    ts={ts}
                    layout={child.layout}
                    address={child.address}
                    depth={depth + 1}
                    refreshTick={refreshTick}
                    onNavigateToMemory={onNavigateToMemory}
                  />
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

/** Compute the nested instances to render when a member is expanded. */
async function resolveChildren(
  ts: UseTypes,
  parent: TypeLayout,
  m: TypeMember,
  parentAddr: string | null,
  parentBytes: Uint8Array | null,
): Promise<ChildInstance[]> {
  const base = m.module_base ?? parent.module_base;
  const cls = m.type_ref.class;

  const fetchByRef = async (ref: TypeRef): Promise<TypeLayout | null> => {
    const rc = ref.class;
    if ((rc.kind === "udt" || rc.kind === "enum") && rc.index > 0 && base !== "0x0") {
      return ts.getTypeByIndex(base, rc.index);
    }
    return ts.getType(ref.name);
  };

  // Inline nested UDT/enum.
  if (cls.kind === "udt" || cls.kind === "enum") {
    const layout = await fetchByRef(m.type_ref);
    if (!layout) return [];
    const addr = parentAddr ? addHex(parentAddr, m.offset) : null;
    return [{ label: "", layout, address: addr }];
  }

  // Pointer to UDT/enum: follow the pointer value read from the parent blob.
  if (cls.kind === "pointer") {
    const layout = await fetchByRef(cls.pointee);
    if (!layout) return [];
    const val = renderValue(m.type_ref, parentBytes, m.offset, null, null);
    const target = val.pointer && val.pointer !== "0x0" ? val.pointer : null;
    return [{ label: "*", layout, address: target }];
  }

  // Array of UDT/enum: one node per element (capped).
  if (cls.kind === "array") {
    const layout = await fetchByRef(cls.element);
    if (!layout) return [];
    const count = Math.min(cls.count, MAX_ARRAY_EXPAND);
    const elemSize = cls.element.size || layout.size || 1;
    const out: ChildInstance[] = [];
    for (let i = 0; i < count; i++) {
      const addr = parentAddr ? addHex(parentAddr, m.offset + i * elemSize) : null;
      out.push({ label: `[${i}]`, layout, address: addr });
    }
    return out;
  }

  return [];
}

// -------------------------------------------------------------------------
// Custom mode: build/edit user-defined types (form + C-like text parser).
// -------------------------------------------------------------------------

interface CustomProps {
  ts: UseTypes;
  customTypes: CustomTypeDef[];
  onChanged: () => void;
}

const BLANK_TYPE: CustomTypeDef = {
  id: "",
  name: "",
  fields: [],
  is_union: false,
  size: null,
  comment: null,
};

function CustomMode({ ts, customTypes, onChanged }: CustomProps) {
  const [editing, setEditing] = useState<CustomTypeDef | null>(null);
  const [textMode, setTextMode] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const startNew = () => {
    setEditing({ ...BLANK_TYPE, fields: [{ name: "", type_expr: "", offset: null, comment: null }] });
    setText("");
    setError(null);
  };

  const edit = (def: CustomTypeDef) => {
    setEditing(JSON.parse(JSON.stringify(def)));
    setError(null);
  };

  const save = async () => {
    if (!editing) return;
    try {
      await ts.saveCustomType(editing);
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (id: string) => {
    await ts.deleteCustomType(id);
    if (editing?.id === id) setEditing(null);
    onChanged();
  };

  const parseText = async () => {
    try {
      const def = await ts.parseCustomTypeText(text);
      setEditing((prev) => ({ ...def, id: prev?.id ?? "" }));
      setTextMode(false);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const updateField = (i: number, patch: Partial<CustomFieldDef>) => {
    setEditing((prev) => {
      if (!prev) return prev;
      const fields = prev.fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f));
      return { ...prev, fields };
    });
  };

  return (
    <>
      <PanelToolbar>
        <Button size="xs" variant="outline" onClick={startNew}>
          <Plus className="h-3 w-3" /> New Type
        </Button>
        {editing && (
          <Button
            size="xs"
            variant={textMode ? "default" : "ghost"}
            onClick={() => {
              setTextMode((v) => !v);
              setError(null);
            }}
          >
            Paste C struct
          </Button>
        )}
      </PanelToolbar>
      <PanelBody>
        <div className="flex gap-2 p-2 text-xs">
          {/* List */}
          <div className="w-40 shrink-0 border-r pr-2">
            {customTypes.length === 0 ? (
              <p className="text-muted-foreground">No custom types yet.</p>
            ) : (
              customTypes.map((c) => (
                <div
                  key={c.id}
                  className={`group flex items-center justify-between gap-1 rounded px-1 py-0.5 hover:bg-accent cursor-pointer ${editing?.id === c.id ? "bg-accent" : ""}`}
                  onClick={() => edit(c)}
                >
                  <span className="font-mono truncate">{c.name}</span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="h-4 w-4 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(c.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))
            )}
          </div>

          {/* Editor */}
          <div className="flex-1 min-w-0">
            {!editing ? (
              <p className="text-muted-foreground">Select a type to edit, or create a new one.</p>
            ) : textMode ? (
              <div className="space-y-2">
                <Textarea
                  rows={10}
                  textareaSize="xs"
                  className="font-mono"
                  placeholder={"struct MyType {\n    unsigned long Flags;\n    void* Next;\n    wchar_t Name[16];\n};"}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <Button size="xs" onClick={parseText}>
                  Parse
                </Button>
                {error && <p className="text-destructive">{error}</p>}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    inputSize="xs"
                    placeholder="Type name"
                    value={editing.name}
                    className="font-mono"
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  />
                  <label className="flex items-center gap-1 shrink-0">
                    <Checkbox
                      checked={editing.is_union}
                      onCheckedChange={(checked) => setEditing({ ...editing, is_union: checked === true })}
                    />
                    union
                  </label>
                </div>

                {/* Fields */}
                <div className="space-y-1">
                  <div className="flex gap-1 text-muted-foreground">
                    <span className="flex-1">field</span>
                    <span className="flex-1">type</span>
                    <span className="w-16">offset</span>
                    <span className="w-4" />
                  </div>
                  {editing.fields.map((f, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <Input
                        inputSize="xs"
                        placeholder="name"
                        value={f.name}
                        className="flex-1 font-mono"
                        onChange={(e) => updateField(i, { name: e.target.value })}
                      />
                      <Input
                        inputSize="xs"
                        placeholder="u32 / void* / _PEB"
                        value={f.type_expr}
                        className="flex-1 font-mono"
                        onChange={(e) => updateField(i, { type_expr: e.target.value })}
                      />
                      <Input
                        inputSize="xs"
                        placeholder="auto"
                        value={f.offset != null ? `0x${f.offset.toString(16)}` : ""}
                        className="w-16 font-mono"
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          const parsed = v ? parseInt(v.replace(/^0x/i, ""), 16) : NaN;
                          updateField(i, { offset: Number.isNaN(parsed) ? null : parsed });
                        }}
                      />
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="h-5 w-4 text-muted-foreground hover:text-destructive"
                        onClick={() =>
                          setEditing({ ...editing, fields: editing.fields.filter((_, idx) => idx !== i) })
                        }
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      setEditing({
                        ...editing,
                        fields: [...editing.fields, { name: "", type_expr: "", offset: null, comment: null }],
                      })
                    }
                  >
                    <Plus className="h-3 w-3" /> Add field
                  </Button>
                </div>

                <div className="flex items-center gap-2">
                  <Button size="xs" onClick={save} disabled={!editing.name.trim()}>
                    Save
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                  {error && <p className="text-destructive">{error}</p>}
                </div>
              </div>
            )}
          </div>
        </div>
      </PanelBody>
    </>
  );
}

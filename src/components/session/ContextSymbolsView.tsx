import { useEffect, useState, useCallback, useRef } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { Input } from '@/components/ui/input';
import { Search, Code, Loader2 } from 'lucide-react';

export const ContextSymbolsView = () => {
  const sessionData = useSessionContext();
  const [searchTerm, setSearchTerm] = useState('');
  const [symbols, setSymbols] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear results when session changes or is not paused
  useEffect(() => {
    if (!sessionData.session?.id || sessionData.session.status !== "Paused") {
      setSymbols([]);
      setHasSearched(false);
      setIsSearching(false);
    }
  }, [sessionData.session?.id, sessionData.session?.status]);

  // Debounced search using searchSymbols from context
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchTerm(value);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setSymbols([]);
      setHasSearched(false);
      setIsSearching(false);
      return;
    }

    if (!sessionData.session?.id || sessionData.session.status !== "Paused" || !sessionData.searchSymbols) return;

    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await sessionData.searchSymbols(trimmed, 30);
        setSymbols(results);
        setHasSearched(true);
      } catch (error) {
        console.error('Symbol search failed:', error);
        setSymbols([]);
        setHasSearched(true);
      }
      setIsSearching(false);
    }, 300);
  }, [sessionData.session?.id, sessionData.session?.status, sessionData.searchSymbols]);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const renderContent = () => {
    // Show a message when session is not in the right state
    if (sessionData.session && sessionData.session.status !== "Paused") {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <Code className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Symbol search unavailable</p>
            <p className="text-sm mt-1">Session must be paused to search symbols</p>
          </div>
        </div>
      );
    }

    if (isSearching) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <Loader2 className="h-8 w-8 mx-auto mb-4 animate-spin" />
          <p className="text-sm">Searching symbols...</p>
        </div>
      );
    }

    if (!hasSearched) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">Start typing to search symbols</p>
            <p className="text-sm mt-1">Enter at least 2 characters to begin search</p>
          </div>
        </div>
      );
    }

    if (symbols.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
          <div className="text-center">
            <Code className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-base font-medium">No symbols found</p>
            <p className="text-sm mt-1">Try different search terms</p>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-1">
        {symbols.map((symbol, index) => (
          <div
            key={`${symbol.module_name}-${symbol.name}-${index}`}
            className="px-2 py-1 border-b hover:bg-gray-50 dark:hover:bg-gray-900"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-mono truncate">
                <span className="text-muted-foreground">{symbol.va}</span>
                <span className="ml-2">{symbol.display_name}</span>
              </p>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b">
        <Input
          type="text"
          placeholder={sessionData.session?.status === "Paused" ? "Search symbols..." : "Session must be paused to search symbols"}
          value={searchTerm}
          onChange={handleSearchChange}
          className="w-full"
          disabled={!sessionData.session || sessionData.session.status !== "Paused"}
        />
      </div>
      <div className="flex-1 overflow-auto">
        {renderContent()}
      </div>
    </div>
  );
};

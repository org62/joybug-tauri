import { useEffect, useState, useCallback } from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { Input } from '@/components/ui/input';
import { Search, Code, Loader2 } from 'lucide-react';

export const ContextSymbolsView = () => {
  const sessionData = useSessionContext();
  const [searchTerm, setSearchTerm] = useState('');
  const [symbols, setSymbols] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // Debounced search function
  const debouncedSearch = useCallback(
    (() => {
      let timeoutId: NodeJS.Timeout;
      return (pattern: string) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(async () => {
          if (pattern.trim().length >= 2) {
            setIsSearching(true);
            try {
              const results = await sessionData.searchSymbols(pattern, 30);
              setSymbols(results);
              setHasSearched(true);
            } catch (error) {
              console.error('Search failed:', error);
              setSymbols([]);
            } finally {
              setIsSearching(false);
            }
          } else {
            setSymbols([]);
            setHasSearched(false);
          }
        }, 300); // 300ms debounce
      };
    })(),
    [sessionData]
  );

  // Handle search term changes
  useEffect(() => {
    debouncedSearch(searchTerm);
  }, [searchTerm, debouncedSearch]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  };

  const renderContent = () => {
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
    <div className="h-full flex flex-col">
      {/* Search Bar */}
      <div className="p-2 border-b">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search symbols..."
            value={searchTerm}
            onChange={handleSearchChange}
            className="pl-8"
          />
        </div>
      </div>

      {/* Symbols List */}
      <div className="flex-1 overflow-auto">
        {renderContent()}
      </div>
    </div>
  );
}; 
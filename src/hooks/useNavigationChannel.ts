import { useEffect, useRef, useSyncExternalStore } from 'react';
import { NavigationChannel } from '@/lib/navigationStore';

/**
 * Subscribe to a NavigationChannel and call onNavigate when a navigation is requested.
 *
 * Handles both:
 * - Already-mounted components: useSyncExternalStore triggers a re-render,
 *   then the effect consumes the pending address.
 * - Freshly mounted components (tab activation may remount): the mount effect
 *   checks for a pending address before any other initialization effects run.
 *
 * IMPORTANT: Call this hook BEFORE any initialization effect (e.g., "go to PC")
 * that could conflict with the pending navigation. React runs effects in
 * declaration order, so this hook's effect will consume the pending address
 * first, allowing the initialization effect to detect (via refs/state) that
 * navigation already happened.
 */
export function useNavigationChannel(
  channel: NavigationChannel,
  onNavigate: (address: string) => void,
) {
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  // Re-render when a navigation is requested (batched with layout changes)
  const version = useSyncExternalStore(channel.subscribe, channel.getSnapshot);

  // Consume pending address on mount or when a new request arrives
  useEffect(() => {
    const pending = channel.consume();
    if (pending) {
      onNavigateRef.current(pending);
    }
  }, [channel, version]);
}

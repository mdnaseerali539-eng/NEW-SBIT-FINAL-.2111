import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

interface RefreshBarProps {
  lastUpdatedAt: Date | null;
  isRefreshing: boolean;
  onRefresh: () => void | Promise<void>;
  defaultAutoRefreshSeconds?: number;
  autoRefreshSeconds?: number;
  onAutoRefreshChange?: (seconds: number) => void;
  label?: string;
  refreshOnWindowFocus?: boolean;
  compact?: boolean;
}

const IST_TIME_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

export const RefreshBar: React.FC<RefreshBarProps> = ({
  lastUpdatedAt,
  isRefreshing,
  onRefresh,
  defaultAutoRefreshSeconds = 30,
  autoRefreshSeconds: controlledSeconds,
  onAutoRefreshChange,
  label = 'Live Data Sync',
  refreshOnWindowFocus = true,
  compact = false,
}) => {
  const [internalSeconds, setInternalSeconds] = useState<number>(defaultAutoRefreshSeconds);
  const activeSeconds = controlledSeconds !== undefined ? controlledSeconds : internalSeconds;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const lastFocusRefreshRef = useRef(0);

  const handleIntervalChange = (sec: number) => {
    if (onAutoRefreshChange) {
      onAutoRefreshChange(sec);
    } else {
      setInternalSeconds(sec);
    }
  };

  useEffect(() => {
    if (!activeSeconds || activeSeconds <= 0) return;
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void onRefreshRef.current();
    }, activeSeconds * 1000);
    return () => window.clearInterval(id);
  }, [activeSeconds]);

  useEffect(() => {
    if (!refreshOnWindowFocus || typeof window === 'undefined') return;
    const triggerIfDue = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const now = Date.now();
      if (now - lastFocusRefreshRef.current < 1500) return;
      lastFocusRefreshRef.current = now;
      void onRefreshRef.current();
    };
    window.addEventListener('focus', triggerIfDue);
    document.addEventListener('visibilitychange', triggerIfDue);
    return () => {
      window.removeEventListener('focus', triggerIfDue);
      document.removeEventListener('visibilitychange', triggerIfDue);
    };
  }, [refreshOnWindowFocus]);

  const formattedTime = lastUpdatedAt ? `${IST_TIME_FORMATTER.format(lastUpdatedAt)} IST` : 'Syncing...';

  return (
    <div
      className={`bg-white border border-slate-200 rounded-xl flex flex-wrap items-center justify-between gap-2.5 text-xs ${
        compact ? 'px-3.5 py-2' : 'px-4 py-2.5 shadow-xs'
      }`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="relative flex h-2 w-2 shrink-0">
          <span
            className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${
              isRefreshing ? 'animate-ping bg-blue-500' : 'bg-emerald-500'
            }`}
          />
          <span
            className={`relative inline-flex rounded-full h-2 w-2 ${
              isRefreshing ? 'bg-blue-600' : 'bg-emerald-600'
            }`}
          />
        </span>
        <span className="font-semibold text-slate-800">{label}</span>
        <span className="text-slate-300">·</span>
        <span className="font-mono-tabular text-slate-500 truncate">
          Last updated: <span className="text-slate-700 font-medium">{formattedTime}</span>
        </span>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <label className="flex items-center gap-1.5 text-slate-500">
          <span className="hidden sm:inline">Auto-refresh:</span>
          <select
            aria-label="Auto-refresh interval"
            value={activeSeconds}
            onChange={(e) => handleIntervalChange(Number(e.target.value))}
            className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
          >
            <option value={0}>Off</option>
            <option value={10}>10s</option>
            <option value={15}>15s</option>
            <option value={30}>30s</option>
            <option value={60}>60s</option>
          </select>
        </label>

        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={isRefreshing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-60 transition-colors whitespace-nowrap"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          {isRefreshing ? 'Refreshing...' : 'Refresh Now'}
        </button>
      </div>
    </div>
  );
};

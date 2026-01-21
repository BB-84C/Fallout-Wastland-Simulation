
import React, { useEffect, useRef, useState, useMemo, useLayoutEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HistoryEntry, Language } from '../types';

interface TerminalProps {
  history: HistoryEntry[];
  historyIndexOffset?: number;
  isThinking: boolean;
  language: Language;
  progressStages?: { label: string; status: 'idle' | 'pending' | 'running' | 'done' | 'error' | 'skipped' }[];
  stageStatusLabels?: Partial<Record<'idle' | 'pending' | 'running' | 'done' | 'error' | 'skipped', string>>;
  systemError?: string | null;
  statusManagerError?: string | null;
  systemErrorLabel?: string;
  statusErrorLabel?: string;
  compressionStatus?: string | null;
  compressionError?: string | null;
  compressionLabel?: string;
  compressionRetryLabel?: string;
  onRetryCompression?: () => void;
  onReroll?: () => void;
  canReroll?: boolean;
  rerollLabel?: string;
  forceScrollbar?: boolean;
  onFetchHistoryBefore?: (beforeIndex: number, limitEntries: number) => void | Promise<void>;
  hasMoreHistory?: boolean;
  isFetchingHistory?: boolean;
  onResolveImageUrl?: (historyIndex: number) => Promise<string | null>;
  historyFetchBatchSize?: number;
}

const Terminal: React.FC<TerminalProps> = ({
  history,
  historyIndexOffset = 0,
  isThinking,
  language,
  progressStages,
  stageStatusLabels,
  systemError,
  statusManagerError,
  systemErrorLabel,
  statusErrorLabel,
  compressionStatus,
  compressionError,
  compressionLabel,
  compressionRetryLabel,
  onRetryCompression,
  onReroll,
  canReroll,
  rerollLabel,
  forceScrollbar,
  onFetchHistoryBefore,
  hasMoreHistory,
  isFetchingHistory,
  onResolveImageUrl,
  historyFetchBatchSize
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAdjustingRef = useRef(false);
  const anchorRef = useRef<{ index: number; offset: number } | null>(null);
  const scrollTargetRef = useRef<'top' | 'bottom' | null>(null);
  const resolvingRef = useRef<Set<number>>(new Set());
  const WINDOW_STEP = 10;
  const WINDOW_MAX = WINDOW_STEP * 2;
  const SCROLL_THRESHOLD = 24;
  const indexedHistory = useMemo(
    () => history.map((entry, index) => ({ entry, historyIndex: historyIndexOffset + index })),
    [history, historyIndexOffset]
  );
  const displayHistory = indexedHistory.filter(item => item.entry.meta !== 'memory');
  const isZh = language === 'zh';
  const rounds = useMemo(() => {
    const grouped: { entry: HistoryEntry; historyIndex: number }[][] = [];
    let current: { entry: HistoryEntry; historyIndex: number }[] = [];
    displayHistory.forEach((item) => {
      if (item.entry.sender === 'player' && current.length > 0) {
        grouped.push(current);
        current = [];
      }
      current.push({ entry: item.entry, historyIndex: item.historyIndex });
    });
    if (current.length > 0) grouped.push(current);
    return grouped;
  }, [displayHistory]);
  const totalRounds = rounds.length;
  const [windowRange, setWindowRange] = useState({ start: 0, end: 0 });
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const captureAnchor = () => {
    const node = scrollRef.current;
    if (!node) return;
    const items = node.querySelectorAll<HTMLElement>('[data-history-index]');
    if (!items.length) return;
    const scrollTop = node.scrollTop;
    let anchor = items[0];
    for (const item of items) {
      if (item.offsetTop + item.offsetHeight >= scrollTop + 1) {
        anchor = item;
        break;
      }
    }
    const indexValue = Number(anchor.dataset.historyIndex);
    if (!Number.isFinite(indexValue)) return;
    anchorRef.current = { index: indexValue, offset: scrollTop - anchor.offsetTop };
  };
  const clampRange = (start: number, end: number) => {
    const clampedStart = Math.max(0, Math.min(start, totalRounds));
    const clampedEnd = Math.max(clampedStart, Math.min(end, totalRounds));
    return { start: clampedStart, end: clampedEnd };
  };
  const requestWindowRange = (start: number, end: number, force = false) => {
    const { start: clampedStart, end: clampedEnd } = clampRange(start, end);
    if (!force && clampedStart === windowRange.start && clampedEnd === windowRange.end) return;
    isAdjustingRef.current = true;
    setWindowRange({ start: clampedStart, end: clampedEnd });
  };
  const visibleRounds = rounds.slice(windowRange.start, windowRange.end);
  const visibleHistory = visibleRounds.flat();
  const handleJumpToFirst = () => {
    if (!totalRounds) return;
    scrollTargetRef.current = 'top';
    setIsPinnedToBottom(false);
    const end = Math.min(WINDOW_STEP, totalRounds);
    requestWindowRange(0, end, true);
  };
  const handleJumpToLatest = () => {
    if (!totalRounds) return;
    scrollTargetRef.current = 'bottom';
    setIsPinnedToBottom(true);
    const end = totalRounds;
    const start = Math.max(0, end - WINDOW_STEP);
    requestWindowRange(start, end, true);
  };
  const handlePageUp = () => {
    if (!totalRounds || windowRange.start <= 0) return;
    const currentSize = windowRange.end - windowRange.start || WINDOW_STEP;
    const nextStart = currentSize < WINDOW_MAX
      ? windowRange.start - WINDOW_STEP
      : windowRange.start - WINDOW_STEP;
    const nextEnd = currentSize < WINDOW_MAX
      ? windowRange.end
      : windowRange.end - WINDOW_STEP;
    const nextRange = clampRange(nextStart, nextEnd);
    scrollTargetRef.current = 'top';
    setIsPinnedToBottom(false);
    requestWindowRange(nextRange.start, nextRange.end, true);
  };
  const handlePageDown = () => {
    if (!totalRounds || windowRange.end >= totalRounds) return;
    const currentSize = windowRange.end - windowRange.start || WINDOW_STEP;
    const nextStart = currentSize < WINDOW_MAX
      ? windowRange.start
      : windowRange.start + WINDOW_STEP;
    const nextEnd = currentSize < WINDOW_MAX
      ? windowRange.end + WINDOW_STEP
      : windowRange.end + WINDOW_STEP;
    const nextRange = clampRange(nextStart, nextEnd);
    scrollTargetRef.current = 'bottom';
    setIsPinnedToBottom(nextRange.end >= totalRounds);
    requestWindowRange(nextRange.start, nextRange.end, true);
  };
  const scrollClass = forceScrollbar ? 'overflow-y-scroll' : 'overflow-y-auto';
  const markdownComponents = {
    p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
      <p className="mb-3 last:mb-0" {...props} />
    ),
    strong: (props: React.HTMLAttributes<HTMLElement>) => (
      <strong className="text-[color:var(--pip-color)]" {...props} />
    ),
    em: (props: React.HTMLAttributes<HTMLElement>) => (
      <em className="text-[color:var(--pip-color-soft)]" {...props} />
    ),
    ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
      <ul className="list-disc list-inside space-y-1 ml-2" {...props} />
    ),
    ol: (props: React.OlHTMLAttributes<HTMLOListElement>) => (
      <ol className="list-decimal list-inside space-y-1 ml-2" {...props} />
    ),
    li: (props: React.LiHTMLAttributes<HTMLLIElement>) => (
      <li className="leading-relaxed" {...props} />
    ),
    a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[color:var(--pip-color)] underline underline-offset-2 hover:text-white transition-colors"
        {...props}
      >
        {children}
      </a>
    ),
    code: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
      <code
        className="px-1 py-0.5 rounded border border-[color:rgba(var(--pip-color-rgb),0.4)] bg-[color:rgba(var(--pip-color-rgb),0.1)] text-[0.9em]"
        {...props}
      >
        {children}
      </code>
    ),
    pre: ({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) => (
      <pre
        className="mt-2 mb-3 p-3 border border-[color:rgba(var(--pip-color-rgb),0.4)] bg-black/60 overflow-x-auto text-sm"
        {...props}
      >
        {children}
      </pre>
    ),
    blockquote: ({ children, ...props }: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => (
      <blockquote className="border-l-2 border-[color:rgba(var(--pip-color-rgb),0.4)] pl-3 text-[color:var(--pip-color-soft)]" {...props}>
        {children}
      </blockquote>
    ),
    hr: (props: React.HTMLAttributes<HTMLHRElement>) => (
      <hr className="my-3 border-[color:rgba(var(--pip-color-rgb),0.3)]" {...props} />
    )
  };
  const lastPlayerIndex = (() => {
    for (let i = visibleHistory.length - 1; i >= 0; i -= 1) {
      if (visibleHistory[i].entry.sender === 'player') return i;
    }
    return -1;
  })();

  useEffect(() => {
    if (!totalRounds) {
      requestWindowRange(0, 0);
      return;
    }
    if (isPinnedToBottom) {
      const end = totalRounds;
      const start = Math.max(0, end - WINDOW_STEP);
      requestWindowRange(start, end);
      return;
    }
    const currentSize = Math.max(WINDOW_STEP, windowRange.end - windowRange.start || WINDOW_STEP);
    let start = Math.min(windowRange.start, Math.max(0, totalRounds - currentSize));
    let end = Math.min(totalRounds, start + currentSize);
    if (end - start < Math.min(currentSize, totalRounds)) {
      start = Math.max(0, end - currentSize);
    }
    requestWindowRange(start, end);
  }, [totalRounds, isPinnedToBottom, windowRange, WINDOW_STEP]);

  useEffect(() => {
    if (!scrollRef.current || !isPinnedToBottom || anchorRef.current || scrollTargetRef.current) return;
    isAdjustingRef.current = true;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    const handle = window.requestAnimationFrame(() => {
      isAdjustingRef.current = false;
    });
    return () => window.cancelAnimationFrame(handle);
  }, [visibleHistory, isThinking, systemError, statusManagerError, compressionStatus, compressionError, progressStages, isPinnedToBottom]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (scrollTargetRef.current) {
      const target = scrollTargetRef.current;
      isAdjustingRef.current = true;
      scrollTargetRef.current = null;
      node.scrollTop = target === 'top' ? 0 : node.scrollHeight;
      const handle = window.requestAnimationFrame(() => {
        isAdjustingRef.current = false;
      });
      return () => window.cancelAnimationFrame(handle);
    }
    const anchor = anchorRef.current;
    if (!node || !anchor) return;
    const target = node.querySelector<HTMLElement>(`[data-history-index="${anchor.index}"]`);
    if (!target) {
      anchorRef.current = null;
      return;
    }
    isAdjustingRef.current = true;
    node.scrollTop = target.offsetTop + anchor.offset;
    anchorRef.current = null;
    const handle = window.requestAnimationFrame(() => {
      isAdjustingRef.current = false;
    });
    return () => window.cancelAnimationFrame(handle);
  }, [visibleHistory]);

  useEffect(() => {
    if (!isAdjustingRef.current || anchorRef.current || scrollTargetRef.current) return;
    const handle = window.requestAnimationFrame(() => {
      isAdjustingRef.current = false;
    });
    return () => window.cancelAnimationFrame(handle);
  }, [windowRange, isPinnedToBottom]);

  const [resolvedImages, setResolvedImages] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!onResolveImageUrl) return;
    visibleHistory.forEach(item => {
      const historyIndex = item.historyIndex;
      if (item.entry.imageUrl || resolvedImages[historyIndex]) return;
      if (resolvingRef.current.has(historyIndex)) return;
      resolvingRef.current.add(historyIndex);
      Promise.resolve(onResolveImageUrl(historyIndex))
        .then((url) => {
          if (url) {
            setResolvedImages(prev => ({ ...prev, [historyIndex]: url }));
          }
        })
        .finally(() => {
          resolvingRef.current.delete(historyIndex);
        });
    });
  }, [visibleHistory, onResolveImageUrl, resolvedImages]);

  const effectiveHasMoreHistory = typeof hasMoreHistory === 'boolean'
    ? hasMoreHistory
    : historyIndexOffset > 0;
  const fetchBatchSize = historyFetchBatchSize ?? 80;
  const firstHistoryIndex = indexedHistory.length > 0 ? indexedHistory[0].historyIndex : historyIndexOffset;

  const stageLabel = (status: 'idle' | 'pending' | 'running' | 'done' | 'error' | 'skipped') => {
    if (stageStatusLabels && stageStatusLabels[status]) {
      return stageStatusLabels[status] as string;
    }
    switch (status) {
      case 'pending':
        return 'PENDING';
      case 'running':
        return 'RUNNING';
      case 'done':
        return 'DONE';
      case 'error':
        return 'ERROR';
      case 'skipped':
        return 'SKIPPED';
      default:
        return 'IDLE';
    }
  };

  return (
    <div className="relative flex-1 min-h-0">
      <div 
        ref={scrollRef}
        onScroll={() => {
          if (isAdjustingRef.current || !scrollRef.current) return;
          const node = scrollRef.current;
          const atTop = node.scrollTop <= SCROLL_THRESHOLD;
          const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= SCROLL_THRESHOLD;
          const canPinBottom = atBottom && windowRange.end >= totalRounds;
          if (canPinBottom !== isPinnedToBottom) {
            setIsPinnedToBottom(canPinBottom);
          }
          if (atTop && windowRange.start > 0) {
            const currentSize = windowRange.end - windowRange.start;
            captureAnchor();
            if (currentSize < WINDOW_MAX) {
              requestWindowRange(windowRange.start - WINDOW_STEP, windowRange.end);
            } else {
              requestWindowRange(windowRange.start - WINDOW_STEP, windowRange.end - WINDOW_STEP);
            }
            return;
          }
          if (
            atTop
            && windowRange.start <= 0
            && onFetchHistoryBefore
            && effectiveHasMoreHistory
            && !isFetchingHistory
          ) {
            captureAnchor();
            onFetchHistoryBefore(firstHistoryIndex, fetchBatchSize);
            return;
          }
          if (atBottom && windowRange.end < totalRounds) {
            const currentSize = windowRange.end - windowRange.start;
            captureAnchor();
            if (currentSize < WINDOW_MAX) {
              requestWindowRange(windowRange.start, windowRange.end + WINDOW_STEP);
            } else {
              requestWindowRange(windowRange.start + WINDOW_STEP, windowRange.end + WINDOW_STEP);
            }
          }
        }}
        className={`h-full ${scrollClass} p-4 space-y-6 bg-black/40 border-b border-[color:rgba(var(--pip-color-rgb),0.3)]`}
      >
        {visibleHistory.map((item, i) => (
          <div
            key={item.historyIndex}
            data-history-index={item.historyIndex}
            className={`flex flex-col ${item.entry.sender === 'player' ? 'items-end' : 'items-start'}`}
          >
          <div className={`max-w-[85%] p-3 rounded ${
            item.entry.sender === 'player' 
              ? 'bg-[color:rgba(var(--pip-color-rgb),0.1)] border border-[color:rgba(var(--pip-color-rgb),0.4)]' 
              : ''
          }`}>
            <div className="text-sm opacity-50 mb-1 uppercase tracking-widest font-bold">
              {item.entry.sender === 'player' ? '> USER LOG' : '> SYSTEM NARRATION'}
            </div>
            <div className="text-xl leading-relaxed whitespace-pre-wrap">
              {item.entry.sender === 'narrator' ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {item.entry.text}
                </ReactMarkdown>
              ) : (
                item.entry.text
              )}
            </div>
          </div>
          {(item.entry.imageUrl || resolvedImages[item.historyIndex]) && (
            <div className="mt-4 border-2 border-[color:rgba(var(--pip-color-rgb),0.5)] p-1 bg-black/60 shadow-lg max-w-2xl">
              <img
                src={item.entry.imageUrl || resolvedImages[item.historyIndex]}
                alt="Scene"
                className="w-full h-auto rounded-sm opacity-90 hover:opacity-100 transition-opacity"
              />
              <div className="text-[10px] text-center mt-1 opacity-40 uppercase">VAULT-TEC VISUAL RECONSTRUCTION</div>
              {/* Render grounding sources from Search Grounding to follow SDK requirements */}
              {item.entry.groundingSources && item.entry.groundingSources.length > 0 && (
                <div className="mt-2 p-2 border-t border-[color:rgba(var(--pip-color-rgb),0.2)] text-[10px] bg-black/20">
                  <div className="opacity-40 uppercase mb-1 font-bold">Visual References:</div>
                  <div className="flex flex-wrap gap-2">
                    {item.entry.groundingSources.map((source, idx) => (
                      <a 
                        key={idx} 
                        href={source.uri} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-[color:var(--pip-color)] hover:underline opacity-60 hover:opacity-100 transition-opacity truncate max-w-[200px]"
                      >
                        [{source.title}]
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {item.entry.sender === 'player' && i === lastPlayerIndex && onReroll && canReroll && (
            <button
              onClick={onReroll}
              className="mt-2 text-[10px] uppercase border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold disabled:opacity-40"
            >
              {rerollLabel || 'REROLL'}
            </button>
          )}
        </div>
      ))}
        {compressionStatus && (
          <div className="border border-[color:rgba(var(--pip-color-rgb),0.4)] bg-[color:rgba(var(--pip-color-rgb),0.1)] p-3 text-sm whitespace-pre-wrap">
            <div className="text-[10px] uppercase opacity-60 mb-1 font-bold">
              {compressionLabel || '> SYSTEM LOG'}
            </div>
            <div className="opacity-90">{compressionStatus}</div>
          </div>
        )}
        {compressionError && (
          <div className="border border-[color:rgba(var(--pip-color-rgb),0.4)] bg-[color:rgba(var(--pip-color-rgb),0.1)] p-3 text-sm whitespace-pre-wrap">
            <div className="text-[10px] uppercase opacity-60 mb-1 font-bold">
              {compressionLabel || '> SYSTEM LOG'}
            </div>
            <div className="opacity-90">{compressionError}</div>
          {onRetryCompression && (
            <button
              onClick={onRetryCompression}
              className="mt-3 text-[10px] uppercase border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold"
            >
              {compressionRetryLabel || 'RETRY'}
            </button>
          )}
          </div>
        )}
        {progressStages && progressStages.length > 0 && (
          <div className="border border-[color:rgba(var(--pip-color-rgb),0.4)] bg-[color:rgba(var(--pip-color-rgb),0.1)] p-3 text-sm whitespace-pre-wrap">
            <div className="text-[10px] uppercase opacity-60 mb-2 font-bold">
              {systemErrorLabel || '> SYSTEM LOG'}
            </div>
            <div className="space-y-1">
            {progressStages.map(stage => (
              <div key={stage.label} className="flex items-center justify-between text-xs">
                <span className="uppercase opacity-70">{stage.label}</span>
                <span className={`uppercase ${stage.status === 'error' ? 'text-[#ff6b6b]' : stage.status === 'done' ? 'text-[color:var(--pip-color)]' : 'opacity-70'}`}>
                  {stageLabel(stage.status)}
                </span>
              </div>
            ))}
          </div>
          </div>
        )}
        {statusManagerError && (
          <div className="border border-[color:rgba(var(--pip-color-rgb),0.4)] bg-[color:rgba(var(--pip-color-rgb),0.1)] p-3 text-sm whitespace-pre-wrap">
            <div className="text-[10px] uppercase opacity-60 mb-1 font-bold">
              {statusErrorLabel || systemErrorLabel || '> SYSTEM LOG'}
            </div>
            <div className="opacity-90">{statusManagerError}</div>
          </div>
        )}
        {systemError && (
          <div className="border border-[color:rgba(var(--pip-color-rgb),0.4)] bg-[color:rgba(var(--pip-color-rgb),0.1)] p-3 text-sm whitespace-pre-wrap">
            <div className="text-[10px] uppercase opacity-60 mb-1 font-bold">
              {systemErrorLabel || '> SYSTEM ERROR'}
            </div>
            <div className="opacity-90">{systemError}</div>
          </div>
        )}
        {isThinking && (
          <div className="flex items-center space-x-2 animate-pulse text-[color:var(--pip-color)]">
            <span className="text-lg font-bold">ACCESSING DATABASE...</span>
            <div className="flex space-x-1">
              <div className="w-2 h-2 bg-[color:var(--pip-color)] rounded-full"></div>
              <div className="w-2 h-2 bg-[color:var(--pip-color)] rounded-full"></div>
              <div className="w-2 h-2 bg-[color:var(--pip-color)] rounded-full"></div>
            </div>
          </div>
        )}
      </div>
      <div className="absolute right-2 top-2 flex flex-col gap-2">
        <button
          onClick={handleJumpToFirst}
          disabled={windowRange.start <= 0}
          className="text-[10px] uppercase border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 bg-black/60 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold disabled:opacity-40"
        >
          {isZh ? '到最前' : 'To the First'}
        </button>
        <button
          onClick={handlePageUp}
          disabled={windowRange.start <= 0}
          className="text-[10px] uppercase border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 bg-black/60 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold disabled:opacity-40"
        >
          {isZh ? '上翻' : 'To Top'}
        </button>
      </div>
      <div className="absolute right-2 bottom-2 flex flex-col gap-2">
        <button
          onClick={handlePageDown}
          disabled={windowRange.end >= totalRounds}
          className="text-[10px] uppercase border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 bg-black/60 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold disabled:opacity-40"
        >
          {isZh ? '下翻' : 'To Bottom'}
        </button>
        <button
          onClick={handleJumpToLatest}
          disabled={windowRange.end >= totalRounds}
          className="text-[10px] uppercase border border-[color:rgba(var(--pip-color-rgb),0.5)] px-2 py-1 bg-black/60 hover:bg-[color:var(--pip-color)] hover:text-black transition-colors font-bold disabled:opacity-40"
        >
          {isZh ? '到最新' : 'To the Latest'}
        </button>
      </div>
    </div>
  );
};

export default Terminal;

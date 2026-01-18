
import React, { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HistoryEntry } from '../types';

interface TerminalProps {
  history: HistoryEntry[];
  isThinking: boolean;
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
}

const Terminal: React.FC<TerminalProps> = ({
  history,
  isThinking,
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
  forceScrollbar
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const displayHistory = history.filter(entry => entry.meta !== 'memory');
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
    for (let i = displayHistory.length - 1; i >= 0; i -= 1) {
      if (displayHistory[i].sender === 'player') return i;
    }
    return -1;
  })();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayHistory, isThinking, systemError, statusManagerError, compressionStatus, compressionError, progressStages]);

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
    <div 
      ref={scrollRef}
      className={`flex-1 ${scrollClass} p-4 space-y-6 bg-black/40 border-b border-[color:rgba(var(--pip-color-rgb),0.3)]`}
    >
      {displayHistory.map((msg, i) => (
        <div key={i} className={`flex flex-col ${msg.sender === 'player' ? 'items-end' : 'items-start'}`}>
          <div className={`max-w-[85%] p-3 rounded ${
            msg.sender === 'player' 
              ? 'bg-[color:rgba(var(--pip-color-rgb),0.1)] border border-[color:rgba(var(--pip-color-rgb),0.4)]' 
              : ''
          }`}>
            <div className="text-sm opacity-50 mb-1 uppercase tracking-widest font-bold">
              {msg.sender === 'player' ? '> USER LOG' : '> SYSTEM NARRATION'}
            </div>
            <div className="text-xl leading-relaxed whitespace-pre-wrap">
              {msg.sender === 'narrator' ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {msg.text}
                </ReactMarkdown>
              ) : (
                msg.text
              )}
            </div>
          </div>
          {msg.imageUrl && (
            <div className="mt-4 border-2 border-[color:rgba(var(--pip-color-rgb),0.5)] p-1 bg-black/60 shadow-lg max-w-2xl">
              <img src={msg.imageUrl} alt="Scene" className="w-full h-auto rounded-sm opacity-90 hover:opacity-100 transition-opacity" />
              <div className="text-[10px] text-center mt-1 opacity-40 uppercase">VAULT-TEC VISUAL RECONSTRUCTION</div>
              {/* Render grounding sources from Search Grounding to follow SDK requirements */}
              {msg.groundingSources && msg.groundingSources.length > 0 && (
                <div className="mt-2 p-2 border-t border-[color:rgba(var(--pip-color-rgb),0.2)] text-[10px] bg-black/20">
                  <div className="opacity-40 uppercase mb-1 font-bold">Visual References:</div>
                  <div className="flex flex-wrap gap-2">
                    {msg.groundingSources.map((source, idx) => (
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
          {msg.sender === 'player' && i === lastPlayerIndex && onReroll && canReroll && (
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
  );
};

export default Terminal;

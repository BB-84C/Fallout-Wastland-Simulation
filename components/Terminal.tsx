
import React, { useEffect, useRef } from 'react';
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
      className={`flex-1 ${scrollClass} p-4 space-y-6 bg-black/40 border-b border-[#1aff1a]/30`}
    >
      {displayHistory.map((msg, i) => (
        <div key={i} className={`flex flex-col ${msg.sender === 'player' ? 'items-end' : 'items-start'}`}>
          <div className={`max-w-[85%] p-3 rounded ${
            msg.sender === 'player' 
              ? 'bg-[#1aff1a]/10 border border-[#1aff1a]/40' 
              : ''
          }`}>
            <div className="text-sm opacity-50 mb-1 uppercase tracking-widest font-bold">
              {msg.sender === 'player' ? '> USER LOG' : '> SYSTEM NARRATION'}
            </div>
            <div className="text-xl leading-relaxed whitespace-pre-wrap">
              {msg.text}
            </div>
          </div>
          {msg.imageUrl && (
            <div className="mt-4 border-2 border-[#1aff1a]/50 p-1 bg-black/60 shadow-lg max-w-2xl">
              <img src={msg.imageUrl} alt="Scene" className="w-full h-auto rounded-sm opacity-90 hover:opacity-100 transition-opacity" />
              <div className="text-[10px] text-center mt-1 opacity-40 uppercase">VAULT-TEC VISUAL RECONSTRUCTION</div>
              {/* Render grounding sources from Search Grounding to follow SDK requirements */}
              {msg.groundingSources && msg.groundingSources.length > 0 && (
                <div className="mt-2 p-2 border-t border-[#1aff1a]/20 text-[10px] bg-black/20">
                  <div className="opacity-40 uppercase mb-1 font-bold">Visual References:</div>
                  <div className="flex flex-wrap gap-2">
                    {msg.groundingSources.map((source, idx) => (
                      <a 
                        key={idx} 
                        href={source.uri} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-[#1aff1a] hover:underline opacity-60 hover:opacity-100 transition-opacity truncate max-w-[200px]"
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
              className="mt-2 text-[10px] uppercase border border-[#1aff1a]/50 px-2 py-1 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold disabled:opacity-40"
            >
              {rerollLabel || 'REROLL'}
            </button>
          )}
        </div>
      ))}
      {compressionStatus && (
        <div className="border border-[#1aff1a]/40 bg-[#1aff1a]/10 p-3 text-sm whitespace-pre-wrap">
          <div className="text-[10px] uppercase opacity-60 mb-1 font-bold">
            {compressionLabel || '> SYSTEM LOG'}
          </div>
          <div className="opacity-90">{compressionStatus}</div>
        </div>
      )}
      {compressionError && (
        <div className="border border-[#1aff1a]/40 bg-[#1aff1a]/10 p-3 text-sm whitespace-pre-wrap">
          <div className="text-[10px] uppercase opacity-60 mb-1 font-bold">
            {compressionLabel || '> SYSTEM LOG'}
          </div>
          <div className="opacity-90">{compressionError}</div>
          {onRetryCompression && (
            <button
              onClick={onRetryCompression}
              className="mt-3 text-[10px] uppercase border border-[#1aff1a]/50 px-2 py-1 hover:bg-[#1aff1a] hover:text-black transition-colors font-bold"
            >
              {compressionRetryLabel || 'RETRY'}
            </button>
          )}
        </div>
      )}
      {progressStages && progressStages.length > 0 && (
        <div className="border border-[#1aff1a]/40 bg-[#1aff1a]/10 p-3 text-sm whitespace-pre-wrap">
          <div className="text-[10px] uppercase opacity-60 mb-2 font-bold">
            {systemErrorLabel || '> SYSTEM LOG'}
          </div>
          <div className="space-y-1">
            {progressStages.map(stage => (
              <div key={stage.label} className="flex items-center justify-between text-xs">
                <span className="uppercase opacity-70">{stage.label}</span>
                <span className={`uppercase ${stage.status === 'error' ? 'text-[#ff6b6b]' : stage.status === 'done' ? 'text-[#1aff1a]' : 'opacity-70'}`}>
                  {stageLabel(stage.status)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {statusManagerError && (
        <div className="border border-[#1aff1a]/40 bg-[#1aff1a]/10 p-3 text-sm whitespace-pre-wrap">
          <div className="text-[10px] uppercase opacity-60 mb-1 font-bold">
            {statusErrorLabel || systemErrorLabel || '> SYSTEM LOG'}
          </div>
          <div className="opacity-90">{statusManagerError}</div>
        </div>
      )}
      {systemError && (
        <div className="border border-[#1aff1a]/40 bg-[#1aff1a]/10 p-3 text-sm whitespace-pre-wrap">
          <div className="text-[10px] uppercase opacity-60 mb-1 font-bold">
            {systemErrorLabel || '> SYSTEM ERROR'}
          </div>
          <div className="opacity-90">{systemError}</div>
        </div>
      )}
      {isThinking && (
        <div className="flex items-center space-x-2 animate-pulse text-[#1aff1a]">
          <span className="text-lg font-bold">ACCESSING DATABASE...</span>
          <div className="flex space-x-1">
            <div className="w-2 h-2 bg-[#1aff1a] rounded-full"></div>
            <div className="w-2 h-2 bg-[#1aff1a] rounded-full"></div>
            <div className="w-2 h-2 bg-[#1aff1a] rounded-full"></div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Terminal;

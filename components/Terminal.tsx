
import React, { useEffect, useRef } from 'react';
import { HistoryEntry } from '../types';

interface TerminalProps {
  history: HistoryEntry[];
  isThinking: boolean;
  systemError?: string | null;
  systemErrorLabel?: string;
  compressionStatus?: string | null;
  compressionError?: string | null;
  compressionLabel?: string;
  compressionRetryLabel?: string;
  onRetryCompression?: () => void;
  onReroll?: () => void;
  canReroll?: boolean;
  rerollLabel?: string;
}

const Terminal: React.FC<TerminalProps> = ({
  history,
  isThinking,
  systemError,
  systemErrorLabel,
  compressionStatus,
  compressionError,
  compressionLabel,
  compressionRetryLabel,
  onRetryCompression,
  onReroll,
  canReroll,
  rerollLabel
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const displayHistory = history.filter(entry => entry.meta !== 'memory');
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
  }, [displayHistory, isThinking, systemError, compressionStatus, compressionError]);

  return (
    <div 
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-4 space-y-6 bg-black/40 border-b border-[#1aff1a]/30"
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

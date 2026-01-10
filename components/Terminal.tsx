
import React, { useEffect, useRef } from 'react';

interface Message {
  sender: 'player' | 'narrator';
  text: string;
  imageUrl?: string;
}

interface TerminalProps {
  history: Message[];
  isThinking: boolean;
}

const Terminal: React.FC<TerminalProps> = ({ history, isThinking }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [history, isThinking]);

  return (
    <div 
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-4 space-y-6 bg-black/40 border-b border-[#1aff1a]/30"
    >
      {history.map((msg, i) => (
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
            </div>
          )}
        </div>
      ))}
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

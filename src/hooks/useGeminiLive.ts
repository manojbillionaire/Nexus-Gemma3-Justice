import { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { float32ToInt16PCM, int16PCMToFloat32, SAMPLE_RATE, createAudioContext } from '../lib/audio-utils';

export interface Message {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export function useGeminiLive() {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);

  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const nextStartTimeRef = useRef(0);

  const playQueuedAudio = useCallback(() => {
    if (!audioContextRef.current || audioQueueRef.current.length === 0 || isPlayingRef.current) return;

    isPlayingRef.current = true;
    const chunk = audioQueueRef.current.shift()!;
    const buffer = audioContextRef.current.createBuffer(1, chunk.length, audioContextRef.current.sampleRate);
    buffer.getChannelData(0).set(chunk);

    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);

    const startTime = Math.max(audioContextRef.current.currentTime, nextStartTimeRef.current);
    source.start(startTime);
    nextStartTimeRef.current = startTime + buffer.duration;

    source.onended = () => {
      isPlayingRef.current = false;
      if (audioQueueRef.current.length > 0) {
        playQueuedAudio();
      } else {
        setIsModelSpeaking(false);
      }
    };
  }, []);

  const connect = useCallback(async () => {
    if (isConnected || isConnecting) return;
    setIsConnecting(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      
      audioContextRef.current = createAudioContext();
      
      const session = await ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: "You are Nexus, a highly advanced AI voice assistant. Your goal is to be helpful, concise, and engaging. You speak naturally and can handle interruptions. Keep your responses brief for a better voice experience.",
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setIsConnecting(false);
            console.log("Gemini Live connected");
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.modelTurn) {
              const parts = message.serverContent.modelTurn.parts;
              for (const part of parts) {
                if (part.inlineData?.data) {
                  const audioData = int16PCMToFloat32(part.inlineData.data);
                  audioQueueRef.current.push(audioData);
                  setIsModelSpeaking(true);
                  playQueuedAudio();
                }
                if (part.text) {
                  setMessages(prev => [...prev, { role: 'model', text: part.text!, timestamp: Date.now() }]);
                }
              }
            }

            if (message.serverContent?.interrupted) {
              audioQueueRef.current = [];
              isPlayingRef.current = false;
              setIsModelSpeaking(false);
              nextStartTimeRef.current = 0;
            }
          },
          onclose: () => {
            setIsConnected(false);
            setIsConnecting(false);
            console.log("Gemini Live closed");
          },
          onerror: (error) => {
            console.error("Gemini Live error:", error);
            setIsConnecting(false);
          }
        }
      });

      sessionRef.current = session;

      // Start microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const source = audioContextRef.current.createMediaStreamSource(stream);
      const processor = audioContextRef.current.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Calculate volume for visualizer
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        setVolume(Math.sqrt(sum / inputData.length));

        // Send audio to Gemini
        const pcmData = float32ToInt16PCM(inputData);
        session.sendRealtimeInput({
          audio: { data: pcmData, mimeType: `audio/pcm;rate=${SAMPLE_RATE}` }
        });
      };

      source.connect(processor);
      processor.connect(audioContextRef.current.destination);

    } catch (error) {
      console.error("Failed to connect:", error);
      setIsConnecting(false);
    }
  }, [isConnected, isConnecting, playQueuedAudio]);

  const disconnect = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setIsConnected(false);
    setVolume(0);
  }, []);

  return {
    isConnected,
    isConnecting,
    messages,
    isModelSpeaking,
    volume,
    connect,
    disconnect
  };
}

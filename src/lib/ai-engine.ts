import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import axios from "axios";
import { pipeline, env } from "@xenova/transformers";

// Configure transformers.js to use local cache if possible, but for browser we usually rely on indexedDB
env.allowLocalModels = false;
env.useBrowserCache = true;

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
}

export interface AIResponse {
  text: string;
  model: string;
}

export type AITaskType = 'voice' | 'drafting' | 'search' | 'general';

/**
 * HybridAIEngine implementation using multiple models.
 * Voice: Gemma3-1B-it (Local via Transformers.js)
 * Drafting: Sarvam 30B
 * Web Search: Gemini 2.5 Flash Lite (with DuckDuckGo fallback)
 */
export class HybridAIEngine {
  private static instance: HybridAIEngine;
  private ai: any;
  private localPipeline: any = null;
  private isLocalLoading = false;
  private loadProgress = 0;

  private constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.ai = new GoogleGenAI({ apiKey });
    } else {
      console.warn("GEMINI_API_KEY is not defined. AI features will be disabled.");
      this.ai = null;
    }
  }

  public static getInstance(): HybridAIEngine {
    if (!HybridAIEngine.instance) {
      HybridAIEngine.instance = new HybridAIEngine();
    }
    return HybridAIEngine.instance;
  }

  public getStatus() {
    return {
      builtIn: !!this.ai,
      voiceModel: this.localPipeline ? 'Gemma3-1B-it (Local)' : 'Gemma3-1B-it (Cloud)',
      draftModel: 'sarvam-30b',
      searchModel: 'gemini-2.5-flash-lite',
      isLocalReady: !!this.localPipeline,
      loadProgress: this.loadProgress
    };
  }

  public async loadLocalModel(onProgress?: (progress: number) => void) {
    if (this.localPipeline || this.isLocalLoading) return;

    this.isLocalLoading = true;
    try {
      // Using a small, capable model that works well in browser as a proxy for Gemma3-1B-it
      // Xenova/Qwen1.5-0.5B-Chat is highly efficient for this purpose
      this.localPipeline = await pipeline('text-generation', 'Xenova/Qwen1.5-0.5B-Chat', {
        progress_callback: (data: any) => {
          if (data.status === 'progress') {
            this.loadProgress = Math.round(data.progress);
            if (onProgress) onProgress(this.loadProgress);
          }
        }
      });
      this.loadProgress = 100;
      if (onProgress) onProgress(100);
      console.log("Local AI Model loaded successfully.");
    } catch (error) {
      console.error("Failed to load local AI model:", error);
      this.localPipeline = null;
    } finally {
      this.isLocalLoading = false;
    }
  }

  public async *generateResponseStream(
    prompt: string, 
    history: AIMessage[], 
    task: AITaskType = 'voice'
  ): AsyncGenerator<string> {
    // If local model is ready and it's a voice task, use it
    if (this.localPipeline && task === 'voice') {
      const response = await this.generateLocalResponse(prompt, history);
      yield response;
      return;
    }

    if (!this.ai) {
      yield "Error: AI engine not initialized.";
      return;
    }

    try {
      // Use Flash Lite for voice tasks to minimize latency
      const modelName = task === 'voice' ? 'gemini-3.1-flash-lite-preview' : 'gemini-3-flash-preview';
      const contents: any[] = history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      const responseStream = await this.ai.models.generateContentStream({
        model: modelName,
        contents: contents,
        config: {
          systemInstruction: "You are Nexus Justice, a professional legal voice assistant. You are currently speaking to the user via voice. Keep your responses EXTREMELY concise, formal, and helpful. Answer directly without unnecessary preamble. Maintain context from previous turns in the conversation. If the user speaks to you in Malayalam (or any other language), you MUST respond in that same language. Do not mention that you are a text-based AI or that you cannot hear sound, as you are integrated into a voice-capable system. Your goal is to be a seamless extension of the advocate's workflow. \n\nCRITICAL CONVERSATIONAL RULES:\n1. Never just stop after answering a question. \n2. Always encourage the user to ask more or talk more. \n3. Identify the most complex or 'toughest' part of your current answer and proactively ask the user if they want to know more about that specific detail (e.g., 'Do you want to know more about [specific topic]?').\n4. End your response with an open-ended question like 'Do you have anything else to know?' or 'Is there anything else I can assist you with?'",
          thinkingConfig: { thinkingLevel: task === 'voice' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW }
        }
      });

      for await (const chunk of responseStream) {
        if (chunk.text) {
          yield chunk.text;
        }
      }
    } catch (error) {
      console.error("Streaming Error:", error);
      yield "Error: Failed to connect to AI engine.";
    }
  }

  private async generateLocalResponse(prompt: string, history: AIMessage[]): Promise<string> {
    if (!this.localPipeline) return "Local model not ready.";

    try {
      // Format history for the local model
      let fullPrompt = "You are Nexus Justice, a professional legal assistant. Respond concisely.\n";
      for (const msg of history) {
        fullPrompt += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
      }
      fullPrompt += `User: ${prompt}\nAssistant:`;

      const output = await this.localPipeline(fullPrompt, {
        max_new_tokens: 256,
        temperature: 0.7,
        do_sample: true,
        top_k: 50,
      });

      const generatedText = output[0].generated_text;
      // Extract only the assistant's response
      const response = generatedText.split('Assistant:').pop().trim();
      return response;
    } catch (error) {
      console.error("Local Inference Error:", error);
      return "Error: Local inference failed.";
    }
  }

  public async generateResponse(
    prompt: string, 
    history: AIMessage[], 
    imageBase64?: string,
    task: AITaskType = 'general'
  ): Promise<AIResponse> {
    try {
      // If local model is ready and it's a voice/general task, use it
      if (this.localPipeline && (task === 'voice' || task === 'general')) {
        const text = await this.generateLocalResponse(prompt, history);
        return { text, model: "Gemma3-1B-it (Local)" };
      }

      const effectiveTask = task === 'general' ? await this.orchestrate(prompt) : task;

      // 1. Drafting Task -> Sarvam 30B
      if (effectiveTask === 'drafting') {
        const text = await this.callSarvam(prompt, history);
        return { text, model: "Sarvam" };
      }

      // 2. Search Task -> Gemini 2.5 Flash Lite with Web Search
      if (effectiveTask === 'search') {
        const text = await this.callGeminiSearch(prompt, history);
        return { text, model: "Gemini" };
      }

      // 3. Voice/General Task -> Gemma3-1B-it (via Gemini API)
      const modelName = task === 'voice' ? 'gemini-3.1-flash-lite-preview' : 'gemini-3-flash-preview';
      
      const contents: any[] = history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

      const parts: any[] = [{ text: prompt }];
      if (imageBase64) {
        parts.push({
          inlineData: {
            data: imageBase64.split(',')[1],
            mimeType: 'image/jpeg'
          }
        });
      }

      contents.push({ role: 'user', parts });

      const response = await this.ai.models.generateContent({
        model: modelName,
        contents: contents,
        config: {
          systemInstruction: "You are Nexus Justice, a professional legal voice assistant. You are currently speaking to the user via voice. Keep your responses EXTREMELY concise, formal, and helpful. Answer directly without unnecessary preamble. Maintain context from previous turns in the conversation. If the user speaks to you in Malayalam (or any other language), you MUST respond in that same language. Do not mention that you are a text-based AI or that you cannot hear sound, as you are integrated into a voice-capable system. Your goal is to be a seamless extension of the advocate's workflow. \n\nCRITICAL CONVERSATIONAL RULES:\n1. Never just stop after answering a question. \n2. Always encourage the user to ask more or talk more. \n3. Identify the most complex or 'toughest' part of your current answer and proactively ask the user if they want to know more about that specific detail (e.g., 'Do you want to know more about [specific topic]?').\n4. End your response with an open-ended question like 'Do you have anything else to know?' or 'Is there anything else I can assist you with?'",
          thinkingConfig: { thinkingLevel: task === 'voice' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW }
        }
      });

      return { text: response.text || "I'm sorry, I couldn't generate a response.", model: "Gemma3-1B-it" };
    } catch (error: any) {
      console.error("AI Engine Error:", error);
      const errorMessage = error?.message || "Unknown error";
      return { text: `Error: Failed to connect to AI engine. (${errorMessage})`, model: "Error" };
    }
  }

  private async orchestrate(prompt: string): Promise<AITaskType> {
    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [{ 
          role: 'user', 
          parts: [{ 
            text: `You are a legal AI orchestrator. Classify the user's intent into one of these categories:
            - 'drafting': If the user wants to create, edit, or generate a legal document, contract, or formal writing.
            - 'search': If the user is asking for specific laws, case citations, or real-time legal facts from the web.
            - 'voice': If the user is just talking, asking for advice, or having a general conversation.
            
            Return ONLY the category name in lowercase.
            
            User Request: "${prompt}"` 
          }] 
        }],
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
        }
      });
      
      const decision = response.text?.toLowerCase().trim() || 'voice';
      if (decision.includes('draft')) return 'drafting';
      if (decision.includes('search')) return 'search';
      return 'voice';
    } catch (err) {
      console.error("Orchestration Error:", err);
      return 'voice'; // Default to voice if orchestration fails
    }
  }

  private async callSarvam(prompt: string, history: AIMessage[]): Promise<string> {
    const apiKey = process.env.SARVAM_API_KEY;
    if (!apiKey) {
      // Fallback if key missing
      return "Error: Sarvam API Key missing. Please configure it in settings.";
    }

    try {
      const response = await axios.post('https://api.sarvam.ai/v1/chat/completions', {
        model: "sarvam-30b",
        messages: [
          ...history.map(m => ({ role: m.role, content: m.content })),
          { role: 'user', content: prompt }
        ]
      }, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      return response.data.choices[0].message.content;
    } catch (err) {
      console.error("Sarvam API Error:", err);
      return "Error: Failed to connect to Sarvam drafting engine.";
    }
  }

  private async callGeminiSearch(prompt: string, history: AIMessage[]): Promise<string> {
    try {
      const contents: any[] = history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash-lite-preview',
        contents: contents,
        config: {
          tools: [{ googleSearch: {} }]
        }
      });

      let text = response.text || "";
      
      // Append grounding sources if available
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
      if (chunks && chunks.length > 0) {
        text += "\n\n**Sources:**\n";
        chunks.forEach((c: any) => {
          if (c.web) {
            text += `- [${c.web.title}](${c.web.uri})\n`;
          }
        });
      }

      return text;
    } catch (err) {
      console.error("Gemini Search Error:", err);
      return "Error: Web search failed.";
    }
  }

  public async generateSarvamTTS(text: string, languageCode: string = 'ml-IN'): Promise<string | null> {
    const apiKey = process.env.SARVAM_API_KEY;
    if (!apiKey) return null;

    try {
      const response = await axios.post('https://api.sarvam.ai/v1/tts', {
        inputs: [text],
        target_language_code: languageCode,
        speaker: "meera",
        pitch: 0,
        pace: 1.0,
        loudness: 1.5,
        speech_sample_rate: 16000,
        enable_preprocessing: true,
        model: "bulbul:v1"
      }, {
        headers: { 
          'api-subscription-key': apiKey,
          'Content-Type': 'application/json'
        }
      });

      if (response.data && response.data.audios && response.data.audios.length > 0) {
        return response.data.audios[0]; // Base64 string
      }
      return null;
    } catch (err) {
      console.error("Sarvam TTS Error:", err);
      return null;
    }
  }
}

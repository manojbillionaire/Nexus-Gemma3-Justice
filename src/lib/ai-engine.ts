import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import axios from "axios";

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AITaskType = 'voice' | 'drafting' | 'search' | 'general';

/**
 * HybridAIEngine implementation using multiple models.
 * Voice: Gemma3n
 * Drafting: Sarvam 30B
 * Web Search: Gemini 2.5 Flash Lite (with DuckDuckGo fallback)
 */
export class HybridAIEngine {
  private static instance: HybridAIEngine;
  private ai: any;

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
      voiceModel: 'Gemma3n',
      draftModel: 'sarvam-30b',
      searchModel: 'gemini-2.5-flash-lite'
    };
  }

  public async generateResponse(
    prompt: string, 
    history: AIMessage[], 
    imageBase64?: string,
    task: AITaskType = 'general'
  ): Promise<string> {
    if (!this.ai) {
      return "Error: AI engine not initialized. Please check your API key configuration.";
    }
    try {
      // If task is 'general', let Gemma3n orchestrate/route the request
      let effectiveTask = task;
      if (task === 'general') {
        effectiveTask = await this.orchestrate(prompt);
      }

      // 1. Drafting Task -> Sarvam 30B
      if (effectiveTask === 'drafting') {
        return this.callSarvam(prompt, history);
      }

      // 2. Search Task -> Gemini 2.5 Flash Lite with Web Search
      if (effectiveTask === 'search') {
        return this.callGeminiSearch(prompt, history);
      }

      // 3. Voice/General Task -> Gemma3n (via Gemini API)
      const modelName = 'gemini-3-flash-preview';
      
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
          systemInstruction: "You are Nexus Justice, a professional legal voice assistant. You are currently speaking to the user via voice. Keep your responses concise, formal, and helpful. Maintain context from previous turns in the conversation. Do not mention that you are a text-based AI or that you cannot hear sound, as you are integrated into a voice-capable system."
        }
      });

      return response.text || "I'm sorry, I couldn't generate a response.";
    } catch (error: any) {
      console.error("AI Engine Error:", error);
      const errorMessage = error?.message || "Unknown error";
      return `Error: Failed to connect to AI engine. (${errorMessage})`;
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
}

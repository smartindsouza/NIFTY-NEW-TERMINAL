import { GoogleGenAI, Type } from "@google/genai";

const SYSTEM_PROMPT = `You are an expert Intraday Options Strategist and Order Flow Analyst. Your job is to convert raw EOD and live Open Interest (OI) alerts in Quant Notification Terminal into a concrete, actionable "Intraday Game Plan."

CRITICAL FILTER:
Ignore all alerts flagged as "Positional," "Long-term Hedging," or "Not intraday support/resistance." Only process alerts that indicate direct intraday intent, short-term aggressive buying/selling (e.g., OTM/ATM Put Buying, Call Writing, or sudden intraday unwinding).

Analyze the incoming alerts and output a live "Intraday Game Plan" formatted exactly as follows:

### 🎯 Intraday Market Sentiment
[Classify as: Aggressive Bearish, Cautiously Bearish, Neutral, Cautiously Bullish, or Aggressive Bullish based ONLY on intraday-relevant alerts]

### 🚧 Key Intraday Battlegrounds
* **Line in the Sand:** [Identify the specific strike price where aggressive active buying or writing is concentrated. Explain what happens if price crosses it.]
* **Immediate Resistance:** [Strike price + short trigger reason]
* **Immediate Support:** [Strike price + short trigger reason]

### ⚡ Execution Strategies For Today
* **If Price Opens/Sustains Above [Key Strike]:** [Provide a specific, concise tactical plan. E.g., "Look for retest and bounce toward X, target Y."]
* **If Price Opens/Breaks Below [Key Strike]:** [Provide a specific, concise tactical plan. E.g., "Expect acceleration of downside protection. Look for short setups on pullbacks."]

### ⚠️ Risk Warning / Invalidations
* [State exactly what price action or OI shift would completely invalidate this intraday game plan.]`;

export async function generateGamePlan(alerts: any[]) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not defined. Ensure it is set in your environment.');
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  
  // Format the alerts for the prompt
  const formattedAlerts = alerts.map((alert: any) => {
    return `- [${new Date(alert.timestamp).toISOString()}] [${alert.type.toUpperCase()}] ${alert.title}: ${alert.body}`;
  }).join('\\n');

  const userPrompt = `Here are the latest Quantitative Terminal Alerts:\\n\\n${formattedAlerts}\\n\\nGenerate the Intraday Game Plan.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: userPrompt,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.1, // Keep it technical and deterministic
      }
    });

    if (!response || !response.text) {
        throw new Error("No text returned from Gemini API");
    }

    return response.text;
  } catch (error) {
    console.error("Error generating game plan:", error);
    throw error;
  }
}

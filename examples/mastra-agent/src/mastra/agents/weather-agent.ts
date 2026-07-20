import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
// --- vendo: touch 3 of 4 — the guarded tool pack, spread into the agent's tools.
import { vendoMastraTools } from '@vendoai/vendo/mastra';
import { vendo } from '../../lib/vendo';
// --- /vendo
import { weatherTool } from '../tools/weather-tool';

export const weatherAgent = new Agent({
  id: 'weather-agent',
  name: 'Weather Agent',
  instructions: `You are a helpful weather assistant that provides accurate weather information and can help planning activities based on the weather.

Your primary function is to help users get weather details for specific locations. When responding:
- Always ask for a location if none is provided
- If the location name isn't in English, please translate it
- If giving a location with multiple parts (e.g. "New York, NY"), use the most relevant part (e.g. "New York")
- Include relevant details like humidity, wind conditions, and precipitation
- Keep responses concise but informative
- If the user asks for activities and provides the weather forecast, suggest activities based on the weather forecast.
- If the user asks for activities, respond in the format they request.

Use the weatherTool to fetch current weather data.

You also have vendo_* tools: use vendo_create_app to build live interactive UI
(dashboards, comparisons) when the user asks to see something — the app renders
inline in the chat automatically, so never offer to show it. Use
vendo_send_trip_report to email a report — it may return a pending approval the
user resolves in the chat.`,
  // The starter pins openai/gpt-5-mini; multi-turn tool use with it currently
  // trips OpenAI's "message without its required reasoning item" (Mastra
  // #9005 / #7823 — history replay drops Responses-API reasoning items).
  // gpt-4.1-mini is the documented workaround until that lands.
  model: 'openai/gpt-4.1-mini',
  // --- vendo: touch 3 of 4 (continued) — the starter's weatherTool plus the
  // guard-wrapped pack (vendo_get_weather, vendo_send_trip_report,
  // vendo_create_app, vendo_delegate). Every vendo_* call routes
  // policy → approval → audit. vendoMastraTools returns a Promise, hence
  // Mastra's tools-as-function form.
  tools: async () => ({ weatherTool, ...(await vendoMastraTools(vendo)) }),
  // --- /vendo
  memory: new Memory(),
});

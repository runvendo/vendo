// VENDO — the two host actions .vendo/tools.json registers: the weather
// lookup (risk: "read", so generated apps can query live data) and a
// deliberately risky send action (risk: "write") that exercises Vendo's
// approval flow. In a real product sendTripReport would email; the demo
// records it and logs.

interface GeocodingResponse {
  results?: { latitude: number; longitude: number; name: string }[];
}
interface WeatherResponse {
  current: {
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    wind_gusts_10m: number;
    weather_code: number;
  };
}

/** Same open-meteo lookup as the starter's weatherTool, exposed as a Vendo
 *  host action so generated apps (and the pack) can fetch live weather. */
export async function getWeather(location: string): Promise<{
  location: string;
  temperature: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  windGust: number;
  conditions: string;
}> {
  const geocodingUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
  const geocodingData = (await (await fetch(geocodingUrl)).json()) as GeocodingResponse;
  const place = geocodingData.results?.[0];
  if (!place) throw new Error(`Location '${location}' not found`);
  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code`;
  const data = (await (await fetch(weatherUrl)).json()) as WeatherResponse;
  return {
    location: place.name,
    temperature: data.current.temperature_2m,
    feelsLike: data.current.apparent_temperature,
    humidity: data.current.relative_humidity_2m,
    windSpeed: data.current.wind_speed_10m,
    windGust: data.current.wind_gusts_10m,
    conditions: describeWeatherCode(data.current.weather_code),
  };
}

function describeWeatherCode(code: number): string {
  if (code === 0) return "Clear sky";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code <= 48) return "Foggy";
  if (code <= 67) return "Rainy";
  if (code <= 77) return "Snowy";
  if (code <= 82) return "Rain showers";
  if (code <= 86) return "Snow showers";
  return "Thunderstorm";
}

export interface TripReport {
  recipient: string;
  report: string;
  sentAt: string;
}

/** Demo observability: every "sent" report lands here (and in the server log). */
export const sentTripReports: TripReport[] = [];

export async function sendTripReport(recipient: string, report: string): Promise<{ sent: true; recipient: string }> {
  const entry: TripReport = { recipient, report, sentAt: new Date().toISOString() };
  sentTripReports.push(entry);
  console.log(`[mastra-agent example] trip report sent to ${recipient}: ${report}`);
  return { sent: true, recipient };
}

import { useSettings } from '../store/settings';
import type { LogCallback } from './types';
import { OpenAICompatibleProvider } from './provider';

/** A provider for the connection currently entered in the settings. */
export function createProviderFromSettings(log?: LogCallback): OpenAICompatibleProvider {
  const { baseUrl, model, apiKey } = useSettings.getState();
  return new OpenAICompatibleProvider({ baseUrl, model, apiKeys: apiKey, log });
}

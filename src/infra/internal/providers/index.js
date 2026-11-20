import { gitProvider } from "./git.js";
import { localPathProvider } from "./local-path.js";

const PROVIDERS = new Map([
  [gitProvider.id, gitProvider],
  [localPathProvider.id, localPathProvider]
]);

export function getProvider(providerId) {
  const provider = PROVIDERS.get(String(providerId ?? ""));
  if (!provider) {
    throw new Error(`Unsupported provider '${providerId}'.`);
  }
  return provider;
}

export function listProviderIds() {
  return [...PROVIDERS.keys()].sort((left, right) => left.localeCompare(right));
}

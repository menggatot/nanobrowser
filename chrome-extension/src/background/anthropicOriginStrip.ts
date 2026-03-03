import { llmProviderStore, ProviderTypeEnum } from '@extension/storage';

// Rule IDs reserved for stripping the Origin header on custom Anthropic gateway requests.
// We use a fixed block of IDs so we can reliably remove them on each update.
const BASE_RULE_ID = 10001;
const MAX_RULES = 20; // support up to 20 distinct custom Anthropic hostnames

function buildUrlFilter(baseUrl: string): string | null {
  try {
    const { hostname } = new URL(baseUrl);
    return `||${hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * Registers declarativeNetRequest dynamic rules to strip the `Origin` request
 * header for any custom Anthropic provider base URL.  Chrome automatically
 * adds `Origin: chrome-extension://<id>` to cross-origin fetch requests; some
 * third-party Anthropic-compatible gateways reject this header with 401.
 *
 * This must be called on extension startup and whenever provider config changes.
 */
export async function updateAnthropicOriginRules(): Promise<void> {
  try {
    const providers = await llmProviderStore.getAllProviders();

    const seenHosts = new Set<string>();
    const newRules: chrome.declarativeNetRequest.Rule[] = [];
    let ruleId = BASE_RULE_ID;

    for (const provider of Object.values(providers)) {
      if (provider.type !== ProviderTypeEnum.Anthropic || !provider.baseUrl?.trim()) continue;
      if (ruleId >= BASE_RULE_ID + MAX_RULES) break;

      const urlFilter = buildUrlFilter(provider.baseUrl);
      if (!urlFilter) continue;

      const host = new URL(provider.baseUrl).hostname;
      if (seenHosts.has(host)) continue;
      seenHosts.add(host);

      newRules.push({
        id: ruleId++,
        priority: 1,
        action: {
          type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: [{ header: 'Origin', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation }],
        },
        condition: {
          urlFilter,
          resourceTypes: [
            'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
            'other' as chrome.declarativeNetRequest.ResourceType,
          ],
        },
      });
    }

    // Remove all previously registered rules in our ID block, then add the new set.
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const oldIds = existing.filter(r => r.id >= BASE_RULE_ID && r.id < BASE_RULE_ID + MAX_RULES).map(r => r.id);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: oldIds,
      addRules: newRules,
    });
  } catch (e) {
    console.error('[anthropicOriginStrip] Failed to update declarativeNetRequest rules:', e);
  }
}

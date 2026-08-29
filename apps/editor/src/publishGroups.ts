/**
 * Channels grouped by NETWORK for the publish panel (2026-08-29).
 *
 * Postiz reports a LinkedIn profile as `linkedin` and a company page as
 * `linkedin-page` — two providers, one network, one idiom, one 1500-char
 * limit. Four LinkedIn channels asked for four caption boxes, and nobody
 * writes four different posts for the same network: the panel edits ONE
 * caption per network and writes it to every channel in the group.
 *
 * The server contract is untouched — captions stay keyed by integration id
 * (`/api/publish` takes `captions[id]`). Grouping is a presentation decision,
 * so it lives here as pure data, testable without a browser.
 */

export interface PublishChannel {
  id: string;
  provider: string;
  name: string;
  caption: string;
}

export interface PublishGroup {
  /** The network key — the provider for everything except LinkedIn's pair. */
  network: string;
  channels: PublishChannel[];
  /** The caption the group's box starts with: the first channel's. */
  caption: string;
  /**
   * The group's channels did NOT all arrive with the same caption. The panel
   * says so rather than silently overwriting one with another on the first
   * keystroke — a hand-edited doc, or a pack that authored `linkedin` and
   * `linkedin-page` differently, is exactly when a user wants to be told.
   */
  mixed: boolean;
}

/**
 * A provider's network. Only LinkedIn folds today; every other provider is
 * its own network, INCLUDING one ossclip has never seen — the publish path
 * resolves providers from the live instance, so an unknown one must still
 * appear rather than vanish into a bucket.
 */
export function networkOf(provider: string): string {
  return provider === "linkedin-page" ? "linkedin" : provider;
}

export function groupByNetwork(channels: readonly PublishChannel[]): PublishGroup[] {
  const order: string[] = [];
  const byNetwork = new Map<string, PublishChannel[]>();
  for (const channel of channels) {
    const network = networkOf(channel.provider);
    const existing = byNetwork.get(network);
    if (existing === undefined) {
      order.push(network);
      byNetwork.set(network, [channel]);
    } else {
      existing.push(channel);
    }
  }
  return order.map((network) => {
    const group = byNetwork.get(network)!;
    const first = group[0]!.caption;
    return {
      network,
      channels: group,
      caption: first,
      mixed: group.some((c) => c.caption !== first),
    };
  });
}

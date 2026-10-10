/**
 * OpenBiliClaw — TikTok content script entry.
 *
 * Injected into tiktok.com pages (isolated world). Listens for
 * TIKTOK_SCOPE_EXECUTE messages from the background dispatcher, drives
 * the single-scope scrape — click-driven navigation to the requested
 * account view (profile Liked/Favorites tab, Following modal, or the
 * avatar-menu Watch history entry), programmatic scroll to trigger
 * TikTok's virtual-list pagination, DOM harvest into a TiktokItemSink —
 * and posts one TIKTOK_SCOPE_RESULT back.
 *
 * DOM-only by design: no MAIN-world fetch-tap, no request signing, no
 * credential material. Only bounded normalized rows cross the bridge
 * (contract docs/platform-source-contract.tiktok.toml [task] buffer).
 *
 * Module isolation: zero imports from extension/src/content/dy/.
 */

import {
  detectTiktokAccessState,
  detectTiktokEmptyState,
  extractTiktokItemsFromDocument,
  pickTiktokScrollTarget,
} from "./tt/dom-extractor.ts";
import {
  readTiktokUniversalData,
  TIKTOK_UNIVERSAL_DATA_ELEMENT_ID,
} from "./tt/bootstrap.ts";
import {
  classifyTiktokScopeCompletion,
  isValidTiktokScopeExecuteMessage,
  normalizeTiktokScrollRounds,
  TiktokItemSink,
  ttShouldContinueScroll,
  type TiktokAccessState,
  type TiktokScope,
  type TiktokScopeExecuteMessage,
  type TiktokScopeResult,
} from "./tt/task-executor.ts";

const SCROLL_DELAY_MS = 1_500;
const NAV_SETTLE_MS = 2_500;
const TAB_SETTLE_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fireRealClick(el: HTMLElement): void {
  el.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
  );
}

function visibleText(el: HTMLElement): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function findClickableByText(labels: string[]): HTMLElement | null {
  const normalized = labels.map((label) => label.trim().toLowerCase()).filter(Boolean);
  if (!normalized.length) return null;
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'a, button, [role="link"], [role="button"], [role="tab"], [role="menuitem"], [data-e2e], li',
    ),
  );
  for (const el of candidates) {
    const text = visibleText(el).toLowerCase();
    if (!text || text.length > 40) continue;
    if (normalized.some((label) => text === label || text.includes(label))) return el;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Access state — fail closed, never a pseudo-empty success
// ---------------------------------------------------------------------------

function resolveAccessState(): TiktokAccessState {
  const domState = detectTiktokAccessState(document, location.href);
  if (domState !== "logged_out") return domState;
  // DOM markers absent — give the SSR universal-data one chance to
  // positively confirm the session before failing closed.
  try {
    const raw =
      document.getElementById(TIKTOK_UNIVERSAL_DATA_ELEMENT_ID)?.textContent ?? "";
    if (raw && readTiktokUniversalData(raw).loggedIn) return "signed_in";
  } catch {
    // universal-data is a candidate only; DOM state stays authoritative.
  }
  return domState;
}

function resolveViewerHandle(): string {
  try {
    const raw =
      document.getElementById(TIKTOK_UNIVERSAL_DATA_ELEMENT_ID)?.textContent ?? "";
    if (raw) {
      const { viewer } = readTiktokUniversalData(raw);
      if (viewer.handle) return viewer.handle;
    }
  } catch {
    // Fall through to DOM.
  }
  const anchor = document.querySelector<HTMLAnchorElement>(
    '[data-e2e="nav-profile"] a[href*="/@"], a[data-e2e="nav-profile"][href*="/@"], header a[href^="/@"]',
  );
  const href = anchor?.getAttribute("href") ?? "";
  const match = href.match(/\/@([\w.]{2,24})/);
  return match?.[1] ?? "";
}

// ---------------------------------------------------------------------------
// Click-driven navigation (URL jumps trip risk control on the dy sibling;
// mirror the same discipline here)
// ---------------------------------------------------------------------------

interface ScopeNavReport {
  attempted: boolean;
  note: string;
  page_url: string;
}

const SCOPE_TAB_SELECTORS: Record<"tt_like" | "tt_collect", string[]> = {
  tt_like: [
    '[data-e2e="liked-tab"]',
    '[data-e2e="user-liked-tab"]',
    '[data-e2e="user-tab-liked"]',
  ],
  tt_collect: [
    '[data-e2e="favorites-tab"]',
    '[data-e2e="user-favorites-tab"]',
    '[data-e2e="user-tab-favorites"]',
  ],
};

const SCOPE_TAB_LABELS: Record<"tt_like" | "tt_collect", string[]> = {
  tt_like: ["Liked", "Likes", "喜欢"],
  tt_collect: ["Favorites", "收藏"],
};

async function ensureOnOwnProfile(handle: string): Promise<boolean> {
  if (location.pathname.startsWith("/@")) return true;
  const profileLink =
    document.querySelector<HTMLElement>('[data-e2e="nav-profile"]') ??
    document.querySelector<HTMLElement>('header a[href^="/@"]');
  if (profileLink) {
    fireRealClick(profileLink);
    await sleep(NAV_SETTLE_MS);
    return true;
  }
  if (handle) {
    window.history.pushState({}, "", `/@${handle}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(NAV_SETTLE_MS);
    return true;
  }
  return false;
}

async function navigateToProfileTab(
  scope: "tt_like" | "tt_collect",
  handle: string,
): Promise<ScopeNavReport> {
  const report: ScopeNavReport = {
    attempted: false,
    note: "",
    page_url: location.href,
  };
  if (!(await ensureOnOwnProfile(handle))) {
    report.note = "profile_entry_not_found";
    return report;
  }
  for (const sel of SCOPE_TAB_SELECTORS[scope]) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) {
      fireRealClick(el);
      report.attempted = true;
      report.note = `selector:${sel}`;
      break;
    }
  }
  if (!report.attempted) {
    const tab = findClickableByText(SCOPE_TAB_LABELS[scope]);
    if (tab) {
      fireRealClick(tab);
      report.attempted = true;
      report.note = "text_fallback";
    }
  }
  if (report.attempted) await sleep(TAB_SETTLE_MS);
  else report.note = "scope_tab_not_found";
  report.page_url = location.href;
  return report;
}

async function navigateToFollowList(handle: string): Promise<ScopeNavReport> {
  const report: ScopeNavReport = {
    attempted: false,
    note: "",
    page_url: location.href,
  };
  if (!(await ensureOnOwnProfile(handle))) {
    report.note = "profile_entry_not_found";
    return report;
  }
  // The Following count on the profile header opens the following-list modal.
  const statSelectors = [
    '[data-e2e="following-count"]',
    '[data-e2e="following"]',
    '[data-e2e="user-following"]',
  ];
  for (const sel of statSelectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) {
      fireRealClick(el);
      report.attempted = true;
      report.note = `selector:${sel}`;
      break;
    }
  }
  if (!report.attempted) {
    const stat = findClickableByText(["Following", "关注"]);
    if (stat) {
      fireRealClick(stat);
      report.attempted = true;
      report.note = "text_fallback";
    }
  }
  if (report.attempted) await sleep(TAB_SETTLE_MS);
  else report.note = "following_entry_not_found";
  report.page_url = location.href;
  return report;
}

/**
 * Watch history has no stable desktop-web URL; it hangs off the avatar
 * dropdown menu (Settings → Activity center on current builds). We only
 * click a positively identified "Watch history" entry — if neither the
 * menu nor the entry is found, the scope fails with an explicit reason
 * instead of fabricating an empty result.
 */
async function navigateToWatchHistory(): Promise<ScopeNavReport> {
  const report: ScopeNavReport = {
    attempted: false,
    note: "",
    page_url: location.href,
  };
  const avatar =
    document.querySelector<HTMLElement>('[data-e2e="nav-profile"]') ??
    document.querySelector<HTMLElement>('[data-e2e="profile-icon"]') ??
    document.querySelector<HTMLElement>("header img");
  if (!avatar) {
    report.note = "history_menu_not_found";
    return report;
  }
  fireRealClick(avatar);
  await sleep(1_000);
  const entry = findClickableByText(["Watch history", "观看历史", "观看记录"]);
  if (!entry) {
    report.note = "history_entry_not_found";
    report.page_url = location.href;
    return report;
  }
  fireRealClick(entry);
  report.attempted = true;
  report.note = "menu_entry";
  await sleep(NAV_SETTLE_MS);
  report.page_url = location.href;
  return report;
}

async function navigateToScope(
  scope: TiktokScope,
  handle: string,
): Promise<ScopeNavReport> {
  if (scope === "tt_history") return navigateToWatchHistory();
  if (scope === "tt_follow") return navigateToFollowList(handle);
  return navigateToProfileTab(scope, handle);
}

// ---------------------------------------------------------------------------
// End-of-feed detection
// ---------------------------------------------------------------------------

const END_OF_FEED_PHRASES: readonly string[] = [
  "you've reached the end",
  "no more videos",
  "no more content",
  "that's all",
  "没有更多了",
  "暂时没有更多",
  "已经到底",
];

function detectEndOfFeed(): string {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'div, span, p, [class*="loading"], [class*="end"], [class*="footer"]',
    ),
  );
  for (const el of candidates) {
    const text = (el.textContent ?? "").trim().toLowerCase();
    if (!text || text.length > 40) continue;
    for (const phrase of END_OF_FEED_PHRASES) {
      if (text.includes(phrase)) return phrase;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Scope execution
// ---------------------------------------------------------------------------

async function runScope(msg: TiktokScopeExecuteMessage): Promise<TiktokScopeResult> {
  const sink = new TiktokItemSink({ maxItems: msg.max_items });
  let navigationFailed = false;
  let navigationError = "";
  let navNote = "";
  let endOfFeedPhrase = "";
  let scrollRounds = 0;

  const accessState = resolveAccessState();

  const harvestDom = (): void => {
    const rows = extractTiktokItemsFromDocument(
      document,
      msg.scope,
      location.origin,
      msg.max_items,
    );
    sink.ingest(rows);
  };

  try {
    if (accessState === "signed_in") {
      const handle = resolveViewerHandle();
      const nav = await navigateToScope(msg.scope, handle);
      navNote = nav.note;
      navigationFailed = !nav.attempted;
      navigationError = nav.note;
    }

    if (!navigationFailed && accessState === "signed_in") {
      harvestDom();
      const maxRounds = normalizeTiktokScrollRounds(msg.max_scroll_rounds);
      let stagnantRounds = 0;
      for (let round = 0; round < maxRounds; round += 1) {
        const beforeCount = sink.count();
        const scrollTarget = pickTiktokScrollTarget(document);
        if (scrollTarget) {
          scrollTarget.scrollTop = scrollTarget.scrollHeight;
        }
        window.scrollBy({ top: window.innerHeight * 2, behavior: "auto" });
        await sleep(SCROLL_DELAY_MS);
        harvestDom();
        const afterCount = sink.count();
        scrollRounds = round + 1;
        endOfFeedPhrase = detectEndOfFeed();
        stagnantRounds = afterCount > beforeCount ? 0 : stagnantRounds + 1;
        if (endOfFeedPhrase) break;
        if (
          !ttShouldContinueScroll({
            currentCount: afterCount,
            maxItems: msg.max_items,
            round: round + 1,
            maxScrollRounds: maxRounds,
            stagnantRounds,
            maxStagnantScrollRounds: msg.max_stagnant_scroll_rounds,
          })
        ) {
          break;
        }
      }
      harvestDom();
    }

    const items = sink.snapshot();
    const explicitEmpty =
      accessState === "signed_in" && items.length === 0
        ? detectTiktokEmptyState(document, msg.scope) !== ""
        : false;
    const completion = classifyTiktokScopeCompletion({
      accessState,
      itemCount: items.length,
      explicitEmpty,
      // Hitting the item cap is a planned stop but NOT a terminal end —
      // contract scope_caps: capped scopes remain incomplete (degraded),
      // never silently "ok".
      endOfFeed: endOfFeedPhrase !== "",
      navigationFailed,
      navigationError,
    });
    return {
      task_id: msg.task_id,
      scope: msg.scope,
      items,
      scope_count: items.length,
      status: completion.status,
      ...(completion.error ? { error: completion.error } : {}),
      debug: {
        access_state: accessState,
        navigation: navNote,
        scroll_rounds: scrollRounds,
        end_of_feed: endOfFeedPhrase,
        explicit_empty: explicitEmpty,
        page_url: location.href,
      },
    };
  } catch (err) {
    const items = sink.snapshot();
    return {
      task_id: msg.task_id,
      scope: msg.scope,
      items,
      scope_count: items.length,
      status: "failed",
      error: String(err),
      debug: {
        access_state: accessState,
        navigation: navNote,
        scroll_rounds: scrollRounds,
        end_of_feed: endOfFeedPhrase,
        page_url: location.href,
      },
    };
  }
}

export function registerTiktokScopeExecutor(): void {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) return;
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender, _sendResponse) => {
    if (message.action !== "TIKTOK_SCOPE_EXECUTE") return false;
    const data = message.data;
    if (!isValidTiktokScopeExecuteMessage(data)) return false;
    void runScope(data).then((result) => {
      chrome.runtime.sendMessage({ action: "TIKTOK_SCOPE_RESULT", data: result }).catch(() => {
        // The dispatcher timeout backstop reports the task failure if the
        // service worker is gone before the result can be delivered.
      });
    });
    return false;
  });
}

if (typeof chrome !== "undefined" && chrome.runtime) {
  registerTiktokScopeExecutor();
  // eslint-disable-next-line no-console
  console.debug("[OpenBiliClaw] tiktok content script registered (isolated world)");
}

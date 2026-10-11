/**
 * Tests for the TikTok native-save (favorite) content executor.
 *
 * Fixture-driven with an injected environment — no real TikTok requests,
 * no real mutation. Covers the contract terminal_policy matrix: positive
 * checked-state evidence = synced/already_synced; unobserved confirmation
 * = native_confirmation_not_observed; logged-out tab = login_required.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTiktokBrowserEnvironment,
  saveTiktok,
  tiktokRouteVideoId,
  verifyTiktok,
  type TiktokNativeSaveEnvironment,
  type TiktokSaveControl,
} from "../src/content/native-save/tiktok.ts";
import type { NativeSaveTask } from "../src/shared/native-save.ts";

const CONTENT_ID = "7234567890123456789";
const task: NativeSaveTask = {
  id: "123e4567-e89b-42d3-a456-426614174099",
  type: "native_save",
  platform: "tiktok",
  platform_slug: "tiktok",
  item_key: `tiktok:${CONTENT_ID}`,
  content_id: CONTENT_ID,
  content_url: `https://www.tiktok.com/@creator/video/${CONTENT_ID}`,
  content_type: "video",
  requested_action: "favorite",
  resolved_action: "favorite",
  target_label: "TikTok Favorites",
};

function fixture(options: {
  currentUrl?: string;
  loggedIn?: boolean;
  unavailable?: boolean;
  initialSelected?: boolean;
  controls?: number;
  confirmAfterClick?: boolean;
  rateBefore?: string;
  rateAfterMutation?: string;
} = {}): TiktokNativeSaveEnvironment & { clicks: number; sleeps: number } {
  let selected = options.initialSelected ?? false;
  let mutated = false;
  const control: TiktokSaveControl = {
    isSelected: () => selected,
    click() {
      env.clicks += 1;
      mutated = true;
      if (options.confirmAfterClick ?? true) selected = true;
    },
  };
  const env = {
    clicks: 0,
    sleeps: 0,
    currentUrl: options.currentUrl ?? task.content_url,
    isLoggedIn: () => options.loggedIn ?? true,
    isUnavailable: () => options.unavailable ?? false,
    isContentReady: () => true,
    rateLimitFingerprint: () =>
      mutated
        ? (options.rateAfterMutation ?? options.rateBefore ?? "")
        : (options.rateBefore ?? ""),
    findFavoriteControls: () =>
      Array.from({ length: options.controls ?? 1 }, () => control),
    sleep: async () => {
      env.sleeps += 1;
    },
  } satisfies TiktokNativeSaveEnvironment & { clicks: number; sleeps: number };
  return env;
}

test("tiktokRouteVideoId accepts only the exact canonical video URL", () => {
  assert.equal(
    tiktokRouteVideoId("https://www.tiktok.com/@creator/video/7234567890123456789"),
    "7234567890123456789",
  );
  assert.equal(
    tiktokRouteVideoId("https://tiktok.com/@creator.one/video/7234567890123456789/"),
    "7234567890123456789",
  );
  // Photo posts, query strings, fragments, and foreign hosts are rejected.
  assert.equal(
    tiktokRouteVideoId("https://www.tiktok.com/@creator/photo/7234567890123456789"),
    null,
  );
  assert.equal(
    tiktokRouteVideoId("https://www.tiktok.com/@creator/video/7234567890123456789?t=1"),
    null,
  );
  assert.equal(
    tiktokRouteVideoId("https://www.tiktok.com/@creator/video/7234567890123456789#x"),
    null,
  );
  assert.equal(
    tiktokRouteVideoId("https://evil.com/@creator/video/7234567890123456789"),
    null,
  );
  assert.equal(tiktokRouteVideoId("not a url"), null);
});

test("saveTiktok clicks the favorite control and confirms the checked state", async () => {
  const env = fixture();
  assert.deepEqual(await saveTiktok(task, env), { status: "synced" });
  assert.equal(env.clicks, 1);
});

test("saveTiktok reports already_synced for a repeat favorite without clicking", async () => {
  const env = fixture({ initialSelected: true });
  assert.deepEqual(await saveTiktok(task, env), { status: "already_synced" });
  assert.equal(env.clicks, 0);
});

test("saveTiktok fails closed as native_confirmation_not_observed without positive evidence", async () => {
  const env = fixture({ confirmAfterClick: false });
  assert.deepEqual(await saveTiktok(task, env), {
    status: "failed",
    error_code: "native_confirmation_not_observed",
  });
  assert.equal(env.clicks, 1);
});

test("saveTiktok surfaces rate limiting observed after the click", async () => {
  const env = fixture({
    confirmAfterClick: false,
    rateBefore: "",
    rateAfterMutation: "1:Too many requests. Try again later.",
  });
  assert.deepEqual(await saveTiktok(task, env), { status: "rate_limited" });
});

test("saveTiktok requires a signed-in session marker", async () => {
  const env = fixture({ loggedIn: false });
  assert.deepEqual(await saveTiktok(task, env), { status: "login_required" });
  assert.equal(env.clicks, 0);
});

test("saveTiktok fails when the favorite control is not uniquely present", async () => {
  assert.deepEqual(await saveTiktok(task, fixture({ controls: 0 })), {
    status: "failed",
    error_code: "native_control_not_found",
  });
  assert.deepEqual(await saveTiktok(task, fixture({ controls: 2 })), {
    status: "failed",
    error_code: "native_control_not_found",
  });
});

test("saveTiktok rejects unsupported or cross-platform identities", async () => {
  for (const candidate of [
    { ...task, platform: "douyin" as const, platform_slug: "dy" as const },
    { ...task, item_key: "tiktok:other" },
    { ...task, content_type: "photo" },
    {
      ...task,
      content_url: `https://www.tiktok.com/@creator/video/${CONTENT_ID}?tracking=1`,
    },
    { ...task, target_label: "抖音收藏" },
    { ...task, resolved_action: "watch_later" as const },
  ]) {
    const result = await saveTiktok(candidate, fixture()) as { status: string };
    assert.ok(
      result.status === "unsupported" || result.status === "failed",
      `expected terminal rejection, got ${JSON.stringify(result)}`,
    );
  }
  // A tab showing a different video never receives the click.
  const wrongPage = fixture({
    currentUrl: "https://www.tiktok.com/@other/video/7000000000000000000",
  });
  assert.deepEqual(await saveTiktok(task, wrongPage), {
    status: "unsupported",
    error_code: "unsupported_content_type",
  });
  assert.equal(wrongPage.clicks, 0);
});

test("saveTiktok accepts watch_later requests resolved to favorite", async () => {
  const resolved = await saveTiktok(
    { ...task, requested_action: "watch_later" },
    fixture(),
  );
  assert.deepEqual(resolved, { status: "synced" });
});

test("verifyTiktok is read-only and requires existing membership evidence", async () => {
  const member = fixture({ initialSelected: true });
  assert.deepEqual(await verifyTiktok(task, member), { status: "already_synced" });
  assert.equal(member.clicks, 0);

  const nonMember = fixture({ initialSelected: false });
  assert.deepEqual(await verifyTiktok(task, nonMember), {
    status: "failed",
    error_code: "native_confirmation_not_observed",
  });
  assert.equal(nonMember.clicks, 0);

  assert.deepEqual(await verifyTiktok(task, fixture({ loggedIn: false })), {
    status: "login_required",
  });
});

test("saveTiktok refuses an SPA route switch while waiting for content", async () => {
  const env = fixture();
  env.isContentReady = () => {
    env.currentUrl = "https://www.tiktok.com/@other/video/999999999";
    return true;
  };
  assert.notEqual((await saveTiktok(task, env) as { status: string }).status, "synced");
  assert.equal(env.clicks, 0);
});

test("saveTiktok never confirms another SPA video's selected control", async () => {
  const env = fixture({ confirmAfterClick: false });
  env.findFavoriteControls = () => [{
    isSelected: () => env.clicks > 0,
    click() {
      env.clicks += 1;
      env.currentUrl = "https://www.tiktok.com/@other/video/999999999";
    },
  }];
  assert.notEqual((await saveTiktok(task, env) as { status: string }).status, "synced");
});

for (const operation of [saveTiktok, verifyTiktok]) {
  test(`${operation.name} waits for cold-page login and content hydration`, async () => {
    const env = fixture({ initialSelected: operation === verifyTiktok });
    env.isLoggedIn = () => env.sleeps >= 48;
    env.isContentReady = () => env.sleeps >= 52;
    assert.deepEqual(await operation(task, env), {
      status: operation === saveTiktok ? "synced" : "already_synced",
    });
    assert.ok(env.sleeps >= 52);
    assert.equal(env.clicks, operation === saveTiktok ? 1 : 0);
  });
}


test("explicit login wall terminates without waiting or clicking", async () => {
  const env = fixture({ loggedIn: false });
  env.isLoginRequired = () => true;
  assert.deepEqual(await saveTiktok(task, env), { status: "login_required" });
  assert.equal(env.sleeps, 0);
  assert.equal(env.clicks, 0);
});

test("native DOM auth rejects upload-only and explicit logout while accepting canonical login", () => {
  for (const [marker, flag, expected] of [
    ["upload-icon", undefined, false], ["nav-profile", undefined, true],
    ["nav-profile", false, false], ["", true, true], ["top-login-button", true, false],
  ] as const) {
    const element = { hidden: false, parentElement: null, style: {}, hasAttribute: () => false, getAttribute: () => null };
    const doc = {
      body: { innerText: "" },
      querySelector: (selector: string) => marker && selector === `[data-e2e="${marker}"]` ? element : null,
      getElementById: () => ({ textContent: JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.user-context": { isLoggedIn: flag } } }) }),
    } as unknown as Document;
    const env = createTiktokBrowserEnvironment(doc, task.content_url);
    assert.equal(env.isLoggedIn(), expected, `${marker}/${flag}`);
    assert.equal(env.isLoginRequired!(), flag === false || marker === "top-login-button");
  }
});

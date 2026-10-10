/**
 * TikTok task dispatcher — background polling for account-behavior
 * bootstrap tasks (tt_like / tt_collect / tt_history / tt_follow).
 *
 * Mirrors dy-task-dispatcher.ts structurally but is deliberately
 * slimmer: one backend task carries exactly one scope
 * (GET /api/sources/tiktok/next-task → 200 {id, type, payload} where
 * ``type`` IS the scope), and collection is DOM-only — no MAIN-world
 * fetch-tap, no request signing (contract
 * docs/platform-source-contract.tiktok.toml: extension.task =
 * "browser-task", background = true).
 *
 * Flow: poll → claim → open a background tiktok.com tab (task marker
 * query param) → TIKTOK_SCOPE_EXECUTE to the content script →
 * TIKTOK_SCOPE_RESULT back → two-stage staged completion: a partial
 * POST carrying the normalized rows, then the terminal POST. Both POSTs
 * go through the pending-result slot in chrome.storage.local: the exact
 * canonical body is persisted BEFORE the POST and retried with bounded
 * backoff until a 2xx ACK or an explicit 4xx terminal rejection
 * (contract [task] retry clause). A fresh worker flushes the pending
 * slot before claiming new work.
 *
 * MV3 resilience mirrors dy: the in-flight task snapshot (task, tab,
 * deadline, progress) lives in chrome.storage.session and the deadline
 * is backed by a chrome.alarms one-shot; ensureTiktokTaskRecovery()
 * restores the snapshot on wake, so late results still post, the
 * deadline backstop still closes the task tab, and orphaned marker
 * tabs are swept.
 */

import {
  finalizeTiktokTaskStatus,
  TIKTOK_SCOPES,
  type TiktokBootstrapItem,
  type TiktokScope,
  type TiktokScopeResult,
} from "../content/tt/task-executor.ts";
import { apiUrl } from "../shared/backend-endpoint.ts";
import { authenticatedFetch } from "../shared/auth.ts";
import {
  isNativeSaveTask,
  type NativeSaveResult,
  type NativeSaveTask,
} from "../shared/native-save.ts";
import { withTaskTabMarker } from "../shared/task-tab.ts";
import {
  releaseDispatcherMutex,
  tryAcquireDispatcherMutex,
} from "./dispatcher-mutex.ts";
import {
  ensureNativeSaveTaskRecovery,
  runNativeSaveTask,
} from "./native-save-task-runner.ts";
import { createTaskTab } from "./task-tab.ts";

const TIKTOK_TASK_MARKER = "openbiliclaw_tiktok_task";
const MUTEX_LABEL = "tiktok";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const BASE_TIMEOUT_MS = 30_000;
const PER_ROUND_TIMEOUT_MS = 3_000;
const MAX_TASK_TIMEOUT_MS = 360_000;
const POLL_ALARM_NAME = "openbiliclaw-tiktok-task-poll";
const TASK_TIMEOUT_ALARM_NAME = "openbiliclaw-tiktok-task-timeout";
export const TIKTOK_TASK_STATE_SESSION_KEY = "openbiliclaw_tiktok_active_task";
export const TIKTOK_PENDING_RESULT_LOCAL_KEY = "openbiliclaw_tiktok_pending_task_result";

const DEFAULT_MAX_ITEMS = 300;
const DEFAULT_SCROLL_ROUNDS = 15;
const DEFAULT_STAGNANT_ROUNDS = 5;

// ---------------------------------------------------------------------------
// Task types
// ---------------------------------------------------------------------------

export interface TiktokScopeTask {
  id: string;
  /** The task type IS the bootstrap scope. */
  type: TiktokScope;
  /** The backend spreads payload_json at the top level of next-task. */
  max_items?: number;
  max_scroll_rounds?: number;
  max_stagnant_scroll_rounds?: number;
  /** Tolerated legacy nesting (defensive; not what the backend emits). */
  payload?: {
    max_items?: number;
    max_scroll_rounds?: number;
    max_stagnant_scroll_rounds?: number;
  };
}

export type TiktokTask = TiktokScopeTask | NativeSaveTask;

export interface TiktokTaskResult {
  task_id: string;
  status: "ok" | "empty" | "partial" | "degraded" | "failed";
  videos?: TiktokBootstrapItem[];
  scope_counts?: Record<string, number>;
  error?: string;
  debug?: Record<string, unknown>;
}

export type TiktokTaskCallbackResult = TiktokTaskResult | NativeSaveResult;

export type TiktokTaskExecutionDisposition = "accepted" | "declined";

// ---------------------------------------------------------------------------
// Pure helpers (testable without chrome)
// ---------------------------------------------------------------------------

function isValidLimitField(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "number" && Number.isFinite(value);
}

export function isValidTiktokTask(task: unknown): task is TiktokTask {
  if (isNativeSaveTask(task)) {
    return task.platform === "tiktok" && task.platform_slug === "tiktok";
  }
  if (typeof task !== "object" || task === null) return false;
  const t = task as Record<string, unknown>;
  if (typeof t.id !== "string" || !t.id) return false;
  if (!TIKTOK_SCOPES.includes(t.type as TiktokScope)) return false;
  for (const key of ["max_items", "max_scroll_rounds", "max_stagnant_scroll_rounds"]) {
    if (!isValidLimitField(t[key])) return false;
  }
  if (t.payload !== undefined) {
    if (typeof t.payload !== "object" || t.payload === null) return false;
    const p = t.payload as Record<string, unknown>;
    for (const key of ["max_items", "max_scroll_rounds", "max_stagnant_scroll_rounds"]) {
      if (!isValidLimitField(p[key])) return false;
    }
  }
  return true;
}

function taskLimit(task: TiktokScopeTask, key: "max_items" | "max_scroll_rounds" | "max_stagnant_scroll_rounds"): number | undefined {
  const topLevel = task[key];
  if (typeof topLevel === "number" && Number.isFinite(topLevel)) return topLevel;
  const nested = task.payload?.[key];
  return typeof nested === "number" && Number.isFinite(nested) ? nested : undefined;
}

export function buildTiktokTaskUrl(task: TiktokTask): string {
  if (task.type === "native_save") return task.content_url;
  // Every scope starts from the tiktok.com homepage; the content script
  // drives click-based navigation from there (direct deep links trip
  // risk control on the Douyin sibling; same discipline here).
  return withTaskTabMarker("https://www.tiktok.com/", TIKTOK_TASK_MARKER);
}

export function computeTiktokTaskTimeoutMs(task: TiktokScopeTask): number {
  const rounds = taskLimit(task, "max_scroll_rounds");
  const scrollBudget = rounds === undefined ? 0 : Math.max(0, Math.floor(rounds));
  return Math.min(
    Math.max(BASE_TIMEOUT_MS, BASE_TIMEOUT_MS + scrollBudget * PER_ROUND_TIMEOUT_MS),
    MAX_TASK_TIMEOUT_MS,
  );
}

export function buildTiktokExecuteMessageData(task: TiktokScopeTask): Record<string, unknown> {
  return {
    task_id: task.id,
    scope: task.type,
    max_items: taskLimit(task, "max_items") ?? DEFAULT_MAX_ITEMS,
    max_scroll_rounds: taskLimit(task, "max_scroll_rounds") ?? DEFAULT_SCROLL_ROUNDS,
    max_stagnant_scroll_rounds:
      taskLimit(task, "max_stagnant_scroll_rounds") ?? DEFAULT_STAGNANT_ROUNDS,
  };
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let taskInFlight = false;
let pollInFlight: Promise<void> | null = null;
let taskTabId: number | null = null;
let ownsTaskTab = false;
let taskTimeoutId: ReturnType<typeof setTimeout> | null = null;
let taskDeadlineMs: number | null = null;
let currentTask: TiktokScopeTask | null = null;

interface TaskProgress {
  task_id: string;
  scope: TiktokScope;
  max_items: number;
  max_scroll_rounds: number;
  max_stagnant_scroll_rounds: number;
}

let progress: TaskProgress | null = null;

// ---------------------------------------------------------------------------
// Network + durable pending result (contract [task] retry)
// ---------------------------------------------------------------------------

async function fetchNextTask(): Promise<TiktokTask | null> {
  try {
    const resp = await authenticatedFetch(await apiUrl("/sources/tiktok/next-task"));
    if (resp.status === 204) return null; // no pending task
    if (!resp.ok) return null;
    const payload: unknown = await resp.json();
    if (isValidTiktokTask(payload)) return payload;
    // GET /next-task atomically claimed whatever this was. A payload that
    // is neither a scope task nor a well-formed native_save task (native
    // save IS supported; this catches future unknown shapes) would strand
    // the backend lease in in_progress — fail it explicitly so the queue
    // recovers instead of waiting out the stale-claim timeout.
    const id = (payload as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id) {
      await postTiktokTaskResult({
        task_id: id,
        status: "failed",
        error: "unsupported_task_type",
      }).catch(() => {});
    }
    return null;
  } catch {
    return null;
  }
}

export interface TiktokTaskResultResponse {
  ok: boolean;
  status: number;
}

export interface TiktokTaskResultTransport {
  resolveUrl: (path: string) => Promise<string>;
  fetch: (input: string, init: RequestInit) => Promise<TiktokTaskResultResponse>;
  sleep: (delayMs: number) => Promise<void>;
}

export interface TiktokTaskResultRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
}

const TASK_RESULT_MAX_ATTEMPTS = 3;
const TASK_RESULT_RETRY_BASE_DELAY_MS = 250;
const TASK_RESULT_RETRY_MAX_DELAY_MS = 2_000;

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

const TIKTOK_TASK_RESULT_TRANSPORT: TiktokTaskResultTransport = {
  resolveUrl: apiUrl,
  fetch: authenticatedFetch,
  sleep: delay,
};

function localStorageArea(): chrome.storage.StorageArea | null {
  try {
    return typeof chrome === "undefined" ? null : chrome.storage?.local ?? null;
  } catch {
    return null;
  }
}

/**
 * The pending slot holds the exact canonical JSON body of the latest
 * unacknowledged task-result callback. Persisted BEFORE the POST so a
 * worker death between persist and POST still replays the payload on
 * the next wake. Cleared on a 2xx ACK or an explicit 4xx terminal
 * rejection (retrying an identical body cannot change a client error).
 * Only task identity + normalized rows live here — never raw response
 * bodies or Cookie/CSRF material (contract [task] buffer clause).
 */
export interface PendingTiktokTaskResult {
  body: string;
  queued_at_ms: number;
}

async function readPendingResult(): Promise<PendingTiktokTaskResult | null> {
  const storage = localStorageArea();
  if (!storage) return null;
  try {
    const raw: unknown = (await storage.get(TIKTOK_PENDING_RESULT_LOCAL_KEY))[
      TIKTOK_PENDING_RESULT_LOCAL_KEY
    ];
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.body !== "string" || !record.body) return null;
    return {
      body: record.body,
      queued_at_ms:
        typeof record.queued_at_ms === "number" && Number.isFinite(record.queued_at_ms)
          ? record.queued_at_ms
          : 0,
    };
  } catch {
    return null;
  }
}

async function writePendingResult(body: string): Promise<void> {
  const storage = localStorageArea();
  if (!storage) return;
  try {
    await storage.set({
      [TIKTOK_PENDING_RESULT_LOCAL_KEY]: { body, queued_at_ms: Date.now() },
    });
  } catch {
    // Pending persistence is the durability layer; a transient storage
    // failure degrades to in-memory retry, never to dropping the POST.
  }
}

async function clearPendingResult(): Promise<void> {
  const storage = localStorageArea();
  if (!storage) return;
  try {
    await storage.remove(TIKTOK_PENDING_RESULT_LOCAL_KEY);
  } catch {
    // Best-effort; a stale slot is replayed idempotently (backend
    // first-final-wins), so a failed clear is safe.
  }
}

async function postRawTaskResult(
  body: string,
  transport: TiktokTaskResultTransport,
  options: TiktokTaskResultRetryOptions,
): Promise<"acked" | "rejected"> {
  const maxAttempts = Math.max(
    1,
    Math.min(5, Math.floor(options.maxAttempts ?? TASK_RESULT_MAX_ATTEMPTS)),
  );
  const baseDelayMs = Math.max(
    0,
    Math.min(
      TASK_RESULT_RETRY_MAX_DELAY_MS,
      Math.floor(options.baseDelayMs ?? TASK_RESULT_RETRY_BASE_DELAY_MS),
    ),
  );
  let lastFailure = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await transport.fetch(
        await transport.resolveUrl("/sources/tiktok/task-result"),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
      );
      if (response.ok) return "acked";
      if (response.status >= 400 && response.status < 500) {
        // Explicit terminal rejection — the backend refused this exact
        // canonical payload; bounded retries cannot change that.
        return "rejected";
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = String(error);
    }

    if (attempt < maxAttempts) {
      const retryDelayMs = Math.min(
        TASK_RESULT_RETRY_MAX_DELAY_MS,
        baseDelayMs * 2 ** (attempt - 1),
      );
      await transport.sleep(retryDelayMs);
    }
  }
  throw new Error(`tiktok_task_result_unacknowledged: ${lastFailure}`);
}

/**
 * Deliver one idempotent task callback, persisting the canonical body
 * until the backend ACKs. Throws when the bounded retry window expired
 * and the payload remains pending — callers decide lifecycle cleanup,
 * the pending slot survives either way and is flushed on the next wake.
 */
export async function postTiktokTaskResult(
  result: TiktokTaskCallbackResult,
  transport: TiktokTaskResultTransport = TIKTOK_TASK_RESULT_TRANSPORT,
  options: TiktokTaskResultRetryOptions = {},
): Promise<void> {
  const body = JSON.stringify(result);
  await writePendingResult(body);
  const outcome = await postRawTaskResult(body, transport, options);
  if (outcome === "acked" || outcome === "rejected") {
    await clearPendingResult();
  }
}

/** Flush the pending slot. Called on worker wake and before each claim. */
export async function flushPendingTiktokTaskResult(
  transport: TiktokTaskResultTransport = TIKTOK_TASK_RESULT_TRANSPORT,
): Promise<void> {
  const pending = await readPendingResult();
  if (!pending) return;
  try {
    const outcome = await postRawTaskResult(pending.body, transport, { maxAttempts: 1 });
    if (outcome === "acked" || outcome === "rejected") await clearPendingResult();
  } catch {
    // Still unacknowledged — the slot stays for the next wake.
  }
}

// ---------------------------------------------------------------------------
// Active-task persistence (event page / service-worker recycling)
// ---------------------------------------------------------------------------

export interface PersistedTiktokTaskState {
  task: TiktokScopeTask;
  task_tab_id: number | null;
  owns_task_tab: boolean;
  deadline_ms: number;
  progress: TaskProgress | null;
}

let sessionStateMutation: Promise<void> = Promise.resolve();
let tiktokTaskRecoveryPromise: Promise<void> | null = null;

function sessionStorageArea(): chrome.storage.StorageArea | null {
  try {
    return typeof chrome === "undefined" ? null : chrome.storage?.session ?? null;
  } catch {
    return null;
  }
}

function serializedSessionMutation(mutation: () => Promise<void>): Promise<void> {
  const current = sessionStateMutation.then(mutation, mutation);
  sessionStateMutation = current.catch(() => {});
  return current;
}

function persistActiveTaskState(): Promise<void> {
  return serializedSessionMutation(async () => {
    const storage = sessionStorageArea();
    if (!storage || !currentTask) return;
    const record: PersistedTiktokTaskState = {
      task: currentTask,
      task_tab_id: taskTabId,
      owns_task_tab: ownsTaskTab,
      deadline_ms: taskDeadlineMs ?? 0,
      progress,
    };
    try {
      await storage.set({ [TIKTOK_TASK_STATE_SESSION_KEY]: record });
    } catch {
      // Session persistence is an optional recovery enhancement.
    }
  });
}

function clearPersistedTaskState(): Promise<void> {
  return serializedSessionMutation(async () => {
    const storage = sessionStorageArea();
    if (!storage) return;
    try {
      await storage.remove(TIKTOK_TASK_STATE_SESSION_KEY);
    } catch {
      // The in-memory lifecycle is already terminal for this worker.
    }
  });
}

function parsePersistedTaskState(value: unknown): PersistedTiktokTaskState | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!isValidTiktokTask(record.task) || record.task.type === "native_save") return null;
  const task = record.task;
  if (typeof record.deadline_ms !== "number" || !Number.isFinite(record.deadline_ms)) {
    return null;
  }
  const tabId = record.task_tab_id ?? null;
  if (tabId !== null && (typeof tabId !== "number" || !Number.isInteger(tabId))) return null;
  const progressRecord = record.progress;
  if (progressRecord !== null && progressRecord !== undefined) {
    if (
      typeof progressRecord !== "object" ||
      (progressRecord as { task_id?: unknown }).task_id !== task.id ||
      (progressRecord as { scope?: unknown }).scope !== task.type
    ) {
      return null;
    }
  }
  return {
    task,
    task_tab_id: tabId,
    owns_task_tab: record.owns_task_tab === true,
    deadline_ms: record.deadline_ms,
    progress: (progressRecord as TaskProgress | null) ?? null,
  };
}

function scheduleTaskTimeoutAlarm(deadlineMs: number): void {
  if (typeof chrome === "undefined" || !chrome.alarms?.create) return;
  try {
    void chrome.alarms.create(TASK_TIMEOUT_ALARM_NAME, { when: deadlineMs });
  } catch {
    // The in-process timer still covers a live worker.
  }
}

function armTaskDeadline(deadlineMs: number): void {
  taskDeadlineMs = deadlineMs;
  // The one-shot alarm is the authoritative backstop: it survives the
  // service worker being unloaded. The setTimeout below is only the
  // exact-timing fast path while this worker stays alive.
  scheduleTaskTimeoutAlarm(deadlineMs);
  if (taskTimeoutId !== null) {
    clearTimeout(taskTimeoutId);
    taskTimeoutId = null;
  }
  taskTimeoutId = setTimeout(() => {
    taskTimeoutId = null;
    void failActiveTask("task_timeout");
  }, Math.max(0, deadlineMs - Date.now()));
}

async function failActiveTask(error: string): Promise<void> {
  const task = currentTask;
  if (!task) return;
  try {
    await postTiktokTaskResult({
      task_id: task.id,
      status: "failed",
      error,
    });
    cleanupTask();
  } catch {
    // Keep local task state intact after an unacknowledged terminal
    // callback; the pending slot plus the timeout alarm retry delivery
    // on the next wake instead of pretending the task was durably failed.
  }
}

async function recordedTabAlive(tabId: number | null): Promise<boolean> {
  if (tabId === null) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function restorePersistedTaskState(record: PersistedTiktokTaskState): Promise<void> {
  const tabAlive = await recordedTabAlive(record.task_tab_id);
  currentTask = record.task;
  taskTabId = tabAlive ? record.task_tab_id : null;
  ownsTaskTab = record.owns_task_tab && tabAlive;
  progress = record.progress;
  taskInFlight = true;
  tryAcquireDispatcherMutex(MUTEX_LABEL);
  armTaskDeadline(record.deadline_ms);
  if (Date.now() >= record.deadline_ms) {
    await failActiveTask("task_timeout");
    return;
  }
  if (record.owns_task_tab && !tabAlive) {
    // The task tab is gone; nothing can deliver further results, so
    // settle immediately instead of burning the remaining deadline.
    await failActiveTask("task_tab_closed");
  }
}

async function sweepOrphanTiktokTaskTabs(activeTabId: number | null): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query || !chrome.tabs?.remove) return;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: ["*://*.tiktok.com/*"] });
  } catch {
    return;
  }
  const queryMarker = `${TIKTOK_TASK_MARKER}=1`;
  for (const tab of tabs) {
    if (tab.id === undefined || tab.id === activeTabId) continue;
    const url = tab.url ?? tab.pendingUrl ?? "";
    if (!url.includes(queryMarker)) continue;
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // Orphan sweep is best-effort; the recorded-tab path stays authoritative.
    }
  }
}

async function recoverTiktokTaskState(): Promise<void> {
  // The pending-result slot is flushed first: a previous worker may have
  // died between persist and ACK, and the backend's first-final-wins
  // makes the replay idempotent.
  await flushPendingTiktokTaskResult();
  const storage = sessionStorageArea();
  if (storage && !taskInFlight && currentTask === null) {
    let record: PersistedTiktokTaskState | null = null;
    try {
      record = parsePersistedTaskState(
        (await storage.get(TIKTOK_TASK_STATE_SESSION_KEY))[TIKTOK_TASK_STATE_SESSION_KEY],
      );
    } catch {
      record = null;
    }
    if (record) await restorePersistedTaskState(record);
  }
  await sweepOrphanTiktokTaskTabs(taskTabId);
}

/**
 * One MV3-lifetime barrier shared by startup, poll wakes, timeout
 * alarms, and the TIKTOK_SCOPE_RESULT handler. A freshly woken worker
 * flushes the pending slot and restores the persisted in-flight task
 * before any of those paths inspect module state.
 */
export function ensureTiktokTaskRecovery(): Promise<void> {
  tiktokTaskRecoveryPromise ??= recoverTiktokTaskState().catch(() => {});
  return tiktokTaskRecoveryPromise;
}

export function resetTiktokTaskStateForTest(): void {
  if (taskTimeoutId !== null) {
    clearTimeout(taskTimeoutId);
    taskTimeoutId = null;
  }
  taskDeadlineMs = null;
  taskTabId = null;
  ownsTaskTab = false;
  currentTask = null;
  progress = null;
  taskInFlight = false;
  tiktokTaskRecoveryPromise = null;
  sessionStateMutation = Promise.resolve();
  releaseDispatcherMutex(MUTEX_LABEL);
}

function cleanupTask(): void {
  if (taskTimeoutId !== null) {
    clearTimeout(taskTimeoutId);
    taskTimeoutId = null;
  }
  taskDeadlineMs = null;
  if (typeof chrome !== "undefined" && chrome.alarms?.clear) {
    try {
      void chrome.alarms.clear(TASK_TIMEOUT_ALARM_NAME);
    } catch {
      // The alarm may already have fired; clearing stays best-effort.
    }
  }
  if (ownsTaskTab && taskTabId !== null) {
    try {
      void chrome.tabs.remove(taskTabId);
    } catch {
      // Tab may already be closed; ignore.
    }
  }
  taskTabId = null;
  ownsTaskTab = false;
  currentTask = null;
  progress = null;
  taskInFlight = false;
  releaseDispatcherMutex(MUTEX_LABEL);
  void clearPersistedTaskState();
}

function armTaskTimeout(task: TiktokScopeTask): void {
  armTaskDeadline(Date.now() + computeTiktokTaskTimeoutMs(task));
  void persistActiveTaskState();
}

// ---------------------------------------------------------------------------
// Scope execution driver
// ---------------------------------------------------------------------------

/**
 * Wait for tab.status === "complete" then run the callback. Cleans
 * itself up on the first complete signal so intra-page navigations
 * don't re-trigger the handshake.
 */
export function onTabReady(
  tabId: number,
  callback: () => void,
  options: { fallbackMs?: number } = {},
): void {
  let completed = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const listener = (updatedId: number, info: { status?: string }): void => {
    if (updatedId !== tabId) return;
    if (info.status !== "complete") return;
    runOnce();
  };
  const runOnce = (): void => {
    if (completed) return;
    completed = true;
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    chrome.tabs.onUpdated.removeListener(listener);
    callback();
  };
  chrome.tabs.onUpdated.addListener(listener);
  if (
    typeof options.fallbackMs === "number" &&
    Number.isFinite(options.fallbackMs) &&
    options.fallbackMs >= 0
  ) {
    fallbackTimer = setTimeout(runOnce, options.fallbackMs);
  }
  void chrome.tabs
    .get(tabId)
    .then((tab) => {
      if (tab.status === "complete") runOnce();
    })
    .catch(() => {
      // Tab may close between create and readiness probing. The timeout
      // path reports the failure if no completion event arrives.
    });
}

/**
 * Send TIKTOK_SCOPE_EXECUTE to the content script. Failure to deliver
 * (no listener / wrong URL / CSP — e.g. a TikTok login wall where our
 * content script didn't register) is converted into a failed scope
 * result so the task finalises instead of hanging until the timeout.
 */
function sendScopeExecuteMessage(): void {
  if (!progress || taskTabId === null) return;
  void chrome.tabs
    .sendMessage(taskTabId, {
      action: "TIKTOK_SCOPE_EXECUTE",
      data: {
        task_id: progress.task_id,
        scope: progress.scope,
        max_items: progress.max_items,
        max_scroll_rounds: progress.max_scroll_rounds,
        max_stagnant_scroll_rounds: progress.max_stagnant_scroll_rounds,
      },
    })
    .catch(() => {
      void handleTiktokScopeResult({
        task_id: progress!.task_id,
        scope: progress!.scope,
        items: [],
        scope_count: 0,
        status: "failed",
        error: "sendMessage_failed",
      });
    });
}

export interface TiktokNativeSaveResultTransport {
  resolveUrl: (path: string) => Promise<string>;
  fetch: (input: string, init: RequestInit) => Promise<unknown>;
}

const TIKTOK_NATIVE_SAVE_RESULT_TRANSPORT: TiktokNativeSaveResultTransport = {
  resolveUrl: apiUrl,
  fetch: authenticatedFetch,
};

export async function postTiktokNativeSaveResult(
  result: NativeSaveResult,
  transport: TiktokNativeSaveResultTransport = TIKTOK_NATIVE_SAVE_RESULT_TRANSPORT,
): Promise<void> {
  try {
    await transport.fetch(await transport.resolveUrl("/sources/tiktok/task-result"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
    });
  } catch {
    // Backend transient unavailability should not crash the service worker.
  }
}

export interface TiktokNativeSaveDispatchDependencies {
  run: (
    task: NativeSaveTask,
    platformSlug: "tiktok",
    postResult: (result: NativeSaveResult) => Promise<void>,
  ) => Promise<void>;
  postResult: (result: NativeSaveResult) => Promise<void>;
}

/** Behavior seam used by executeTask and tests to keep native-result closure explicit. */
export async function dispatchTiktokNativeSaveTask(
  task: NativeSaveTask,
  dependencies: TiktokNativeSaveDispatchDependencies,
): Promise<void> {
  await dependencies.run(task, "tiktok", dependencies.postResult);
}

const TIKTOK_NATIVE_SAVE_DISPATCH_DEPENDENCIES: TiktokNativeSaveDispatchDependencies = {
  run: runNativeSaveTask,
  postResult: postTiktokNativeSaveResult,
};

export async function executeTask(
  task: TiktokTask,
  nativeDependencies: TiktokNativeSaveDispatchDependencies = TIKTOK_NATIVE_SAVE_DISPATCH_DEPENDENCIES,
  mutexAlreadyHeld: boolean = false,
): Promise<TiktokTaskExecutionDisposition> {
  if (task.type === "native_save") {
    if (taskInFlight) return "declined";
    taskInFlight = true;
    try {
      await dispatchTiktokNativeSaveTask(task, nativeDependencies);
    } finally {
      taskInFlight = false;
    }
    return "accepted";
  }
  if (taskInFlight) return "declined";
  // Direct callers acquire here. pollTiktokTaskOnce acquires before
  // claiming from the backend so a busy sibling dispatcher cannot strand
  // an already-claimed TikTok task in ``in_progress``.
  if (!mutexAlreadyHeld && !tryAcquireDispatcherMutex(MUTEX_LABEL)) return "declined";
  taskInFlight = true;
  currentTask = task;

  const messageData = buildTiktokExecuteMessageData(task);
  progress = {
    task_id: task.id,
    scope: task.type,
    max_items: messageData.max_items as number,
    max_scroll_rounds: messageData.max_scroll_rounds as number,
    max_stagnant_scroll_rounds: messageData.max_stagnant_scroll_rounds as number,
  };

  // Contract extension.background = true: account tasks run in a
  // background tab, never stealing browser focus.
  let tab: chrome.tabs.Tab;
  try {
    tab = await createTaskTab({ url: buildTiktokTaskUrl(task), active: false });
  } catch (err) {
    armTaskTimeout(task);
    await postTiktokTaskResult({
      task_id: task.id,
      status: "failed",
      error: "tab_create_failed",
      debug: { tab_create_error: String(err) },
    });
    cleanupTask();
    return "accepted";
  }
  taskTabId = tab.id ?? null;
  ownsTaskTab = true;
  armTaskTimeout(task);
  if (taskTabId === null) {
    await postTiktokTaskResult({
      task_id: task.id,
      status: "failed",
      error: "tab_id_unknown",
    });
    cleanupTask();
    return "accepted";
  }
  onTabReady(taskTabId, sendScopeExecuteMessage, { fallbackMs: 12_000 });
  return "accepted";
}

/**
 * Scope result from the content script. Two-stage staged completion
 * mirroring dy: post the rows as a partial so the backend propagates
 * them incrementally, then the terminal callback. A failed scope skips
 * the partial and finalises as failed immediately (login walls and
 * logged-out tabs are explicit failures, never valid-empty).
 */
export async function handleTiktokScopeResult(result: TiktokScopeResult): Promise<void> {
  await ensureTiktokTaskRecovery();
  if (!progress || result.task_id !== progress.task_id) return;
  if (result.scope !== progress.scope) return;

  if (result.status === "failed") {
    await postTiktokTaskResult({
      task_id: progress.task_id,
      status: "failed",
      error: result.error || "scope_failed",
      debug: {
        scope: result.scope,
        ...(result.debug ?? {}),
      },
    });
    cleanupTask();
    return;
  }

  await postTiktokTaskResult({
    task_id: progress.task_id,
    status: "partial",
    videos: result.items,
    scope_counts: { [result.scope]: result.scope_count },
    debug: {
      scope: result.scope,
      scope_status: result.status,
      ...(result.debug ?? {}),
    },
  });

  await postTiktokTaskResult({
    task_id: progress.task_id,
    status: finalizeTiktokTaskStatus(result.status),
    videos: [],
    scope_counts: { [result.scope]: result.scope_count },
    debug: {
      scope_statuses: { [result.scope]: result.status },
      ...(result.error ? { scope_error: result.error } : {}),
    },
  });
  cleanupTask();
}

// ---------------------------------------------------------------------------
// Polling & alarm wiring
// ---------------------------------------------------------------------------

async function reportDeclinedTask(task: TiktokTask): Promise<void> {
  if (task.type === "native_save") {
    await postTiktokTaskResult({
      task_id: task.id,
      item_key: task.item_key,
      status: "failed",
      error_code: "native_save_failed",
      error_message: "dispatcher_busy_after_claim",
    });
    return;
  }
  await postTiktokTaskResult({
    task_id: task.id,
    status: "failed",
    error: "dispatcher_busy_after_claim",
  });
}

export interface TiktokTaskPollDependencies {
  ensureRecovery: () => Promise<void>;
  canExecute?: () => boolean;
  fetchTask: () => Promise<TiktokTask | null>;
  execute: (
    task: TiktokTask,
    mutexAlreadyHeld: boolean,
  ) => Promise<TiktokTaskExecutionDisposition>;
  reportDeclined: (task: TiktokTask) => Promise<void>;
}

const TIKTOK_TASK_POLL_DEPENDENCIES: TiktokTaskPollDependencies = {
  ensureRecovery: async () => {
    await ensureNativeSaveTaskRecovery();
    await ensureTiktokTaskRecovery();
  },
  canExecute: () => {
    try {
      return typeof globalThis.chrome?.tabs?.create === "function";
    } catch {
      return false;
    }
  },
  fetchTask: fetchNextTask,
  execute: async (task, mutexAlreadyHeld) =>
    executeTask(task, TIKTOK_NATIVE_SAVE_DISPATCH_DEPENDENCIES, mutexAlreadyHeld),
  reportDeclined: reportDeclinedTask,
};

export function pollTiktokTaskOnce(
  dependencies: TiktokTaskPollDependencies = TIKTOK_TASK_POLL_DEPENDENCIES,
): Promise<void> {
  if (pollInFlight) return pollInFlight;
  const running = (async () => {
    await dependencies.ensureRecovery();
    if (taskInFlight) return;
    // A runtime-stream subscriber is not necessarily a fully-capable
    // browser extension worker. Never atomically claim a backend task
    // when this context cannot create the tab the task requires.
    if (dependencies.canExecute && !dependencies.canExecute()) return;

    // GET /next-task atomically changes pending -> in_progress. Take the
    // cross-source slot first so a busy sibling dispatcher can never make
    // us claim a task we then abandon without a tab or terminal callback.
    if (!tryAcquireDispatcherMutex(MUTEX_LABEL)) return;
    let releaseOnExit = true;
    try {
      const task = await dependencies.fetchTask();
      if (!task) return;
      if (task.type === "native_save") {
        // Native-save owns a separate durable runner/recovery lifecycle and
        // does not hold the scope-task mutex.
        releaseDispatcherMutex(MUTEX_LABEL);
        releaseOnExit = false;
        const disposition = await dependencies.execute(task, false);
        if (disposition === "declined") await dependencies.reportDeclined(task);
        return;
      }
      const disposition = await dependencies.execute(task, true);
      if (disposition === "declined") {
        await dependencies.reportDeclined(task);
        return;
      }
      // The task lifecycle now owns the mutex; cleanupTask releases it
      // after a result, timeout, or tab/message failure.
      releaseOnExit = false;
    } finally {
      if (releaseOnExit) releaseDispatcherMutex(MUTEX_LABEL);
    }
  })();
  pollInFlight = running;
  const clearPoll = (): void => {
    if (pollInFlight === running) pollInFlight = null;
  };
  void running.then(clearPoll, clearPoll);
  return running;
}

/**
 * Set up the tiktok task-poll alarm. Idempotent — chrome.alarms.create
 * with an existing name overwrites the schedule. Skip in non-extension
 * environments (node:test importing the module for pure-helper tests).
 *
 * Service-worker.ts owns the global chrome.alarms.onAlarm listener and
 * dispatches into handleTiktokTaskAlarm from there; don't register a
 * second listener here.
 */
export function startTiktokTaskPolling(): void {
  if (typeof chrome === "undefined" || !chrome.alarms) return;
  chrome.alarms.create(POLL_ALARM_NAME, {
    periodInMinutes: DEFAULT_POLL_INTERVAL_MS / 60_000,
  });
}

export function handleTiktokTaskAlarm(alarmName: string): void {
  if (alarmName === POLL_ALARM_NAME) {
    void pollTiktokTaskOnce().catch(() => {});
    return;
  }
  if (alarmName === TASK_TIMEOUT_ALARM_NAME) {
    void (async () => {
      await ensureTiktokTaskRecovery();
      if (!currentTask || taskDeadlineMs === null) return;
      if (Date.now() < taskDeadlineMs) {
        // The browser clamped the one-shot alarm to its minimum delay;
        // re-arm the in-process fast path for the remaining budget.
        armTaskDeadline(taskDeadlineMs);
        return;
      }
      await failActiveTask("task_timeout");
    })().catch(() => {});
  }
}

/**
 * Trigger an immediate poll. Used by the runtime-stream WebSocket
 * handler when the backend broadcasts ``tiktok_task_available``.
 * Idempotent: pollTiktokTaskOnce short-circuits when a task is in
 * flight.
 */
export function pollTiktokTaskNow(): void {
  void pollTiktokTaskOnce().catch(() => {});
}

/**
 * Tests for the TikTok dispatcher's MV3 resilience: active-task
 * persistence into chrome.storage.session, recovery after a simulated
 * worker unload, the chrome.alarms timeout backstop, the pending-result
 * flush, and the orphan task-tab sweep.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ensureTiktokTaskRecovery,
  executeTask,
  handleTiktokScopeResult,
  handleTiktokTaskAlarm,
  resetTiktokTaskStateForTest,
  TIKTOK_PENDING_RESULT_LOCAL_KEY,
  TIKTOK_TASK_STATE_SESSION_KEY,
  type PersistedTiktokTaskState,
  type TiktokTask,
} from "../src/background/tiktok-task-dispatcher.ts";
import { installChromeMock, type ChromeMockState } from "./helpers/chrome-mock.ts";

const TASK_TIMEOUT_ALARM_NAME = "openbiliclaw-tiktok-task-timeout";

interface AlarmCreateCall {
  name: string;
  when?: number;
  periodInMinutes?: number;
}

function installAlarmsMock(): { created: AlarmCreateCall[]; cleared: string[] } {
  const created: AlarmCreateCall[] = [];
  const cleared: string[] = [];
  const chromeApi = (globalThis as { chrome?: Record<string, unknown> }).chrome;
  assert.ok(chromeApi, "chrome mock must be installed before the alarms mock");
  chromeApi.alarms = {
    create(name: string, info: { when?: number; periodInMinutes?: number }) {
      created.push({ name, ...info });
    },
    async clear(name: string) {
      cleared.push(name);
      return true;
    },
  };
  return { created, cleared };
}

function persistedRecord(overrides: Partial<PersistedTiktokTaskState> = {}): PersistedTiktokTaskState {
  const task: TiktokTask = { id: "t-restore", type: "tt_like" };
  return {
    task,
    task_tab_id: 42,
    owns_task_tab: true,
    deadline_ms: Date.now() + 60_000,
    progress: {
      task_id: task.id,
      scope: "tt_like",
      max_items: 300,
      max_scroll_rounds: 15,
      max_stagnant_scroll_rounds: 5,
    },
    ...overrides,
  };
}

function taskResultPosts(state: ChromeMockState): Array<Record<string, unknown>> {
  return state.fetchCalls
    .filter((call) => call.url.endsWith("/api/sources/tiktok/task-result"))
    .map((call) => call.body as Record<string, unknown>);
}

async function settleSessionWrites(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("executeTask persists the active task snapshot and arms the timeout alarm", async () => {
  const state = installChromeMock();
  const alarms = installAlarmsMock();
  try {
    const disposition = await executeTask({
      id: "t-persist",
      type: "tt_collect",
      payload: { max_items: 100, max_scroll_rounds: 5 },
    });
    assert.equal(disposition, "accepted");
    await settleSessionWrites();

    const record = state.sessionStorage[TIKTOK_TASK_STATE_SESSION_KEY] as PersistedTiktokTaskState;
    assert.ok(record, "active task snapshot must be persisted");
    assert.equal(record.task.id, "t-persist");
    assert.equal(record.task.type, "tt_collect");
    assert.equal(record.owns_task_tab, true);
    assert.equal(record.task_tab_id, state.createdTabs[0] ? 42 : null);
    assert.equal(record.progress?.task_id, "t-persist");
    assert.ok(record.deadline_ms > Date.now(), "deadline must be in the future");

    // Contract extension.background = true: the task tab stays backgrounded.
    assert.equal(state.createdTabs[0]?.active, false);
    assert.ok(state.createdTabs[0]?.url.includes("openbiliclaw_tiktok_task=1"));

    const timeoutAlarm = alarms.created.find((call) => call.name === TASK_TIMEOUT_ALARM_NAME);
    assert.ok(timeoutAlarm, "timeout alarm must backstop the in-process timer");
    assert.equal(timeoutAlarm.when, record.deadline_ms);
  } finally {
    resetTiktokTaskStateForTest();
    state.restore();
  }
});

test("a fresh worker restores the persisted task and reports a late result (partial + final)", async () => {
  const state = installChromeMock();
  installAlarmsMock();
  try {
    state.sessionStorage[TIKTOK_TASK_STATE_SESSION_KEY] = persistedRecord();
    state.tabById.set(42, {
      id: 42,
      status: "complete",
      url: "https://www.tiktok.com/@demo",
    });
    // Simulate the service worker being unloaded and a new one waking up.
    resetTiktokTaskStateForTest();

    await handleTiktokScopeResult({
      task_id: "t-restore",
      scope: "tt_like",
      items: [
        {
          scope: "tt_like",
          video_id: "7300000000000000001",
          url: "https://www.tiktok.com/@creator/video/7300000000000000001",
          title: "liked video",
          author_handle: "creator",
          author: "creator",
          cover_url: "",
        },
      ],
      scope_count: 1,
      status: "ok",
    });
    await settleSessionWrites();

    const posts = taskResultPosts(state);
    assert.equal(posts.length, 2, "late result must post partial + final");
    assert.equal(posts[0].task_id, "t-restore");
    assert.equal(posts[0].status, "partial");
    assert.deepEqual(posts[0].scope_counts, { tt_like: 1 });
    assert.equal(posts[1].task_id, "t-restore");
    assert.equal(posts[1].status, "ok");
    assert.deepEqual(posts[1].videos, []);
    assert.ok(
      state.removedTabs.includes(42),
      "the restored task tab must be closed on the final result",
    );
    assert.equal(state.sessionStorage[TIKTOK_TASK_STATE_SESSION_KEY], undefined);
    assert.equal(state.sessionStorage[TIKTOK_PENDING_RESULT_LOCAL_KEY], undefined);
  } finally {
    resetTiktokTaskStateForTest();
    state.restore();
  }
});

test("a failed scope result finalises the task as failed without a partial", async () => {
  const state = installChromeMock();
  installAlarmsMock();
  try {
    state.sessionStorage[TIKTOK_TASK_STATE_SESSION_KEY] = persistedRecord();
    state.tabById.set(42, { id: 42, status: "complete", url: "https://www.tiktok.com/login" });
    resetTiktokTaskStateForTest();

    await handleTiktokScopeResult({
      task_id: "t-restore",
      scope: "tt_like",
      items: [],
      scope_count: 0,
      status: "failed",
      error: "login_wall",
    });
    await settleSessionWrites();

    const posts = taskResultPosts(state);
    assert.equal(posts.length, 1, "a login wall is terminal, never a pseudo-empty success");
    assert.equal(posts[0].status, "failed");
    assert.equal(posts[0].error, "login_wall");
    assert.ok(state.removedTabs.includes(42));
  } finally {
    resetTiktokTaskStateForTest();
    state.restore();
  }
});

test("recovery settles an expired persisted task as task_timeout and closes its tab", async () => {
  const state = installChromeMock();
  installAlarmsMock();
  try {
    state.sessionStorage[TIKTOK_TASK_STATE_SESSION_KEY] = persistedRecord({
      deadline_ms: Date.now() - 1_000,
    });
    resetTiktokTaskStateForTest();

    await ensureTiktokTaskRecovery();
    await settleSessionWrites();

    const posts = taskResultPosts(state);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].task_id, "t-restore");
    assert.equal(posts[0].status, "failed");
    assert.equal(posts[0].error, "task_timeout");
    assert.ok(state.removedTabs.includes(42));
    assert.equal(state.sessionStorage[TIKTOK_TASK_STATE_SESSION_KEY], undefined);
  } finally {
    resetTiktokTaskStateForTest();
    state.restore();
  }
});

test("the timeout alarm is the authoritative backstop after a worker unload", async () => {
  const state = installChromeMock();
  installAlarmsMock();
  try {
    state.sessionStorage[TIKTOK_TASK_STATE_SESSION_KEY] = persistedRecord({
      deadline_ms: Date.now() - 500,
    });
    resetTiktokTaskStateForTest();

    handleTiktokTaskAlarm(TASK_TIMEOUT_ALARM_NAME);
    await settleSessionWrites();

    const posts = taskResultPosts(state);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].status, "failed");
    assert.equal(posts[0].error, "task_timeout");
    assert.ok(state.removedTabs.includes(42));
  } finally {
    resetTiktokTaskStateForTest();
    state.restore();
  }
});

test("recovery fails a task whose recorded tab is already gone", async () => {
  const state = installChromeMock();
  installAlarmsMock();
  try {
    state.getImpl = async (tabId) => {
      throw new Error(`No tab with id: ${tabId}`);
    };
    state.sessionStorage[TIKTOK_TASK_STATE_SESSION_KEY] = persistedRecord({ task_tab_id: 99 });
    resetTiktokTaskStateForTest();

    await ensureTiktokTaskRecovery();
    await settleSessionWrites();

    const posts = taskResultPosts(state);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].status, "failed");
    assert.equal(posts[0].error, "task_tab_closed");
    assert.deepEqual(state.removedTabs, []);
    assert.equal(state.sessionStorage[TIKTOK_TASK_STATE_SESSION_KEY], undefined);
  } finally {
    resetTiktokTaskStateForTest();
    state.restore();
  }
});

test("wake-up sweeps orphan TikTok task-marker tabs but never user tabs", async () => {
  const state = installChromeMock();
  installAlarmsMock();
  try {
    state.queryResult = [
      { id: 7, url: "https://www.tiktok.com/?openbiliclaw_tiktok_task=1" },
      { id: 8, url: "https://www.tiktok.com/" },
      { id: 9, url: "https://www.tiktok.com/?openbiliclaw_dy_task=1" },
    ];
    resetTiktokTaskStateForTest();

    await ensureTiktokTaskRecovery();

    assert.deepEqual(state.removedTabs, [7]);
  } finally {
    resetTiktokTaskStateForTest();
    state.restore();
  }
});

test("wake-up flushes a pending unacknowledged task result before claiming work", async () => {
  const state = installChromeMock();
  installAlarmsMock();
  try {
    const queued = { task_id: "queued-final", status: "ok", videos: [], scope_counts: { tt_history: 4 } };
    state.sessionStorage[TIKTOK_PENDING_RESULT_LOCAL_KEY] = {
      body: JSON.stringify(queued),
      queued_at_ms: Date.now(),
    };
    resetTiktokTaskStateForTest();

    await ensureTiktokTaskRecovery();
    await settleSessionWrites();

    const posts = taskResultPosts(state);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].task_id, "queued-final");
    assert.equal(posts[0].status, "ok");
    assert.equal(state.sessionStorage[TIKTOK_PENDING_RESULT_LOCAL_KEY], undefined);
  } finally {
    resetTiktokTaskStateForTest();
    state.restore();
  }
});

test("an early timeout alarm does not fail a live task before its deadline", async () => {
  const state = installChromeMock();
  installAlarmsMock();
  try {
    const disposition = await executeTask({ id: "t-live", type: "tt_history" });
    assert.equal(disposition, "accepted");

    handleTiktokTaskAlarm(TASK_TIMEOUT_ALARM_NAME);
    await settleSessionWrites();

    assert.deepEqual(taskResultPosts(state), []);
    assert.deepEqual(state.removedTabs, []);
    const record = state.sessionStorage[TIKTOK_TASK_STATE_SESSION_KEY] as PersistedTiktokTaskState;
    assert.equal(record.task.id, "t-live");
  } finally {
    resetTiktokTaskStateForTest();
    state.restore();
  }
});

test("a restored task ignores results for a different scope or task", async () => {
  const state = installChromeMock();
  installAlarmsMock();
  try {
    state.sessionStorage[TIKTOK_TASK_STATE_SESSION_KEY] = persistedRecord();
    resetTiktokTaskStateForTest();

    await handleTiktokScopeResult({
      task_id: "t-restore",
      scope: "tt_collect",
      items: [],
      scope_count: 0,
      status: "empty",
    });
    await handleTiktokScopeResult({
      task_id: "someone-else",
      scope: "tt_like",
      items: [],
      scope_count: 0,
      status: "empty",
    });
    await settleSessionWrites();

    assert.deepEqual(taskResultPosts(state), []);
    assert.deepEqual(state.removedTabs, []);
    const record = state.sessionStorage[TIKTOK_TASK_STATE_SESSION_KEY] as PersistedTiktokTaskState;
    assert.equal(record.task.id, "t-restore", "restored task must stay in flight");
  } finally {
    resetTiktokTaskStateForTest();
    state.restore();
  }
});

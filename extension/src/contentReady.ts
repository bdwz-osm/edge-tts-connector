import browser from "webextension-polyfill";

const DEFAULT_TIMEOUT_MS = 5000;

type Waiter = {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const readyTabs = new Set<number>();
const waiters = new Map<number, Waiter[]>();

export function markContentReady(tabId: number): void {
  readyTabs.add(tabId);
  const list = waiters.get(tabId);
  if (!list?.length) return;
  waiters.delete(tabId);
  for (const w of list) {
    clearTimeout(w.timer);
    w.resolve();
  }
}

export function clearContentReady(tabId: number): void {
  readyTabs.delete(tabId);
  const list = waiters.get(tabId);
  if (!list?.length) return;
  waiters.delete(tabId);
  for (const w of list) {
    clearTimeout(w.timer);
    w.reject(new Error("content gone"));
  }
}

function removeWaiter(tabId: number, w: Waiter): void {
  const cur = waiters.get(tabId);
  if (!cur) return;
  const next = cur.filter((x) => x !== w);
  if (next.length) waiters.set(tabId, next);
  else waiters.delete(tabId);
}

/** Register one waiter; cancel() drops only this waiter (no unhandled reject). */
function registerWaiter(
  tabId: number,
  timeoutMs: number,
): { promise: Promise<void>; cancel: (err: Error) => void } {
  if (readyTabs.has(tabId)) {
    return { promise: Promise.resolve(), cancel: () => {} };
  }

  let settled = false;
  let w!: Waiter;

  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      removeWaiter(tabId, w);
      reject(new Error("content ready timeout"));
    }, timeoutMs);

    w = {
      resolve: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        removeWaiter(tabId, w);
        resolve();
      },
      reject: (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        removeWaiter(tabId, w);
        reject(e);
      },
      timer,
    };

    const list = waiters.get(tabId) ?? [];
    list.push(w);
    waiters.set(tabId, list);
  });

  // Swallow rejection if cancel() already handled via reject — caller awaits.
  return {
    promise,
    cancel: (err: Error) => {
      w.reject(err);
    },
  };
}

export function waitForContentReady(
  tabId: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  return registerWaiter(tabId, timeoutMs).promise;
}

async function ping(tabId: number): Promise<boolean> {
  try {
    await browser.tabs.sendMessage(tabId, { type: "content/ping" });
    return true;
  } catch {
    return false;
  }
}

/** Inject content+CSS and wait for content/ready (or ping if already injected). */
export async function injectContent(
  tabId: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  if (await ping(tabId)) {
    markContentReady(tabId);
    return;
  }

  // Stale ready bit only — do not reject other concurrent waiters.
  readyTabs.delete(tabId);

  const { promise: readyPromise, cancel } = registerWaiter(tabId, timeoutMs);
  // Handler must attach before any await: clearContentReady (nav/gone) can
  // reject during insertCSS/executeScript and would otherwise be unhandled.
  const readyOutcome = readyPromise.then(
    () => null as Error | null,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  );
  let pollAlive = true;

  try {
    await browser.scripting.insertCSS({
      target: { tabId },
      files: ["styles/highlight.css"],
    });
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (e) {
    pollAlive = false;
    const err = e instanceof Error ? e : new Error(String(e));
    cancel(err);
    await readyOutcome;
    throw err;
  }

  // Re-inject no-op (guard already set): no second content/ready — poll ping.
  void (async () => {
    const deadline = Date.now() + timeoutMs;
    while (pollAlive && Date.now() < deadline && !readyTabs.has(tabId)) {
      if (await ping(tabId)) {
        markContentReady(tabId);
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  })();

  try {
    const err = await readyOutcome;
    if (err) throw err;
  } finally {
    pollAlive = false;
  }
}

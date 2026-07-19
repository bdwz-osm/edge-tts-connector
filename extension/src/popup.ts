import browser from "webextension-polyfill";
import type { PopupStatus } from "./messages";
import type { Settings } from "./settings";
import type { VoicesEnvelope, VoiceDto } from "./rpc";

const statusEl = document.getElementById("status")!;
const bannerEl = document.getElementById("banner")!;
const versionEl = document.getElementById("version")!;
const sessionMeta = document.getElementById("sessionMeta")!;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const pauseBtn = document.getElementById("pause") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const prevBtn = document.getElementById("prev") as HTMLButtonElement;
const nextBtn = document.getElementById("next") as HTMLButtonElement;
const langSel = document.getElementById("lang") as HTMLSelectElement;
const voiceSel = document.getElementById("voice") as HTMLSelectElement;
const genSpeedSel = document.getElementById("genSpeed") as HTMLSelectElement;
const playbackEl = document.getElementById("playbackSpeed") as HTMLInputElement;
const playbackOut = document.getElementById("playbackOut")!;
const volumeEl = document.getElementById("volume") as HTMLInputElement;
const volumeOut = document.getElementById("volumeOut")!;
const keepaliveEl = document.getElementById("keepalive") as HTMLInputElement;
const clearBtn = document.getElementById("clearCache") as HTMLButtonElement;
const optionsBtn = document.getElementById("options") as HTMLButtonElement;

let voices: VoiceDto[] = [];
let settings: Settings | null = null;
let applying = false;

function genSpeedOptions() {
  if (genSpeedSel.options.length) return;
  for (let n = -50; n <= 100; n += 10) {
    const v = `${n >= 0 ? "+" : ""}${n}%`;
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    genSpeedSel.appendChild(o);
  }
}

function setStatusClass(kind: "online" | "offline" | "bad-secret" | "unknown") {
  statusEl.className = `status ${kind}`;
}

function showBanner(text: string | null, warn = false) {
  if (!text) {
    bannerEl.classList.add("hidden");
    bannerEl.textContent = "";
    return;
  }
  bannerEl.textContent = text;
  bannerEl.classList.remove("hidden");
  bannerEl.classList.toggle("warn", warn);
}

function langName(code: string): string {
  try {
    return (
      new Intl.DisplayNames(undefined, { type: "language" }).of(code) ?? code
    );
  } catch {
    return code;
  }
}

function fillLangs() {
  const langs = [...new Set(voices.map((v) => v.lang))].sort();
  const cur = settings?.lang ?? "en";
  langSel.innerHTML = "";
  for (const l of langs) {
    const o = document.createElement("option");
    o.value = l;
    o.textContent = langName(l);
    langSel.appendChild(o);
  }
  langSel.value = [...langSel.options].some((o) => o.value === cur)
    ? cur
    : (langs[0] ?? cur);
}

function fillVoices() {
  const lang = langSel.value || settings?.lang || "en";
  const list = voices.filter((v) => v.lang === lang);
  const cur = settings?.voice ?? "";
  voiceSel.innerHTML = "";
  for (const v of list) {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = v.friendlyName || v.id;
    voiceSel.appendChild(o);
  }
  if ([...voiceSel.options].some((o) => o.value === cur)) voiceSel.value = cur;
  else if (list[0]) voiceSel.value = list[0].id;
}

async function send<T = unknown>(msg: Record<string, unknown>): Promise<T> {
  return (await browser.runtime.sendMessage(msg)) as T;
}

async function patchSettings(p: Partial<Settings>) {
  settings = await send<Settings>({
    type: "popup/setSettings",
    patch: p,
  });
}

async function loadVoices() {
  try {
    const env = await send<VoicesEnvelope>({ type: "popup/getVoices" });
    voices = env.voices ?? [];
  } catch {
    voices = [];
  }
}

async function action(type: string) {
  try {
    await send({ type });
  } catch (e) {
    showBanner(e instanceof Error ? e.message : String(e));
  } finally {
    await refresh();
  }
}

async function refresh() {
  genSpeedOptions();
  try {
    const st = await send<PopupStatus>({ type: "popup/getStatus" });

    settings = st.settings;
    applying = true;
    try {
      genSpeedSel.value = settings.genSpeed;
      playbackEl.value = String(settings.playbackSpeed);
      playbackOut.textContent = settings.playbackSpeed.toFixed(2);
      volumeEl.value = String(settings.volume);
      volumeOut.textContent = String(Math.round(settings.volume * 100));
      keepaliveEl.checked = settings.audioKeepalive;
    } finally {
      applying = false;
    }

    const c = st.connection;
    versionEl.textContent = c.version ? `v${c.version}` : "";

    const sess = st.session;
    if (sess.active && sess.total > 0) {
      sessionMeta.textContent = `${sess.status} · ${sess.index + 1}/${sess.total}`;
    } else {
      sessionMeta.textContent = sess.status !== "idle" ? sess.status : "";
    }

    const canTransport =
      c.online && c.secretConfigured && c.secretOk !== false && !st.restricted;
    playBtn.disabled = !canTransport;
    pauseBtn.disabled = !sess.active;
    stopBtn.disabled = !sess.active;
    prevBtn.disabled = !sess.active;
    nextBtn.disabled = !sess.active;

    if (!c.online) {
      statusEl.textContent = "Offline";
      setStatusClass("offline");
      showBanner("Daemon not reachable. Run ./server.sh start.");
      return;
    }
    if (!c.secretConfigured) {
      statusEl.textContent = "No secret";
      setStatusClass("bad-secret");
      showBanner("Set the auth secret in Options.", true);
      return;
    }
    if (c.secretOk === false) {
      statusEl.textContent = "Bad secret";
      setStatusClass("bad-secret");
      showBanner("Secret rejected (401).", true);
      return;
    }

    statusEl.textContent =
      sess.status === "playing"
        ? "Playing"
        : sess.status === "paused"
          ? "Paused"
          : sess.status === "offline"
            ? "Upstream off"
            : "Online";
    setStatusClass(sess.status === "offline" ? "offline" : "online");

    if (st.restricted) {
      showBanner(st.restrictedMessage ?? "Restricted page", true);
      playBtn.disabled = true;
    } else if (sess.errorMessage) {
      showBanner(sess.errorMessage, true);
    } else if (c.errorCode === "voices_unavailable") {
      showBanner("Voice list unavailable; ShortName may still work.", true);
    } else {
      showBanner(null);
    }

    if (!voices.length && c.secretOk) {
      await loadVoices();
    }
    if (voices.length) {
      fillLangs();
      applying = true;
      try {
        langSel.value = settings.lang;
        fillVoices();
      } finally {
        applying = false;
      }
    }
  } catch (e) {
    statusEl.textContent = "Error";
    setStatusClass("offline");
    showBanner(e instanceof Error ? e.message : String(e));
    applying = false;
  }
}

playBtn.addEventListener("click", () => {
  void (async () => {
    playBtn.disabled = true;
    try {
      const r = await send<{ ok: boolean; error?: string }>({
        type: "popup/play",
      });
      if (!r.ok && r.error) showBanner(r.error, true);
    } catch (e) {
      showBanner(e instanceof Error ? e.message : String(e), true);
    } finally {
      await refresh();
    }
  })();
});

pauseBtn.addEventListener("click", () => {
  void action("popup/pause");
});
stopBtn.addEventListener("click", () => {
  void action("popup/stop");
});
prevBtn.addEventListener("click", () => {
  void action("popup/prev");
});
nextBtn.addEventListener("click", () => {
  void action("popup/next");
});

optionsBtn.addEventListener("click", () => {
  void send({ type: "popup/openOptions" }).catch((e) => {
    showBanner(e instanceof Error ? e.message : String(e));
  });
});

clearBtn.addEventListener("click", () => {
  void (async () => {
    try {
      await send({ type: "popup/clearCache" });
      showBanner("Cache cleared.", true);
    } catch (e) {
      showBanner(e instanceof Error ? e.message : String(e));
    }
  })();
});

langSel.addEventListener("change", () => {
  if (applying) return;
  void (async () => {
    try {
      await patchSettings({ lang: langSel.value });
      fillVoices();
      if (voiceSel.value) await patchSettings({ voice: voiceSel.value });
    } catch (e) {
      showBanner(e instanceof Error ? e.message : String(e));
    } finally {
      await refresh();
    }
  })();
});

voiceSel.addEventListener("change", () => {
  if (applying) return;
  void (async () => {
    try {
      await patchSettings({ voice: voiceSel.value });
    } catch (e) {
      showBanner(e instanceof Error ? e.message : String(e));
    } finally {
      await refresh();
    }
  })();
});

genSpeedSel.addEventListener("change", () => {
  if (applying) return;
  void (async () => {
    try {
      await patchSettings({ genSpeed: genSpeedSel.value });
    } catch (e) {
      showBanner(e instanceof Error ? e.message : String(e));
    } finally {
      await refresh();
    }
  })();
});

playbackEl.addEventListener("input", () => {
  playbackOut.textContent = Number(playbackEl.value).toFixed(2);
});
playbackEl.addEventListener("change", () => {
  if (applying) return;
  void patchSettings({ playbackSpeed: Number(playbackEl.value) }).catch((e) => {
    showBanner(e instanceof Error ? e.message : String(e));
  });
});

volumeEl.addEventListener("input", () => {
  volumeOut.textContent = String(Math.round(Number(volumeEl.value) * 100));
});
volumeEl.addEventListener("change", () => {
  if (applying) return;
  void patchSettings({ volume: Number(volumeEl.value) }).catch((e) => {
    showBanner(e instanceof Error ? e.message : String(e));
  });
});

keepaliveEl.addEventListener("change", () => {
  if (applying) return;
  void patchSettings({ audioKeepalive: keepaliveEl.checked }).catch((e) => {
    showBanner(e instanceof Error ? e.message : String(e));
  });
});

void refresh();
setInterval(() => {
  void refresh();
}, 1500);

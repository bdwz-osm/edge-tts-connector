// Content script shell — inject on activate (step 3). Step 2: no auto-run work.
import browser from "webextension-polyfill";

void browser.runtime.sendMessage({ type: "content/ready" }).catch(() => {
  /* background may ignore */
});

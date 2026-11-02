// ETP tools for the autowebcompat-etp agent, inserted into the Firefox DevTools
// MCP bundle by patch-mcp.mjs at image build time.
//
// Each tool runs its chrome-privileged code the way the bundle's own
// get/set_firefox_prefs do: switch to the browser window's chrome context, run,
// then switch back to content in a `finally`. Unlike select_privileged_context,
// that never leaves the session stuck in chrome, so the page tools keep working.

// `isAsync` runs the script with executeAsyncScript: it must call its last
// argument with the result.
async function etpRunChrome(script, { isAsync = false } = {}, ...scriptArgs) {
  const { getFirefox: getFirefox2 } = await Promise.resolve().then(
    () => (init_src(), src_exports)
  );
  const firefox3 = await getFirefox2();
  const tree = await firefox3.sendBiDiCommand("browsingContext.getTree", {
    "moz:scope": "chrome",
  });
  const contexts = tree.contexts || [];
  if (contexts.length === 0) {
    throw new Error(
      "No privileged contexts available. Ensure MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 is set."
    );
  }
  const driver = firefox3.getDriver();
  const originalContextId = firefox3.getCurrentContextId();
  try {
    await driver.switchTo().window(contexts[0].context);
    await driver.setContext("chrome");
    return isAsync
      ? await driver.executeAsyncScript(script, ...scriptArgs)
      : await driver.executeScript(script, ...scriptArgs);
  } finally {
    try {
      await driver.setContext("content");
      if (originalContextId) {
        await driver.switchTo().window(originalContextId);
      }
    } catch {}
  }
}

// Reads every pref the Strict category controls, after Firefox applied `mode`.
const ETP_SET_MODE_SCRIPT = `
  const mode = arguments[0];
  const category = "browser.contentblocking.category";
  // ContentBlockingPrefs observes the category pref and synchronously applies
  // the category's prefs.
  Services.prefs.setStringPref(category, mode);
  const { ContentBlockingPrefs } = ChromeUtils.importESModule(
    "moz-src:///browser/components/protections/ContentBlockingPrefs.sys.mjs"
  );
  const read = (p) => {
    switch (Services.prefs.getPrefType(p)) {
      case Services.prefs.PREF_BOOL: return Services.prefs.getBoolPref(p);
      case Services.prefs.PREF_INT: return Services.prefs.getIntPref(p);
      case Services.prefs.PREF_STRING: return Services.prefs.getStringPref(p);
    }
    return null;
  };
  const prefs = {};
  for (const p of Object.keys(ContentBlockingPrefs.CATEGORY_PREFS.strict)) {
    prefs[p] = read(p);
  }
  return { category: Services.prefs.getStringPref(category), prefs };
`;

// Starts the downloads Strict mode depends on, once per session, and reports
// their progress on every call: the tracker lists (Safe Browsing tables of the
// mozilla provider) and the url-classifier-exceptions Remote Settings
// collection. State lives on the chrome window, which persists between scripts.
//
// List updates are serialized, and each one is bracketed by
// safebrowsing-update-begin (data: provider) and safebrowsing-update-finished
// (data: "success", "update error: ..." or "download error: <status>"), so the
// result of a mozilla update is the "finished" that follows its "begin".
const ETP_LISTS_STATUS_SCRIPT = `
  const PROVIDER = "mozilla";
  const lastUpdate = () =>
    Services.prefs.getStringPref(
      "browser.safebrowsing.provider." + PROVIDER + ".lastupdatetime", ""
    );
  let state = window.__etpLists;
  if (!state) {
    state = window.__etpLists = { lists: {}, rs: { done: false } };
    if (lastUpdate() === "") {
      let provider = null;
      const observer = {
        observe(subject, topic, data) {
          if (topic === "safebrowsing-update-begin") {
            provider = data;
          } else if (provider === PROVIDER) {
            state.lists.result = data;
          }
        },
      };
      Services.obs.addObserver(observer, "safebrowsing-update-begin");
      Services.obs.addObserver(observer, "safebrowsing-update-finished");
      try {
        const started = Cc["@mozilla.org/url-classifier/listmanager;1"]
          .getService(Ci.nsIUrlListManager)
          .forceUpdates(
            Services.prefs.getStringPref(
              "browser.safebrowsing.provider." + PROVIDER + ".lists"
            )
          );
        if (!started) {
          state.lists.result = "update error: the list manager could not start an update";
        }
      } catch (e) {
        state.lists.result = "update error: " + e;
      }
    }
    const { RemoteSettings } = ChromeUtils.importESModule(
      "resource://services-settings/remote-settings.sys.mjs"
    );
    RemoteSettings.pollChanges({ trigger: "manual" })
      .then(() => RemoteSettings("url-classifier-exceptions").get())
      .then((records) => { state.rs = { done: true, exceptions: records.length }; })
      .catch((e) => { state.rs = { done: true, error: String(e) }; });
  }
  const result = state.lists.result ?? null;
  return {
    lists: {
      lastUpdate: lastUpdate(),
      result,
      failed: result !== null && result !== "success",
    },
    exceptionList: state.rs,
  };
`;

const ETP_LISTS_TIMEOUT_MS = 120e3;

// Waits until the tracker lists and the exception list are downloaded. Throws
// as soon as either download fails, or on timeout, with the status attached.
async function etpEnsureProtectionLists() {
  const deadline = Date.now() + ETP_LISTS_TIMEOUT_MS;
  for (;;) {
    const status = await etpRunChrome(ETP_LISTS_STATUS_SCRIPT);
    const details = JSON.stringify(status, null, 2);
    if (status.lists.failed) {
      throw new Error(`Updating the tracker lists failed:\n${details}`);
    }
    if (status.exceptionList.error) {
      throw new Error(`Syncing the ETP exception list failed:\n${details}`);
    }
    if (status.lists.lastUpdate !== "" && status.exceptionList.done) {
      return status;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${
          ETP_LISTS_TIMEOUT_MS / 1e3
        }s waiting for the tracker ` +
          `lists and the ETP exception list:\n${details}`
      );
    }
    await new Promise((resolve2) => setTimeout(resolve2, 2e3));
  }
}

async function handleSetEtpMode(args2) {
  try {
    const { mode } = args2 || {};
    if (mode !== "standard" && mode !== "strict") {
      throw new Error('mode must be "standard" or "strict"');
    }
    // Without the lists, Strict mode blocks nothing: make sure they are there
    // before switching, and fail instead of handing back a Strict mode that
    // silently doesn't block.
    const lists = mode === "strict" ? await etpEnsureProtectionLists() : null;
    const result = await etpRunChrome(ETP_SET_MODE_SCRIPT, {}, mode);
    return successResponse(
      `ETP category is now ${result.category}. Category prefs:\n` +
        JSON.stringify(result.prefs, null, 2) +
        (lists
          ? "\nTracker lists and ETP exception list:\n" +
            JSON.stringify(lists, null, 2)
          : "") +
        "\nReload the page (navigate_page) for the change to apply to it."
    );
  } catch (error2) {
    return errorResponse(
      error2 instanceof Error ? error2 : new Error(String(error2))
    );
  }
}

// Decodes the selected tab's content blocking log; the flag names come from
// nsIWebProgressListener so they stay correct across Firefox versions.
const ETP_CONTENT_BLOCKING_LOG_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const L = Ci.nsIWebProgressListener;
  const names = Object.keys(L).filter((k) =>
    /^STATE_.*(BLOCKED|LOADED|REPLACED|ALLOWED|COOKIES|PARTITIONED)/.test(k)
  );
  const browser = gBrowser.selectedBrowser;
  Promise.resolve(browser.getContentBlockingLog())
    .then((raw) => {
      const log = JSON.parse(raw || "{}");
      const origins = {};
      for (const [origin, entries] of Object.entries(log)) {
        origins[origin] = entries.map(([state, blocked, count]) => ({
          flags: names.filter((k) => state & L[k]),
          blocked,
          count,
        }));
      }
      done({ url: browser.currentURI.spec, origins });
    })
    .catch((e) => done({ error: String(e) }));
`;

async function handleGetContentBlockingLog() {
  try {
    // Async, since getContentBlockingLog() may return a promise.
    const result = await etpRunChrome(ETP_CONTENT_BLOCKING_LOG_SCRIPT, {
      isAsync: true,
    });
    if (result.error) {
      throw new Error(result.error);
    }
    return successResponse(
      `Content blocking log for ${result.url}:\n` +
        JSON.stringify(result.origins, null, 2)
    );
  } catch (error2) {
    return errorResponse(
      error2 instanceof Error ? error2 : new Error(String(error2))
    );
  }
}

// navigate_page only waits for "interactive" (HTML parsed), before the
// scripts, iframes and widgets a page needs have loaded. Waiting inside
// evaluate_script instead fails: the bundle aborts every BiDi command after
// 10s. So poll document.readyState with short, separate commands until the
// load event, then give late scripts a moment. A page that never reaches
// "complete" is reported, not treated as an error: being stuck loading can be
// exactly the breakage under investigation.
const ETP_PAGE_STATE_EXPRESSION =
  "JSON.stringify({ readyState: document.readyState, url: location.href })";

async function handleWaitForPageLoad(args2) {
  try {
    const { timeoutSeconds = 30, settleSeconds = 2 } = args2 || {};
    const { getFirefox: getFirefox2 } = await Promise.resolve().then(
      () => (init_src(), src_exports)
    );
    const firefox3 = await getFirefox2();
    const started = Date.now();
    const deadline = started + timeoutSeconds * 1e3;
    let state = null;
    for (;;) {
      try {
        const result = await firefox3.sendBiDiCommand("script.evaluate", {
          expression: ETP_PAGE_STATE_EXPRESSION,
          target: { context: firefox3.getCurrentContextId() },
          awaitPromise: false,
        });
        if (result.type === "success") {
          state = JSON.parse(result.result.value);
        }
      } catch {
        // Mid-navigation the old document can go away under the command, and
        // a busy page can time it out; keep polling until the deadline.
      }
      if (
        (state && state.readyState === "complete") ||
        Date.now() >= deadline
      ) {
        break;
      }
      await new Promise((resolve2) => setTimeout(resolve2, 500));
    }
    const waited = ((Date.now() - started) / 1e3).toFixed(1);
    if (!state || state.readyState !== "complete") {
      return successResponse(
        `The page did not finish loading within ${timeoutSeconds}s: ` +
          `readyState is ${state ? `"${state.readyState}"` : "unknown"}` +
          (state ? ` at ${state.url}` : "") +
          ". If the report says the page is stuck loading, this is the breakage."
      );
    }
    await new Promise((resolve2) => setTimeout(resolve2, settleSeconds * 1e3));
    return successResponse(
      `The page finished loading after ${waited}s (${state.url}); waited ` +
        `${settleSeconds}s more for late scripts.`
    );
  } catch (error2) {
    return errorResponse(
      error2 instanceof Error ? error2 : new Error(String(error2))
    );
  }
}

var waitForPageLoadTool = {
  name: "wait_for_page_load",
  description:
    'Wait until the selected page has fully loaded (document.readyState is "complete"), then a little longer for late scripts. Call it after navigate_page and after clicks that load content, instead of waiting inside evaluate_script. Reports a page that never finishes loading instead of failing.',
  inputSchema: {
    type: "object",
    properties: {
      timeoutSeconds: {
        type: "number",
        description: "How long to wait for the load (default 30)",
      },
      settleSeconds: {
        type: "number",
        description: "Extra wait after the load for late scripts (default 2)",
      },
    },
  },
};

var setEtpModeTool = {
  name: "set_etp_mode",
  description:
    "Switch Enhanced Tracking Protection to the Standard or Strict category at runtime (no restart). Firefox applies all of the category's prefs at once; the response lists them. Switching to Strict fails with an error if the tracker lists or the ETP exception list can't be downloaded. Reload the page afterwards. Requires MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["standard", "strict"],
        description: "ETP category to switch to",
      },
    },
    required: ["mode"],
  },
};

var getContentBlockingLogTool = {
  name: "get_content_blocking_log",
  description:
    "Return the content blocking log of the selected tab: every third-party origin with its STATE_* flags (e.g. STATE_BLOCKED_SOCIALTRACKING_CONTENT names the feature that blocked it). Does not change the selected page. Requires MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1.",
  inputSchema: { type: "object", properties: {} },
};

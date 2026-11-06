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

// Filter lists the content classifier can block with instead of the tracker
// lists. `probe` is a URL the list blocks and the other lists don't, so a match
// shows that this list in particular is loaded.
const ETP_FILTER_LISTS = {
  easyprivacy: {
    name: "EasyPrivacy",
    url: "https://easylist.to/easylist/easyprivacy.txt",
    probe: "https://www.google-analytics.com/analytics.js",
  },
  easylist: {
    name: "EasyList",
    url: "https://easylist.to/easylist/easylist.txt",
    probe: "https://ib.adnxs.com/ut/v3/prebid",
  },
};

// The modes that block with filter lists, with the lists each one uses.
const ETP_FILTER_LIST_MODES = {
  "strict/easyprivacy": [ETP_FILTER_LISTS.easyprivacy],
  "strict/easylist+easyprivacy": [
    ETP_FILTER_LISTS.easylist,
    ETP_FILTER_LISTS.easyprivacy,
  ],
};

const ETP_MODES = ["standard", "strict", ...Object.keys(ETP_FILTER_LIST_MODES)];

// The mode last set with set_etp_mode, which get_content_blocking_log records
// its logs under. Firefox starts in Standard.
let etpCurrentMode = "standard";

const ETP_SET_MODE_SCRIPT = `
  // listUrls is the test_list_urls value for a filter-list mode, else null.
  const [mode, listUrls] = arguments;
  const category = "browser.contentblocking.category";
  const CC = "privacy.trackingprotection.content.";
  // The service ignores pref changes until it exists. Getting it creates it,
  // but fails while it is disabled, after creating it.
  try {
    Cc["@mozilla.org/content-classifier-service;1"].getService(
      Ci.nsIContentClassifierService
    );
  } catch {}
  // Clearing protection.enabled drops the classifier's engines, and setting
  // test_list_urls afterwards is always a change, which is what makes the
  // classifier download the list (enabling it alone does not).
  for (const p of [
    "protection.enabled",
    "protection.engines",
    "protection.engines.pbmode",
    "protection.test_list_urls",
  ]) {
    Services.prefs.clearUserPref(CC + p);
  }
  if (listUrls !== null) {
    // With the mirror on, switching the category below would overwrite the
    // engines prefs with the tracker-list engines.
    Services.prefs.setIntPref(CC + "mirror.mode", 0);
    Services.prefs.setStringPref(CC + "protection.engines", "test_block");
    Services.prefs.setStringPref(CC + "protection.engines.pbmode", "test_block");
    Services.prefs.setBoolPref(CC + "protection.enabled", true);
    Services.prefs.setStringPref(CC + "protection.test_list_urls", listUrls);
  }
  // ContentBlockingPrefs observes the category pref and synchronously applies
  // the category's prefs.
  Services.prefs.setStringPref(
    category,
    listUrls !== null ? "strict" : mode
  );
  const { ContentBlockingPrefs } = ChromeUtils.importESModule(
    "moz-src:///browser/components/protections/ContentBlockingPrefs.sys.mjs"
  );
  const read = (branch, p) => {
    try {
      switch (branch.getPrefType(p)) {
        case branch.PREF_BOOL: return branch.getBoolPref(p);
        case branch.PREF_INT: return branch.getIntPref(p);
        case branch.PREF_STRING: return branch.getStringPref(p);
      }
    } catch {}
    return null;
  };
  const defaults = Services.prefs.getDefaultBranch("");
  const changed = {};
  for (const p of Object.keys(ContentBlockingPrefs.CATEGORY_PREFS.strict)) {
    const value = read(Services.prefs, p);
    const standard = read(defaults, p);
    if (value !== standard) {
      changed[p] = { value, standard };
    }
  }
  return { category: Services.prefs.getStringPref(category), changed };
`;

// Clears cookies, site data and caches, so the next load is a first visit like
// in a fresh Private Browsing window. Otherwise state from the previous mode
// carries over: e.g. a bot-protection cookie earned in Standard lets the site
// skip the challenge that breaks in Strict. Calls back with the flags of the
// cleaners that failed (0 if none).
const ETP_CLEAR_DATA_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const S = Ci.nsIClearDataService;
  Services.clearData.deleteData(
    S.CLEAR_ALL_CACHES | S.CLEAR_COOKIES_AND_SITE_DATA,
    { onDataDeleted: (failedFlags) => done({ failedFlags }) }
  );
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

// Reports whether the content classifier's "test_block" engine blocks `url`.
// Until the downloads finish the engine doesn't exist (NS_ERROR_NOT_AVAILABLE);
// a list whose download fails is left out of it, so its probe never matches.
const ETP_PROBE_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const url = arguments[0];
  const service = Cc["@mozilla.org/content-classifier-service;1"].getService(
    Ci.nsIContentClassifierService
  );
  const request = {
    url,
    sourceUrl: "https://example.com/",
    topWindowUrl: "https://example.com/",
    requestType: "script",
    privateBrowsing: false,
    forceThirdPartyToTop: false,
    isNonRecommendedAddon: false,
  };
  const notBuilt = (e) => e?.result === Cr.NS_ERROR_NOT_AVAILABLE;
  try {
    service
      .probeFeature("test_block", request)
      .then((r) => done({ ready: r.matched }))
      .catch((e) => done(notBuilt(e) ? { ready: false } : { error: String(e) }));
  } catch (e) {
    done(notBuilt(e) ? { ready: false } : { error: String(e) });
  }
`;

// Waits until the content classifier blocks with each of `lists`. Throws on
// timeout, which also covers a failed download.
async function etpWaitForFilterLists(lists) {
  const deadline = Date.now() + ETP_LISTS_TIMEOUT_MS;
  for (const list of lists) {
    for (;;) {
      const status = await etpRunChrome(
        ETP_PROBE_SCRIPT,
        { isAsync: true },
        list.probe
      );
      if (status.error) {
        throw new Error(
          `Probing the content classifier failed: ${status.error}`
        );
      }
      if (status.ready) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${ETP_LISTS_TIMEOUT_MS / 1e3}s waiting for the ` +
            `content classifier to load the ${list.name} list from ` +
            `${list.url} (it still doesn't block ${list.probe}); the ` +
            "download may have failed."
        );
      }
      await new Promise((resolve2) => setTimeout(resolve2, 1e3));
    }
  }
}

async function handleSetEtpMode(args2) {
  try {
    const { mode } = args2 || {};
    if (!ETP_MODES.includes(mode)) {
      throw new Error(
        `mode must be one of ${ETP_MODES.map((m) => `"${m}"`).join(", ")}`
      );
    }
    const filterLists = ETP_FILTER_LIST_MODES[mode] ?? null;
    // Without the lists, Strict mode blocks nothing: make sure they are there
    // before switching, and fail instead of handing back a Strict mode that
    // silently doesn't block.
    const lists = mode === "strict" ? await etpEnsureProtectionLists() : null;
    const result = await etpRunChrome(
      ETP_SET_MODE_SCRIPT,
      {},
      mode,
      filterLists && filterLists.map((list) => list.url).join("|")
    );
    // The mode's prefs are applied now, even if a later step fails.
    etpCurrentMode = mode;
    if (filterLists) {
      await etpWaitForFilterLists(filterLists);
    }
    const { failedFlags } = await etpRunChrome(ETP_CLEAR_DATA_SCRIPT, {
      isAsync: true,
    });
    if (failedFlags) {
      throw new Error(
        `Clearing cookies, site data and caches failed (flags ${failedFlags})`
      );
    }
    const changed = Object.entries(result.changed);
    return successResponse(
      `ETP category is now ${result.category}. ` +
        (changed.length
          ? "Prefs off their Standard values:\n" +
            changed
              .map(
                ([p, { value, standard }]) =>
                  `${p} = ${JSON.stringify(value)} (Standard: ${JSON.stringify(
                    standard
                  )})`
              )
              .join("\n") +
            "\n"
          : "All of its prefs are at their Standard values.\n") +
        (lists
          ? `Tracker lists updated ${new Date(
              Number(lists.lists.lastUpdate)
            ).toISOString()}; ${
              lists.exceptionList.exceptions
            } ETP exception records.\n`
          : "") +
        (filterLists
          ? `Blocking with ${filterLists
              .map((list) => `the ${list.name} list (${list.url})`)
              .join(" and ")} in the content classifier instead of the ` +
            "tracker lists; they are loaded and blocking. Blocked resources show as STATE_BLOCKED_TRACKING_CONTENT " +
            "(or STATE_REPLACED_TRACKING_CONTENT when shimmed).\n"
          : "") +
        "Cleared cookies, site data and caches, so the next load is a first visit.\n" +
        "Reload the page (navigate_page) for the change to apply to it."
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

// Flags of a tracker request the classifier blocked, or replaced with a shim
// (which also keeps the tracker from loading). Not mixed-content, Safe Browsing
// or cookie blocking.
const ETP_BLOCKED_TRACKER_FLAG_RE =
  /^STATE_(BLOCKED|REPLACED)_(TRACKING|SOCIALTRACKING|EMAILTRACKING|FINGERPRINTING|CRYPTOMINING)_CONTENT$/;

// The origins in `origins` (as decoded by ETP_CONTENT_BLOCKING_LOG_SCRIPT)
// with a blocked tracker.
function etpBlockedTrackers(origins) {
  return Object.keys(origins).filter((origin) =>
    origins[origin].some((entry) =>
      entry.flags.some((flag) => ETP_BLOCKED_TRACKER_FLAG_RE.test(flag))
    )
  );
}

// Appends a log to the JSON file named by ETP_CONTENT_BLOCKING_LOG_FILE, under
// the mode last set with set_etp_mode: { [mode]: [{ time, url, blockedTrackers, origins }, ...] }. The
// agent then publishes the file with the run, so the full logs don't have to go
// through its context. Does nothing if the variable isn't set.
async function etpRecordContentBlockingLog(mode, result, blocked) {
  const path = process.env.ETP_CONTENT_BLOCKING_LOG_FILE;
  if (!path) {
    return;
  }
  const { readFile, writeFile } = await import("node:fs/promises");
  let logs = {};
  try {
    logs = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      throw e;
    }
  }
  (logs[mode] ??= []).push({
    time: new Date().toISOString(),
    url: result.url,
    blockedTrackers: blocked,
    origins: result.origins,
  });
  await writeFile(path, JSON.stringify(logs, null, 2));
}

async function handleGetContentBlockingLog() {
  try {
    // Async, since getContentBlockingLog() may return a promise.
    const result = await etpRunChrome(ETP_CONTENT_BLOCKING_LOG_SCRIPT, {
      isAsync: true,
    });
    if (result.error) {
      throw new Error(result.error);
    }
    const blocked = etpBlockedTrackers(result.origins);
    await etpRecordContentBlockingLog(etpCurrentMode, result, blocked);
    return successResponse(
      `Content blocking log for ${result.url}:\n` +
        `Blocked trackers: ${blocked.length}` +
        (blocked.length ? ` (${blocked.join(", ")})` : "") +
        "\n" +
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
    'Switch Enhanced Tracking Protection to the Standard or Strict category at runtime (no restart). Firefox applies all of the category\'s prefs at once; the response lists the ones off their Standard values. Also clears all cookies, site data and caches, so the next load is a first visit (logins and site state are lost). Switching to Strict fails with an error if the tracker lists or the ETP exception list can\'t be downloaded. "strict/easyprivacy" and "strict/easylist+easyprivacy" are Strict, but block with the EasyPrivacy list, or EasyList and EasyPrivacy together (via the content classifier), instead of the tracker lists, fingerprinter and cryptominer lists and the ETP exception list; they wait until the lists are downloaded and blocking, and fail if they aren\'t. Reload the page afterwards. Requires MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1.',
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ETP_MODES,
        description:
          "ETP category to switch to; strict/easyprivacy is Strict with the EasyPrivacy list as the only block list, strict/easylist+easyprivacy with EasyList and EasyPrivacy as the only block lists",
      },
    },
    required: ["mode"],
  },
};

var getContentBlockingLogTool = {
  name: "get_content_blocking_log",
  description:
    "Return the content blocking log of the selected tab: every third-party origin with its STATE_* flags (e.g. STATE_BLOCKED_SOCIALTRACKING_CONTENT names the feature that blocked it), headed by the number of blocked trackers: origins with a STATE_BLOCKED_* or STATE_REPLACED_* tracker flag. Does not change the selected page. Requires MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1.",
  inputSchema: { type: "object", properties: {} },
};

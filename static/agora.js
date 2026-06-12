(function () {
  var THEME_KEY = "aesculon-theme";
  var INTRO_DISMISSED_KEY = "aesculon-intro-dismissed-v1";
  var QUESTION_DISCLAIMER_KEY = "aesculon-question-disclaimer-v1";
  var RELEASE_SEEN_KEY = "aesculon-release-seen";
  var UPDATE_DISMISSED_KEY = "aesculon-update-dismissed-version";
  var FOCUS_PLAYER_URL_KEY = "aesculon-focus-player-url";
  var FOCUS_PLAYER_STATE_KEY = "aesculon-focus-player-state";
  var VERSION_POLL_MS = 120000;
  var state = {
    authenticated: false,
    authMode: "register",
    user: null,
    filters: {
      block: "",
      topic: "",
      mode: "unanswered",
      tier: "",
      style: "",
    },
    draftFilters: {
      block: "",
      topic: "",
      mode: "unanswered",
      tier: "",
      style: "",
    },
    options: null,
    currentQuestion: null,
    optionDisplayByAnswer: {},
    sessionQuestionIds: [],
    startedAt: Date.now(),
    sessionAnswered: 0,
    sessionCorrect: 0,
    openFilters: false,
    duelCode: "",
    duelPoll: null,
    duelRoomsPoll: null,
    duelTimerKey: "",
    renderedDuelQuestionId: "",
    exam: null,
    examIndex: 0,
    examStartedAt: 0,
    examTimer: null,
    examSubmitting: false,
    focusPlayer: null,
    focusReady: false,
    focusProgressTimer: null,
    focusPendingMedia: null,
    focusPendingAutoplay: false,
    focusResumeState: null,
    focusLastPersistedAt: 0,
    lastInitKey: "",
    answerSubmitting: false,
    authDelegated: false,
    questionVoteDelegated: false,
    shellNavBound: false,
    wakeBound: false,
    versionPollBound: false,
    filterChipBound: false,
    activePage: "",
    answerSubmittingAt: 0,
  };

  document.addEventListener("DOMContentLoaded", init);
  document.addEventListener("turbo:load", init);
  document.addEventListener("turbo:before-visit", cleanupBeforeTurboVisit);
  document.addEventListener("turbo:before-cache", cleanupBeforeTurboCache);
  window.addEventListener("beforeunload", persistFocusPlayerState);

  async function init() {
    var initKey = window.location.href + "|" + (document.body ? document.body.dataset.page : "");
    if (state.lastInitKey === initKey) return;
    state.lastInitKey = initKey;
    initThemeToggle();
    if (featureEnabled("shell_navigation")) initShellNavigation();
    initWakeRecovery();
    initIntroDialog();
    initVersionAwareness();
    initAuthPanel();
    bindQuestionVoteControls();
    initPatchNotes();
    initNotifications();
    if (featureEnabled("site_feedback")) initSiteFeedback();
    if (featureEnabled("focus_player")) initFocusPlayer();
    await refreshSession();
    preparePageState();
    initPage();
  }

  function featureEnabled(name) {
    var body = document.body;
    if (!body || !body.dataset) return true;
    var key = "feature" + name.split("_").map(function (part) {
      return part.charAt(0).toUpperCase() + part.slice(1);
    }).join("");
    return body.dataset[key] !== "false";
  }

  function preparePageState() {
    var page = document.body ? document.body.dataset.page : "";
    if (page === state.activePage) return;
    if (state.activePage === "duel_page") {
      clearDuelPoll();
      clearDuelRoomsPoll();
    }
    if (state.activePage === "exam_page") {
      clearExamTimer();
    }
    if (page === "practice" && state.activePage && state.activePage !== "practice") {
      resetSession();
      state.currentQuestion = null;
      state.optionDisplayByAnswer = {};
    }
    state.activePage = page;
  }

  function cleanupBeforeTurboVisit() {
    persistFocusPlayerState();
    clearDuelPoll();
    clearDuelRoomsPoll();
    clearExamTimer();
  }

  function cleanupBeforeTurboCache() {
    document.querySelectorAll("dialog[open]").forEach(function (dialog) {
      if (typeof dialog.close === "function") dialog.close();
    });
    document.querySelectorAll(".filter-drawer.open").forEach(function (drawer) {
      drawer.classList.remove("open");
    });
    // Remove dataset bound flags so they get re-bound on restoration or new visits
    document.querySelectorAll("[data-bound]").forEach(function (el) {
      delete el.dataset.bound;
    });
    document.querySelectorAll("[data-bound-actions]").forEach(function (el) {
      delete el.dataset.boundActions;
    });
    document.querySelectorAll("[data-bound-rooms]").forEach(function (el) {
      delete el.dataset.boundRooms;
    });
    document.querySelectorAll("[data-bound-invite]").forEach(function (el) {
      delete el.dataset.boundInvite;
    });
  }

  function initShellNavigation() {
    if (state.shellNavBound) return;
    state.shellNavBound = true;
    if (!window.history.state || !window.history.state.aesculonShell) {
      try {
        window.history.replaceState({ aesculonShell: true }, "", window.location.href);
      } catch {}
    }
    document.addEventListener("click", function (event) {
      var link = event.target.closest ? event.target.closest("a[href]") : null;
      if (!link || !shouldShellNavigate(link, event)) return;
      event.preventDefault();
      navigateShell(link.href, true);
    });
    window.addEventListener("popstate", function () {
      navigateShell(window.location.href, false);
    });
  }

  function shouldShellNavigate(link, event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    if (link.target && link.target !== "_self") return false;
    if (link.hasAttribute("download")) return false;
    if (link.dataset && (link.dataset.noShellNav === "true" || link.dataset.turbo === "false")) return false;
    var href = link.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#") return false;
    var url;
    try {
      url = new URL(link.href, window.location.href);
    } catch {
      return false;
    }
    if (url.origin !== window.location.origin) return false;
    if (url.pathname === window.location.pathname && url.search === window.location.search) return false;
    return true;
  }

  async function navigateShell(url, push) {
    cleanupBeforeShellVisit();
    try {
      var response = await fetch(url, {
        credentials: "same-origin",
        headers: { "X-Requested-With": "AesculonShell" },
      });
      if (!response.ok) throw new Error("Navigation failed");
      var html = await response.text();
      var doc = new DOMParser().parseFromString(html, "text/html");
      var nextMain = doc.querySelector(".main-content");
      var currentMain = document.querySelector(".main-content");
      if (!nextMain || !currentMain) throw new Error("Navigation target missing");
      document.title = doc.title || document.title;
      syncBodyDataset(doc.body);
      replaceShellFragment(doc, ".topnav");
      replaceShellFragment(doc, ".mobile-nav");
      replaceShellFragment(doc, ".footer");
      currentMain.innerHTML = nextMain.innerHTML;
      var finalUrl = response.url || url;
      if (push) {
        window.history.pushState({ aesculonShell: true }, "", finalUrl);
      }
      state.lastInitKey = "";
      window.scrollTo(0, 0);
      await init();
    } catch (error) {
      window.location.href = url;
    }
  }

  function cleanupBeforeShellVisit() {
    persistFocusPlayerState();
    clearDuelPoll();
    clearDuelRoomsPoll();
    clearExamTimer();
    document.querySelectorAll("dialog[open]").forEach(function (dialog) {
      if (typeof dialog.close === "function") dialog.close();
    });
    document.querySelectorAll(".filter-drawer.open").forEach(function (drawer) {
      drawer.classList.remove("open");
    });
  }

  function syncBodyDataset(nextBody) {
    if (!nextBody || !document.body) return;
    document.body.dataset.page = nextBody.dataset.page || "";
    document.body.dataset.appVersion = nextBody.dataset.appVersion || "";
  }

  function replaceShellFragment(doc, selector) {
    var current = document.querySelector(selector);
    var next = doc.querySelector(selector);
    if (current && next) current.innerHTML = next.innerHTML;
  }

  function initWakeRecovery() {
    if (state.wakeBound) return;
    state.wakeBound = true;
    window.addEventListener("pageshow", recoverPracticeAfterWake);
    window.addEventListener("focus", recoverPracticeAfterWake);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) recoverPracticeAfterWake();
    });
  }

  function recoverPracticeAfterWake() {
    if (!document.body || document.body.dataset.page !== "practice") return;
    if (!state.currentQuestion || hasAnswerResolved()) return;
    if (state.answerSubmitting && Date.now() - state.answerSubmittingAt < 10000) return;
    state.answerSubmitting = false;
    state.answerSubmittingAt = 0;
    enableOptions();
    showAnswerError("");
  }

  function initThemeToggle() {
    var toggle = document.querySelector("[data-theme-toggle]");
    if (!toggle || toggle.dataset.bound) return;
    toggle.dataset.bound = "true";
    toggle.addEventListener("click", function () {
      var next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem(THEME_KEY, next);
    });
  }

  function initIntroDialog() {
    var dialog = document.querySelector("[data-intro-dialog]");
    if (!dialog) return;
    try {
      if (localStorage.getItem(INTRO_DISMISSED_KEY)) return;
    } catch {}
    if (!dialog.dataset.bound) {
      dialog.dataset.bound = "true";
      dialog.addEventListener("close", function () {
        var never = document.querySelector("[data-intro-never]");
        if (!never || !never.checked) return;
        try {
          localStorage.setItem(INTRO_DISMISSED_KEY, "true");
        } catch {}
      });
    }
    window.setTimeout(function () {
      if (dialog.open) return;
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.classList.add("open");
      }
    }, 180);
  }

  function initVersionAwareness() {
    var currentVersion = document.body ? document.body.dataset.appVersion : "";
    if (!currentVersion) return;
    var updateDialog = document.querySelector("[data-version-update-dialog]");
    var releaseDialog = document.querySelector("[data-release-dialog]");
    var refresh = document.querySelector("[data-version-refresh]");
    var dismiss = document.querySelector("[data-version-dismiss]");
    if (refresh && !refresh.dataset.bound) {
      refresh.dataset.bound = "true";
      refresh.addEventListener("click", function () {
        window.location.reload();
      });
    }
    if (dismiss && !dismiss.dataset.bound) {
      dismiss.dataset.bound = "true";
      dismiss.addEventListener("click", function () {
        var version = updateDialog ? updateDialog.dataset.availableVersion : "";
        if (version) {
          try {
            sessionStorage.setItem(UPDATE_DISMISSED_KEY, version);
          } catch {}
        }
        closeDialog(updateDialog);
      });
    }
    if (releaseDialog && !releaseDialog.dataset.bound) {
      releaseDialog.dataset.bound = "true";
      releaseDialog.addEventListener("close", function () {
        var releaseId = releaseDialog.dataset.releaseId || "";
        if (!releaseId) return;
        try {
          localStorage.setItem(RELEASE_SEEN_KEY, releaseId);
        } catch {}
      });
    }
    fetchVersionInfo().then(function (info) {
      showReleaseNotesIfNeeded(info, releaseDialog);
    }).catch(function () {});
    if (state.versionPollBound) return;
    state.versionPollBound = true;
    window.setInterval(function () {
      var liveVersion = document.body ? document.body.dataset.appVersion : "";
      var liveDialog = document.querySelector("[data-version-update-dialog]");
      fetchVersionInfo().then(function (info) {
        showUpdatePromptIfNeeded(info, liveVersion, liveDialog);
      }).catch(function () {});
    }, VERSION_POLL_MS);
  }

  async function fetchVersionInfo() {
    return api("/api/version?_=" + Date.now());
  }

  function showUpdatePromptIfNeeded(info, currentVersion, dialog) {
    if (!dialog || !info || !info.version || info.version === currentVersion) return;
    try {
      if (sessionStorage.getItem(UPDATE_DISMISSED_KEY) === info.version) return;
    } catch {}
    dialog.dataset.availableVersion = info.version;
    showDialogWhenClear(dialog, 0);
  }

  function showReleaseNotesIfNeeded(info, dialog) {
    if (!dialog || !info || !info.announcement || !info.announcement.active) return;
    var releaseId = info.announcement.id || info.version;
    if (!releaseId) return;
    try {
      if (localStorage.getItem(RELEASE_SEEN_KEY) === releaseId) return;
    } catch {}
    dialog.dataset.releaseId = releaseId;
    setText("[data-release-title]", info.announcement.title || "What's new");
    setText("[data-release-summary]", info.announcement.summary || "A larger Aesculon update has landed.");
    var list = document.querySelector("[data-release-items]");
    if (list) {
      var items = Array.isArray(info.announcement.items) ? info.announcement.items : [];
      list.innerHTML = items.map(function (item) {
        return "<li>" + escapeHtml(item) + "</li>";
      }).join("");
      list.classList.toggle("hidden", items.length === 0);
    }
    showDialogWhenClear(dialog, 500);
  }

  function showDialogWhenClear(dialog, delay) {
    if (!dialog) return;
    window.setTimeout(function waitForClearDialog() {
      var openDialog = document.querySelector("dialog[open]");
      if (openDialog && openDialog !== dialog) {
        window.setTimeout(waitForClearDialog, 500);
        return;
      }
      openDialogElement(dialog);
    }, delay || 0);
  }

  function openDialogElement(dialog) {
    if (!dialog || dialog.open) return;
    dialog.classList.remove("is-visible");
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
        window.requestAnimationFrame(function () {
          dialog.classList.add("is-visible");
        });
        return;
      } catch {}
    }
    dialog.classList.add("open");
    window.requestAnimationFrame(function () {
      dialog.classList.add("is-visible");
    });
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    dialog.classList.remove("is-visible");
    if (typeof dialog.close === "function" && dialog.open) {
      dialog.close();
      return;
    }
    dialog.classList.remove("open");
  }

  function initAuthPanel() {
    if (state.authDelegated) return;
    state.authDelegated = true;

    // Delegate "Enter the temple" click
    document.addEventListener("click", function (event) {
      var open = event.target.closest("[data-auth-open]");
      if (open) {
        event.preventDefault();
        showAuthPanel(state.authMode);
      }
    });

    // Delegate inline auth links click
    document.addEventListener("click", function (event) {
      var inline = event.target.closest("[data-inline-auth]");
      if (inline) {
        event.preventDefault();
        showAuthPanel(inline.dataset.inlineAuth);
      }
    });

    // Delegate tabs switch click
    document.addEventListener("click", function (event) {
      var tab = event.target.closest("[data-auth-mode]");
      if (tab) {
        showAuthPanel(tab.dataset.authMode);
      }
    });

    // Delegate forgot password click
    document.addEventListener("click", async function (event) {
      var forgot = event.target.closest("[data-auth-forgot]");
      if (forgot) {
        event.preventDefault();
        if (forgot.disabled) return;
        var form = document.querySelector("[data-auth-form]");
        if (!form) return;
        var email = form.elements.email.value.trim();
        setAuthError("");
        setAuthNote("");
        if (!email) {
          setAuthError("Enter your account email first.");
          return;
        }

        var originalText = forgot.textContent;
        forgot.textContent = "Sending request...";
        forgot.disabled = true;
        forgot.style.opacity = "0.6";
        forgot.style.cursor = "not-allowed";
        setAuthNote("Consulting the temple ledger... please wait.");

        try {
          var payload = await api("/api/auth/forgot-password", {
            method: "POST",
            body: JSON.stringify({ email: email }),
          });
          var message = "If that email is in the ledger, a reset link will be sent shortly. Note: Email delivery may take ~2-5 minutes.";
          if (payload.reset_url) message += " Dev reset link: " + payload.reset_url;
          setAuthNote(message);
        } catch (error) {
          setAuthNote("");
          setAuthError(error.error || "The reset messenger could not be reached.");
        } finally {
          forgot.textContent = originalText;
          forgot.disabled = false;
          forgot.style.opacity = "";
          forgot.style.cursor = "";
        }
      }
    });

    // Delegate auth form submission
    document.addEventListener("submit", async function (event) {
      var form = event.target.closest("[data-auth-form]");
      if (form) {
        event.preventDefault();
        var endpoint = state.authMode === "login" ? "/api/auth/login" : "/api/auth/register";
        var body = {
          email: form.elements.email.value.trim(),
          password: form.elements.password.value,
        };
        if (state.authMode === "register") body.username = form.elements.username.value.trim();
        if (state.authMode === "login") body.remember = form.elements.remember ? form.elements.remember.checked : true;
        setAuthError("");
        setAuthNote("");
        try {
          var payload = await api(endpoint, {
            method: "POST",
            body: JSON.stringify(body),
          });
          state.authenticated = true;
          state.user = payload;
          hideAuthPanel();
          renderTopbarUser(payload);
          loadNotifications();
          refreshActivePageAfterAuth();
        } catch (error) {
          setAuthError(error.error || "The temple doors did not open.");
        }
      }
    });
  }

  async function refreshSession() {
    try {
      var payload = await api("/api/auth/session");
      state.authenticated = !!payload.authenticated;
      state.user = payload.user || null;
      renderTopbarUser(state.user);
      if (state.authenticated) {
        loadNotifications();
      }
    } catch {
      state.authenticated = false;
      renderTopbarUser(null);
    }
  }

  function renderTopbarUser(user) {
    var userNode = document.querySelector("[data-topbar-user]");
    var xpNode = document.querySelector("[data-xp-pill]");
    var notifNode = document.querySelector("[data-notif-wrapper]");
    var open = document.querySelector("[data-auth-open]");
    if (user && state.authenticated) {
      if (userNode) {
        userNode.textContent = user.username;
        userNode.hidden = false;
      }
      if (xpNode) {
        xpNode.textContent = formatNumber(user.total_xp || 0) + " xp";
        xpNode.hidden = false;
      }
      if (notifNode) {
        notifNode.hidden = false;
      }
      if (open) open.hidden = true;
    } else {
      if (userNode) userNode.hidden = true;
      if (xpNode) xpNode.hidden = true;
      if (notifNode) notifNode.hidden = true;
      if (open) open.hidden = false;
    }
  }

  async function loadFeedbackNotifications() {
    var dialog = document.querySelector("[data-feedback-notice-dialog]");
    var list = document.querySelector("[data-feedback-notice-list]");
    if (!dialog || !list) return;
    try {
      var data = await api("/api/feedback-notifications");
      var items = data.items || [];
      if (!items.length) return;
      dialog.dataset.notificationIds = items.map(function (item) { return item.id; }).join(",");
      list.innerHTML = items.map(renderFeedbackNotification).join("");
      dialog.addEventListener("close", markFeedbackNotificationsRead, { once: true });
      showDialogWhenClear(dialog, 700);
    } catch {}
  }

  function renderFeedbackNotification(item) {
    var action = item.action === "deleted" ? "deleted from the live bank" : "kept in practice";
    var stem = item.stem ? "<p class=\"feedback-notice-question\">" + formatInlineScienceHtml(item.stem) + "</p>" : "";
    var leadIn = item.lead_in ? "<p class=\"feedback-notice-question feedback-notice-question--lead\">" + formatInlineScienceHtml(item.lead_in) + "</p>" : "";
    var reply = "<p>Your report was reviewed.</p>"
      + (item.admin_reply ? "<p class=\"feedback-notice-reply\"><strong>" + escapeHtml(item.admin_reply) + "</strong></p>" : "");
    var source = item.source_anchor ? "<small>Source: " + escapeHtml(item.source_anchor) + "</small>" : "";
    return "<article class=\"feedback-notice-item\">"
      + "<strong>" + escapeHtml(item.question_id) + " was " + action + "</strong>"
      + stem
      + leadIn
      + reply
      + source
      + "</article>";
  }

  async function markFeedbackNotificationsRead() {
    var dialog = document.querySelector("[data-feedback-notice-dialog]");
    if (!dialog || !dialog.dataset.notificationIds) return;
    var ids = dialog.dataset.notificationIds.split(",").map(function (value) {
      return Number(value);
    }).filter(Boolean);
    dialog.dataset.notificationIds = "";
    if (!ids.length) return;
    try {
      await api("/api/feedback-notifications/read", {
        method: "POST",
        body: JSON.stringify({ ids: ids }),
      });
    } catch {}
  }

  async function loadAppNotifications() {
    if (!featureEnabled("app_notifications")) return;
    var dialog = document.querySelector("[data-app-notification-dialog]");
    if (!dialog) return;
    try {
      var data = await api("/api/notifications");
      var items = data.items || [];
      if (!items.length) return;
      showAppNotification(items[0]);
    } catch {}
  }

  function showAppNotification(item) {
    var dialog = document.querySelector("[data-app-notification-dialog]");
    if (!dialog || !item) return;
    dialog.dataset.notificationId = item.id;
    dialog.dataset.notificationKind = item.kind || "announcement";
    setText("[data-app-notification-title]", item.title || "Aesculon notice");
    setText("[data-app-notification-message]", item.message || "");
    var yes = document.querySelector("[data-app-notification-yes]");
    var no = document.querySelector("[data-app-notification-no]");
    var dismiss = document.querySelector("[data-app-notification-dismiss]");
    var isPoll = item.kind === "poll";
    if (yes) {
      yes.textContent = item.yes_label || "Yes";
      yes.classList.toggle("hidden", !isPoll);
      bindAppNotificationButton(yes, "yes");
    }
    if (no) {
      no.textContent = item.no_label || "No";
      no.classList.toggle("hidden", !isPoll);
      bindAppNotificationButton(no, "no");
    }
    if (dismiss) {
      dismiss.textContent = isPoll ? "Dismiss" : "Done";
      bindAppNotificationButton(dismiss, "dismissed");
    }
    showDialogWhenClear(dialog, 900);
  }

  function bindAppNotificationButton(button, response) {
    if (!button || button.dataset.notificationResponse === response) return;
    button.dataset.notificationResponse = response;
    button.addEventListener("click", function () {
      submitAppNotificationResponse(response);
    });
  }

  async function submitAppNotificationResponse(response) {
    var dialog = document.querySelector("[data-app-notification-dialog]");
    var id = dialog ? Number(dialog.dataset.notificationId || 0) : 0;
    if (!dialog || !id) return;
    closeDialog(dialog);
    try {
      await api("/api/notifications/" + encodeURIComponent(id) + "/respond", {
        method: "POST",
        body: JSON.stringify({ response: response }),
      });
      window.setTimeout(loadNotifications, 400);
    } catch {}
  }

  // Memory cache of active notifications
  var activeNotifications = {
    announcements: [],
    feedback: []
  };

  async function loadNotifications() {
    var notifWrapper = document.querySelector("[data-notif-wrapper]");
    if (!notifWrapper || notifWrapper.hidden) return;

    try {
      var promises = [api("/api/feedback-notifications")];
      if (featureEnabled("app_notifications")) {
        promises.push(api("/api/notifications"));
      }

      var results = await Promise.all(promises);
      
      activeNotifications.feedback = results[0] ? (results[0].items || []) : [];
      activeNotifications.announcements = results[1] ? (results[1].items || []) : [];

      renderNotificationsList();
    } catch (error) {
      console.error("Error loading notifications:", error);
    }
  }

  function renderNotificationsList() {
    var listContainer = document.querySelector("[data-notif-list]");
    var badgeNode = document.querySelector("[data-notif-badge]");
    var emptyNode = document.querySelector("[data-notif-empty]");
    var readAllBtn = document.querySelector("[data-notif-read-all]");
    if (!listContainer) return;

    var combined = [];
    
    // Add feedback items
    activeNotifications.feedback.forEach(function (item) {
      combined.push({
        id: item.id,
        type: "feedback",
        title: "Report Reviewed",
        desc: item.question_id + " was " + (item.action === "deleted" ? "deleted" : "kept") + ".",
        time: item.created_at || "",
        item: item
      });
    });

    // Add announcement/poll items
    activeNotifications.announcements.forEach(function (item) {
      combined.push({
        id: item.id,
        type: item.kind || "announcement",
        title: item.title || "Announcement",
        desc: item.message || "",
        time: item.created_at || "",
        item: item
      });
    });

    // Sort by time (latest first)
    combined.sort(function (a, b) {
      var dateA = new Date(a.time || 0);
      var dateB = new Date(b.time || 0);
      return dateB - dateA;
    });

    var totalUnread = combined.length;

    // Update badge count
    if (badgeNode) {
      if (totalUnread > 0) {
        badgeNode.textContent = totalUnread;
        badgeNode.classList.remove("hidden");
      } else {
        badgeNode.classList.add("hidden");
      }
    }

    if (totalUnread === 0) {
      listContainer.innerHTML = "";
      if (emptyNode) emptyNode.classList.remove("hidden");
      if (readAllBtn) readAllBtn.classList.add("hidden");
    } else {
      if (emptyNode) emptyNode.classList.add("hidden");
      if (readAllBtn) readAllBtn.classList.remove("hidden");
      
      listContainer.innerHTML = combined.map(function (notif) {
        var timeStr = formatNotifTime(notif.time);
        var tag = notif.type === "poll" ? "Poll" : notif.type === "feedback" ? "Feedback" : "Notice";
        
        return '<article class="notif-item notif-item--unread" data-notif-type="' + notif.type + '" data-notif-id="' + notif.id + '">' +
          '<div class="notif-item__title">' + escapeHtml(notif.title) + '</div>' +
          '<div class="notif-item__desc">' + escapeHtml(notif.desc) + '</div>' +
          '<div class="notif-item__meta">' +
            '<span class="notif-item__tag">' + tag + '</span>' +
            '<span class="notif-item__time">' + timeStr + '</span>' +
          '</div>' +
        '</article>';
      }).join("");

      // Bind click event to each item
      listContainer.querySelectorAll(".notif-item").forEach(function (itemNode) {
        itemNode.addEventListener("click", function () {
          var id = Number(itemNode.dataset.notifId);
          var type = itemNode.dataset.notifType;
          handleNotifClick(type, id);
        });
      });
    }
  }

  function formatNotifTime(timeStr) {
    if (!timeStr) return "";
    var date = new Date(timeStr);
    if (isNaN(date.getTime())) return timeStr;
    var now = new Date();
    var diffMs = now - date;
    var diffMins = Math.floor(diffMs / 60000);
    var diffHours = Math.floor(diffMins / 60);
    var diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return diffMins + "m ago";
    if (diffHours < 24) return diffHours + "h ago";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return diffDays + "d ago";
    
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function handleNotifClick(type, id) {
    var dropdown = document.querySelector("[data-notif-dropdown]");
    if (dropdown) dropdown.classList.add("hidden");

    if (type === "feedback") {
      var found = activeNotifications.feedback.find(function (x) { return x.id === id; });
      if (found) {
        showSingleFeedbackNotification(found);
      }
    } else {
      var found = activeNotifications.announcements.find(function (x) { return x.id === id; });
      if (found) {
        showAppNotification(found);
      }
    }
  }

  function showSingleFeedbackNotification(item) {
    var dialog = document.querySelector("[data-feedback-notice-dialog]");
    var list = document.querySelector("[data-feedback-notice-list]");
    if (!dialog || !list || !item) return;
    dialog.dataset.notificationIds = item.id;
    list.innerHTML = renderFeedbackNotification(item);
    
    dialog.addEventListener("close", async function () {
      try {
        await api("/api/feedback-notifications/read", {
          method: "POST",
          body: JSON.stringify({ ids: [item.id] }),
        });
        loadNotifications();
      } catch {}
    }, { once: true });
    
    showDialogWhenClear(dialog, 0);
  }

  async function markAllNotificationsRead() {
    var promises = [];

    // Mark feedback read
    if (activeNotifications.feedback.length > 0) {
      var feedbackIds = activeNotifications.feedback.map(function (x) { return x.id; });
      promises.push(api("/api/feedback-notifications/read", {
        method: "POST",
        body: JSON.stringify({ ids: feedbackIds }),
      }));
    }

    // Mark announcements dismissed
    activeNotifications.announcements.forEach(function (notif) {
      promises.push(api("/api/notifications/" + encodeURIComponent(notif.id) + "/respond", {
        method: "POST",
        body: JSON.stringify({ response: "dismissed" }),
      }));
    });

    try {
      await Promise.all(promises);
      await loadNotifications();
    } catch (error) {
      console.error("Error marking all notifications as read:", error);
    }
  }

  function initNotifications() {
    var toggleBtn = document.querySelector("[data-notif-toggle]");
    var dropdown = document.querySelector("[data-notif-dropdown]");
    var readAllBtn = document.querySelector("[data-notif-read-all]");
    
    if (toggleBtn && dropdown && !toggleBtn.dataset.bound) {
      toggleBtn.dataset.bound = "true";
      toggleBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        dropdown.classList.toggle("hidden");
        if (!dropdown.classList.contains("hidden")) {
          loadNotifications();
        }
      });
      
      document.addEventListener("click", function (event) {
        if (!dropdown.classList.contains("hidden") && !dropdown.contains(event.target) && event.target !== toggleBtn && !toggleBtn.contains(event.target)) {
          dropdown.classList.add("hidden");
        }
      });
    }

    if (readAllBtn && !readAllBtn.dataset.bound) {
      readAllBtn.dataset.bound = "true";
      readAllBtn.addEventListener("click", markAllNotificationsRead);
    }
  }

  function initSiteFeedback() {
    var open = document.querySelector("[data-site-feedback-open]");
    var dialog = document.querySelector("[data-site-feedback-dialog]");
    var form = document.querySelector("[data-site-feedback-form]");
    var cancel = document.querySelector("[data-site-feedback-cancel]");
    if (open && dialog && !open.dataset.bound) {
      open.dataset.bound = "true";
      open.addEventListener("click", function () {
        resetSiteFeedbackState(false);
        showDialogWhenClear(dialog, 0);
      });
    }
    if (cancel && dialog && !cancel.dataset.bound) {
      cancel.dataset.bound = "true";
      cancel.addEventListener("click", function () {
        closeDialog(dialog);
      });
    }
    if (form && !form.dataset.bound) {
      form.dataset.bound = "true";
      form.addEventListener("submit", submitSiteFeedback);
    }
  }

  async function loadPatchNotes() {
    var dialog = document.querySelector("[data-patch-notes-dialog]");
    if (!dialog) return;
    try {
      var data = await api("/api/patch-notes");
      if (data && data.note) {
        var note = data.note;
        var kicker = dialog.querySelector(".page-kicker");
        if (kicker) kicker.textContent = "Updates (" + (note.version || "") + ")";
        
        var title = dialog.querySelector("h2");
        if (title) title.textContent = note.title || "Aesculon Patch Notes";
        
        var list = dialog.querySelector(".version-dialog__list");
        if (list) {
          var lines = (note.content || "").split("\n");
          list.innerHTML = lines.map(function (line) {
            line = line.trim();
            if (!line) return "";
            var parts = line.split(":", 2);
            if (parts.length === 2 && parts[0].length < 40) {
              return "<li style=\"margin-bottom: var(--space-2);\"><strong>" + escapeHtml(parts[0].trim()) + "</strong>: " + escapeHtml(parts[1].trim()) + "</li>";
            }
            return "<li style=\"margin-bottom: var(--space-2);\">" + escapeHtml(line) + "</li>";
          }).join("");
        }
      }
    } catch (error) {
      console.warn("Failed to load patch notes:", error);
    }
  }

  function initPatchNotes() {
    var open = document.querySelector("[data-patch-notes-open]");
    var dialog = document.querySelector("[data-patch-notes-dialog]");
    var close = document.querySelector("[data-patch-notes-dismiss]");
    if (open && dialog && !open.dataset.bound) {
      open.dataset.bound = "true";
      open.addEventListener("click", async function () {
        await loadPatchNotes();
        showDialogWhenClear(dialog, 0);
      });
    }
    if (close && dialog && !close.dataset.bound) {
      close.dataset.bound = "true";
      close.addEventListener("click", function (event) {
        event.preventDefault();
        closeDialog(dialog);
      });
    }
    if (dialog && !dialog.dataset.clickBound) {
      dialog.dataset.clickBound = "true";
      dialog.addEventListener("click", function (event) {
        var rect = dialog.getBoundingClientRect();
        var isInDialog = (rect.top <= event.clientY && event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX && event.clientX <= rect.left + rect.width);
        if (!isInDialog) {
          closeDialog(dialog);
        }
      });
    }
  }

  async function submitSiteFeedback(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var submit = document.querySelector("[data-site-feedback-submit]");
    var message = form.querySelector("textarea[name=\"message\"]");
    var category = form.querySelector("select[name=\"category\"]");
    var text = String(message && message.value || "").trim();
    if (!text) {
      showSiteFeedbackError("Write a short note before sending feedback.");
      return;
    }
    if (submit) submit.disabled = true;
    showSiteFeedbackError("");
    showSiteFeedbackNote("");
    try {
      var data = await api("/api/site-feedback", {
        method: "POST",
        body: JSON.stringify({
          category: category ? category.value : "general",
          message: text,
          page_path: window.location.pathname + window.location.search,
        }),
      });
      if (message) message.value = "";
      showSiteFeedbackNote(data.message || "Feedback sent. Thank you.");
      window.setTimeout(function () {
        closeDialog(document.querySelector("[data-site-feedback-dialog]"));
        resetSiteFeedbackState(true);
      }, 900);
    } catch (error) {
      showSiteFeedbackError(error && error.error ? error.error : "Feedback could not be sent.");
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function resetSiteFeedbackState(keepFormValues) {
    showSiteFeedbackError("");
    showSiteFeedbackNote("");
    if (!keepFormValues) return;
    var form = document.querySelector("[data-site-feedback-form]");
    if (form) form.reset();
  }

  function showSiteFeedbackError(message) {
    var node = document.querySelector("[data-site-feedback-error]");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("hidden", !message);
  }

  function showSiteFeedbackNote(message) {
    var node = document.querySelector("[data-site-feedback-note]");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("hidden", !message);
  }

  function initFocusPlayer() {
    var root = document.querySelector("[data-focus-player]");
    var toggle = document.querySelector("[data-focus-player-toggle]");
    var panel = document.querySelector("[data-focus-player-panel]");
    var close = document.querySelector("[data-focus-player-close]");
    var form = document.querySelector("[data-focus-player-form]");
    var input = form ? form.elements.youtube_url : null;
    var clear = document.querySelector("[data-focus-player-clear]");
    var play = document.querySelector("[data-focus-player-play]");
    var next = document.querySelector("[data-focus-player-next]");
    var progress = document.querySelector("[data-focus-player-progress]");
    var volume = document.querySelector("[data-focus-player-volume]");
    if (!root || !toggle || !panel || !form || !input) return;
    if (root.dataset.bound) {
      reattachFocusPlayer();
      refreshFocusPlayerControls();
      return;
    }
    root.dataset.bound = "true";

    var stored = "";
    try {
      stored = localStorage.getItem(FOCUS_PLAYER_URL_KEY) || "";
    } catch {}
    if (stored) {
      input.value = stored;
      state.focusResumeState = readFocusPlayerState(stored);
      setFocusPlayerEmbed(stored, false, shouldAutoplayFocusRestore(state.focusResumeState));
    }

    toggle.addEventListener("click", function () {
      if (panel.classList.contains("open")) {
        closeFocusPlayerPanel();
      } else {
        openFocusPlayerPanel();
      }
    });
    if (close) {
      close.addEventListener("click", function () {
        closeFocusPlayerPanel();
        window.setTimeout(function () { toggle.focus(); }, 180);
      });
    }
    if (clear) {
      clear.addEventListener("click", function () {
        input.value = "";
        clearFocusPlayerEmbed();
        try {
          localStorage.removeItem(FOCUS_PLAYER_URL_KEY);
          localStorage.removeItem(FOCUS_PLAYER_STATE_KEY);
        } catch {}
      });
    }
    if (play) play.addEventListener("click", toggleFocusPlayback);
    if (next) next.addEventListener("click", nextFocusTrack);
    if (progress) {
      progress.addEventListener("input", function () {
        seekFocusPlayer(Number(progress.value || 0));
      });
    }
    if (volume) {
      volume.addEventListener("input", function () {
        setFocusVolume(Number(volume.value || 0));
      });
    }
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (setFocusPlayerEmbed(input.value, true, true)) {
        try {
          localStorage.setItem(FOCUS_PLAYER_URL_KEY, input.value.trim());
        } catch {}
      }
    });
  }

  function setFocusPlayerEmbed(value, showErrors, autoplay) {
    var media = youtubeMediaFromUrl(value);
    var error = document.querySelector("[data-focus-player-error]");
    if (error) {
      error.classList.add("hidden");
      error.textContent = "";
    }
    if (!media) {
      clearFocusPlayerEmbed();
      if (showErrors && error) {
        error.textContent = "Paste a public YouTube playlist, YouTube Music playlist, or video link.";
        error.classList.remove("hidden");
      }
      return false;
    }
    var wrap = document.querySelector("[data-focus-player-embed-wrap]");
    if (wrap) wrap.classList.remove("hidden");
    state.focusPendingMedia = media;
    state.focusPendingAutoplay = !!autoplay;
    loadYouTubeApi().then(function () {
      createOrLoadFocusPlayer(media);
    }).catch(function () {
      if (error) {
        error.textContent = "YouTube could not be loaded in this browser.";
        error.classList.remove("hidden");
      }
    });
    showFocusPlayerStrip(true);
    return true;
  }

  function clearFocusPlayerEmbed() {
    var wrap = document.querySelector("[data-focus-player-embed-wrap]");
    if (state.focusPlayer && state.focusPlayer.destroy) {
      state.focusPlayer.destroy();
    }
    if (wrap && !wrap.querySelector("[data-focus-player-embed]")) {
      wrap.innerHTML = "<div id=\"focus-player-embed\" data-focus-player-embed></div>";
    }
    state.focusPlayer = null;
    window.aesculonFocusPlayer = null;
    window.aesculonFocusReady = false;
    state.focusReady = false;
    state.focusPendingMedia = null;
    state.focusPendingAutoplay = false;
    state.focusResumeState = null;
    stopFocusProgressTimer();
    setFocusTitle("Study Hall");
    updateFocusProgress(0);
    updateFocusTime(0, 0);
    updateFocusPlaying(false);
    showFocusPlayerStrip(false);
    if (wrap) wrap.classList.add("hidden");
  }

  function youtubeMediaFromUrl(value) {
    var raw = String(value || "").trim();
    if (!raw) return null;
    var url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    var host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
    var allowed = host === "youtube.com" || host === "music.youtube.com" || host === "youtu.be";
    if (!allowed) return null;
    var list = url.searchParams.get("list");
    if (list && /^[A-Za-z0-9_-]+$/.test(list)) {
      return { type: "playlist", listId: list };
    }
    var videoId = "";
    if (host === "youtu.be") {
      videoId = url.pathname.split("/").filter(Boolean)[0] || "";
    } else if (url.pathname === "/watch") {
      videoId = url.searchParams.get("v") || "";
    } else if (url.pathname.startsWith("/embed/")) {
      videoId = url.pathname.split("/").filter(Boolean)[1] || "";
    } else if (url.pathname.startsWith("/shorts/")) {
      videoId = url.pathname.split("/").filter(Boolean)[1] || "";
    }
    if (videoId && /^[A-Za-z0-9_-]{6,}$/.test(videoId)) {
      return { type: "video", videoId: videoId };
    }
    return null;
  }

  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (window.aesculonYouTubeApiPromise) return window.aesculonYouTubeApiPromise;
    window.aesculonYouTubeApiPromise = new Promise(function (resolve, reject) {
      var previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof previous === "function") previous();
        resolve();
      };
      var script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    return window.aesculonYouTubeApiPromise;
  }

  function createOrLoadFocusPlayer(media) {
    if (!window.YT || !window.YT.Player || !media) return;
    if (state.focusPlayer && state.focusReady) {
      loadFocusMedia(media, state.focusPendingAutoplay);
      return;
    }
    state.focusPlayer = new window.YT.Player("focus-player-embed", {
      height: "203",
      width: "360",
      host: "https://www.youtube-nocookie.com",
      playerVars: {
        playsinline: 1,
        autoplay: 0,
        rel: 0,
        modestbranding: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: function (event) {
          state.focusReady = true;
          window.aesculonFocusPlayer = event.target;
          window.aesculonFocusReady = true;
          var volume = document.querySelector("[data-focus-player-volume]");
          event.target.setVolume(Number(volume && volume.value || 70));
          loadFocusMedia(state.focusPendingMedia || media, state.focusPendingAutoplay);
          startFocusProgressTimer();
        },
        onStateChange: function (event) {
          updateFocusPlaying(event.data === window.YT.PlayerState.PLAYING);
          setFocusTitleFromPlayer();
          if (event.data === window.YT.PlayerState.PLAYING) startFocusProgressTimer();
          persistFocusPlayerState();
        },
      },
    });
    window.aesculonFocusPlayer = state.focusPlayer;
  }

  function loadFocusMedia(media, autoplay) {
    if (!state.focusPlayer || !state.focusReady || !media) return;
    autoplay = !!autoplay;
    var resume = state.focusResumeState;
    var resumeIndex = resume && Number.isFinite(Number(resume.index)) ? Math.max(0, Number(resume.index)) : 0;
    if (media.type === "playlist") {
      if (autoplay) {
        state.focusPlayer.loadPlaylist({ listType: "playlist", list: media.listId, index: resumeIndex });
      } else {
        state.focusPlayer.cuePlaylist({ listType: "playlist", list: media.listId, index: resumeIndex });
      }
    } else {
      if (autoplay) {
        state.focusPlayer.loadVideoById(media.videoId);
      } else {
        state.focusPlayer.cueVideoById(media.videoId);
      }
    }
    window.setTimeout(function () {
      setFocusTitleFromPlayer();
      restoreFocusPlayerTime(resume);
      if (autoplay && state.focusPlayer && state.focusPlayer.playVideo) state.focusPlayer.playVideo();
      state.focusResumeState = null;
    }, 600);
  }

  function toggleFocusPlayback() {
    if (!state.focusPlayer || !state.focusReady) {
      openFocusPlayerPanel();
      return;
    }
    var playing = state.focusPlayer.getPlayerState && state.focusPlayer.getPlayerState() === window.YT.PlayerState.PLAYING;
    if (playing) {
      state.focusPlayer.pauseVideo();
      updateFocusPlaying(false);
    } else {
      state.focusPlayer.playVideo();
      updateFocusPlaying(true);
    }
    window.setTimeout(persistFocusPlayerState, 250);
  }

  function reattachFocusPlayer() {
    if (!state.focusPlayer && window.aesculonFocusPlayer) {
      state.focusPlayer = window.aesculonFocusPlayer;
      state.focusReady = !!window.aesculonFocusReady;
    }
  }

  function refreshFocusPlayerControls() {
    reattachFocusPlayer();
    var stored = "";
    try {
      stored = localStorage.getItem(FOCUS_PLAYER_URL_KEY) || "";
    } catch {}
    showFocusPlayerStrip(!!stored || !!state.focusPlayer);
    if (!state.focusPlayer || !state.focusReady) return;
    var playerState = state.focusPlayer.getPlayerState ? state.focusPlayer.getPlayerState() : null;
    updateFocusPlaying(!!(window.YT && playerState === window.YT.PlayerState.PLAYING));
    setFocusTitleFromPlayer();
    if (state.focusPlayer.getDuration) {
      var duration = Number(state.focusPlayer.getDuration() || 0);
      var current = Number(state.focusPlayer.getCurrentTime ? state.focusPlayer.getCurrentTime() : 0);
      updateFocusProgress(duration ? (current / duration) * 100 : 0);
      updateFocusTime(current, duration);
    }
    startFocusProgressTimer();
  }

  function nextFocusTrack() {
    if (!state.focusPlayer || !state.focusReady) {
      openFocusPlayerPanel();
      return;
    }
    if (state.focusPlayer.nextVideo) state.focusPlayer.nextVideo();
    window.setTimeout(function () {
      setFocusTitleFromPlayer();
      if (state.focusPlayer && state.focusPlayer.playVideo) state.focusPlayer.playVideo();
      persistFocusPlayerState();
    }, 700);
  }

  function seekFocusPlayer(percent) {
    if (!state.focusPlayer || !state.focusReady || !state.focusPlayer.getDuration) return;
    var duration = Number(state.focusPlayer.getDuration() || 0);
    if (!duration) return;
    state.focusPlayer.seekTo(duration * Math.max(0, Math.min(100, percent)) / 100, true);
    window.setTimeout(persistFocusPlayerState, 250);
  }

  function setFocusVolume(value) {
    if (!state.focusPlayer || !state.focusReady || !state.focusPlayer.setVolume) return;
    state.focusPlayer.setVolume(Math.max(0, Math.min(100, value)));
  }

  function readFocusPlayerState(url) {
    try {
      var saved = JSON.parse(localStorage.getItem(FOCUS_PLAYER_STATE_KEY) || "{}");
      if (!saved || saved.url !== String(url || "").trim()) return null;
      return saved;
    } catch {
      return null;
    }
  }

  function shouldAutoplayFocusRestore(saved) {
    if (!saved || !saved.playing || isReloadNavigation()) return false;
    return Date.now() - Number(saved.updatedAt || 0) < 30000;
  }

  function isReloadNavigation() {
    try {
      var nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
      return nav && nav.type === "reload";
    } catch {
      return false;
    }
  }

  function restoreFocusPlayerTime(saved) {
    if (!saved || !state.focusPlayer || !state.focusReady || !state.focusPlayer.seekTo) return;
    var current = Number(saved.currentTime || 0);
    var duration = Number(saved.duration || 0);
    if (current < 2 || (duration && current >= duration - 2)) return;
    try {
      state.focusPlayer.seekTo(current, true);
      updateFocusProgress(duration ? (current / duration) * 100 : 0);
      updateFocusTime(current, duration);
    } catch {}
  }

  function persistFocusPlayerState() {
    if (!state.focusPlayer || !state.focusReady || !state.focusPlayer.getCurrentTime) return;
    var stored = "";
    try {
      stored = localStorage.getItem(FOCUS_PLAYER_URL_KEY) || "";
    } catch {}
    if (!stored) return;
    var playerState = state.focusPlayer.getPlayerState ? state.focusPlayer.getPlayerState() : null;
    var data = state.focusPlayer.getVideoData ? state.focusPlayer.getVideoData() : {};
    var payload = {
      url: stored,
      updatedAt: Date.now(),
      currentTime: Number(state.focusPlayer.getCurrentTime ? state.focusPlayer.getCurrentTime() : 0),
      duration: Number(state.focusPlayer.getDuration ? state.focusPlayer.getDuration() : 0),
      index: Number(state.focusPlayer.getPlaylistIndex ? state.focusPlayer.getPlaylistIndex() : 0),
      videoId: data && data.video_id ? data.video_id : "",
      title: data && data.title ? data.title : "",
      playing: !!(window.YT && playerState === window.YT.PlayerState.PLAYING),
    };
    try {
      localStorage.setItem(FOCUS_PLAYER_STATE_KEY, JSON.stringify(payload));
    } catch {}
  }

  function persistFocusPlayerStateThrottled() {
    var now = Date.now();
    if (now - state.focusLastPersistedAt < 2000) return;
    state.focusLastPersistedAt = now;
    persistFocusPlayerState();
  }

  function startFocusProgressTimer() {
    if (state.focusProgressTimer) return;
    state.focusProgressTimer = window.setInterval(function () {
      if (!state.focusPlayer || !state.focusReady || !state.focusPlayer.getDuration) return;
      var duration = Number(state.focusPlayer.getDuration() || 0);
      var current = Number(state.focusPlayer.getCurrentTime ? state.focusPlayer.getCurrentTime() : 0);
      updateFocusProgress(duration ? (current / duration) * 100 : 0);
      updateFocusTime(current, duration);
      setFocusTitleFromPlayer();
      persistFocusPlayerStateThrottled();
    }, 600);
  }

  function stopFocusProgressTimer() {
    if (!state.focusProgressTimer) return;
    window.clearInterval(state.focusProgressTimer);
    state.focusProgressTimer = null;
  }

  function updateFocusProgress(percent) {
    var progress = document.querySelector("[data-focus-player-progress]");
    if (progress && document.activeElement !== progress) {
      progress.value = Math.max(0, Math.min(100, percent));
    }
  }

  function updateFocusPlaying(playing) {
    var button = document.querySelector("[data-focus-player-play]");
    if (!button) return;
    button.classList.toggle("playing", !!playing);
    button.setAttribute("aria-label", playing ? "Pause focus music" : "Play focus music");
  }

  function setFocusTitleFromPlayer() {
    if (!state.focusPlayer || !state.focusPlayer.getVideoData) return;
    var data = state.focusPlayer.getVideoData();
    setFocusTitle(data && data.title ? data.title : "Study Hall");
  }

  function setFocusTitle(value) {
    setText("[data-focus-player-title]", value || "Study Hall");
  }

  function updateFocusTime(current, duration) {
    setText("[data-focus-player-time]", formatFocusTime(current) + "/" + formatFocusTime(duration));
  }

  function formatFocusTime(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds) || 0));
    var minutes = Math.floor(total / 60);
    var remaining = total % 60;
    return String(minutes) + ":" + String(remaining).padStart(2, "0");
  }

  function showFocusPlayerStrip(show) {
    var strip = document.querySelector("[data-focus-player-strip]");
    if (strip) strip.classList.toggle("hidden", !show);
  }

  function openFocusPlayerPanel() {
    var panel = document.querySelector("[data-focus-player-panel]");
    var toggle = document.querySelector("[data-focus-player-toggle]");
    var input = document.querySelector("[data-focus-player-form] input[name=\"youtube_url\"]");
    if (!panel) return;
    panel.classList.remove("hidden", "closing");
    window.requestAnimationFrame(function () {
      panel.classList.add("open");
    });
    if (toggle) toggle.setAttribute("aria-expanded", "true");
    if (input) window.setTimeout(function () { input.focus(); }, 80);
  }

  function closeFocusPlayerPanel() {
    var panel = document.querySelector("[data-focus-player-panel]");
    var toggle = document.querySelector("[data-focus-player-toggle]");
    if (!panel || (!panel.classList.contains("open") && panel.classList.contains("hidden"))) return;
    panel.classList.remove("open");
    panel.classList.add("closing");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
    window.setTimeout(function () {
      panel.classList.remove("closing");
    }, 190);
  }

  function showAuthPanel(mode) {
    state.authMode = mode || "register";
    var panel = document.querySelector("[data-auth-panel]");
    var username = document.querySelector("[data-register-only]");
    var remember = document.querySelector("[data-login-only]");
    var copy = document.querySelector("[data-auth-copy]");
    var submit = document.querySelector("[data-auth-submit]");
    var forgot = document.querySelector("[data-auth-forgot]");
    var isRegister = state.authMode === "register";
    if (panel) panel.classList.remove("hidden");
    document.querySelectorAll("[data-auth-mode]").forEach(function (button) {
      button.classList.toggle("active", button.dataset.authMode === state.authMode);
    });
    if (username) {
      username.hidden = !isRegister;
      username.required = isRegister;
    }
    if (remember) remember.classList.toggle("hidden", isRegister);
    if (copy) copy.textContent = isRegister ? "Create an account to save XP, streaks, and review scheduling." : "Login to return to your saved practice record.";
    if (submit) submit.textContent = isRegister ? "Create account" : "Login";
    if (forgot) forgot.classList.toggle("hidden", isRegister);
    setAuthError("");
    setAuthNote("");
  }

  function hideAuthPanel() {
    var panel = document.querySelector("[data-auth-panel]");
    if (panel) panel.classList.add("hidden");
  }

  function setAuthError(message) {
    var node = document.querySelector("[data-auth-error]");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("hidden", !message);
  }

  function setAuthNote(message) {
    var node = document.querySelector("[data-auth-note]");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("hidden", !message);
  }

  function initPage() {
    var page = document.body.dataset.page;
    if (page === "stoa") initDashboard();
    if (page === "practice") initAgora();
    if (page === "progress_page") initProgress();
    if (page === "leaderboard_page") initLeaderboard();
    if (page === "admin_page") initAdmin();
    if (page === "admin_activity_page") initAdminActivity();
    if (page === "question_feedback_page") initQuestionFeedbackAdmin();
    if (page === "question_bank_page") initQuestionBankAdmin();
    if (page === "duel_page") initDuel();
    if (page === "exam_page") initExam();
    if (page === "reset_password_page") initResetPassword();
  }

  function initResetPassword() {
    var form = document.querySelector("[data-reset-form]");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "true";
    var errorNode = document.querySelector("[data-reset-error]");
    var noteNode = document.querySelector("[data-reset-note]");
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (errorNode) errorNode.classList.add("hidden");
      if (noteNode) noteNode.classList.add("hidden");
      var password = form.elements.password.value;
      var confirm = form.elements.confirm_password.value;
      if (password !== confirm) {
        if (errorNode) {
          errorNode.textContent = "The passwords do not match.";
          errorNode.classList.remove("hidden");
        }
        return;
      }
      try {
        await api("/api/auth/reset-password", {
          method: "POST",
          body: JSON.stringify({ token: form.elements.token.value, password: password }),
        });
        if (noteNode) {
          noteNode.textContent = "Password reset. Returning you to practice...";
          noteNode.classList.remove("hidden");
        }
        setTimeout(function () {
          navigateTo("/practice");
        }, 900);
      } catch (error) {
        if (errorNode) {
          errorNode.textContent = error.error || "That reset link could not be used.";
          errorNode.classList.remove("hidden");
        }
      }
    });
  }

  function refreshActivePageAfterAuth() {
    var page = document.body.dataset.page;
    if (page === "practice") loadQuestion(true);
    if (page === "stoa") initDashboard();
    if (page === "progress_page") initProgress();
    if (page === "duel_page") initDuel();
    if (page === "exam_page") initExam();
    if (page === "question_feedback_page") initQuestionFeedbackAdmin();
    if (page === "question_bank_page") initQuestionBankAdmin();
  }

  async function initDashboard() {
    var root = document.querySelector("[data-dashboard]");
    if (!root) return;
    try {
      var data = await api("/api/dashboard");
      var user = data.user;
      state.user = user;
      state.authenticated = true;
      renderTopbarUser(user);
      setText("[data-greeting-copy]", "Welcome back, " + user.username + ". Your quiet place before entering practice.");
      setText("[data-level-display]", user.level.display);
      setText("[data-total-xp]", formatNumber(user.total_xp));
      setText("[data-current-level]", user.level.roman);
      setText("[data-day-streak]", user.streak_days);
      setText("[data-questions-answered]", data.questions_answered);
      setText("[data-due-count]", data.due_count);
      setText("[data-next-due]", data.next_due_label || (data.next_due_date ? formatDate(data.next_due_date) : "None scheduled"));
      setText("[data-weakest-topic]", data.weakest_topic ? data.weakest_topic.label + " · " + data.weakest_topic.accuracy + "%" : "No attempts yet");
      setText("[data-progress-label]", user.level.title + " to " + user.level.next_title);
      setText("[data-xp-next]", user.level.next_message || (user.level.xp_to_next ? user.level.xp_to_next + " XP to next level" : "At the summit"));
      renderRankBadge(user.level);
      var progress = document.querySelector("[data-xp-fill]");
      if (progress) progress.style.width = user.level.progress + "%";
      renderQuestionProgress(data);
      renderLeaderPreview(data.leaderboard || []);
      renderDashboardRecommendation(data);
      renderCohortPulse(data.cohort_pulse || {});
      var auth = document.querySelector("[data-dashboard-auth]");
      if (auth) auth.classList.add("hidden");
    } catch {
      var prompt = document.querySelector("[data-dashboard-auth]");
      if (prompt) prompt.classList.remove("hidden");
    }
  }

  function renderLeaderPreview(rows) {
    var list = document.querySelector("[data-leader-preview]");
    if (!list) return;
    if (!rows.length) {
      list.innerHTML = "<li><span class=\"mono\">--</span><span>No names are recorded yet.</span><span>0 xp</span></li>";
      return;
    }
    list.innerHTML = rows
      .map(function (row) {
        return "<li><span class=\"mono\">" + row.rank + "</span><span>" + escapeHtml(row.username) + "<br><small class=\"muted\">" + escapeHtml(row.level_display) + "</small></span><span class=\"mono\">" + formatNumber(row.xp) + " xp</span></li>";
      })
      .join("");
  }

  function renderDashboardRecommendation(data) {
    var title = "Continue practice";
    var copy = "Enter the Agora and build the next layer of recall.";
    var href = "/practice";
    var action = "Start";
    if ((data.due_count || 0) > 0) {
      title = "Review " + data.due_count + " due " + plural(data.due_count, "question", "questions");
      copy = "The Oracle has questions ready before they fade.";
      href = "/practice?mode=due";
      action = "Review";
    } else if (data.weakest_topic && data.weakest_topic.label) {
      title = "Drill " + data.weakest_topic.label;
      copy = "Your lowest-accuracy topic is the best place to sharpen today.";
      href = "/practice?mode=incorrect&topic=" + encodeURIComponent(data.weakest_topic.label);
      action = "Drill";
    } else if (!(data.questions_answered || 0)) {
      title = "Answer your first question";
      copy = "Start broad, then Aesculon will find patterns worth reviewing.";
      href = "/practice";
      action = "Begin";
    }
    setText("[data-next-action-title]", title);
    setText("[data-next-action-copy]", copy);
    setLink("[data-next-action-link]", href, action);
  }

  function renderCohortPulse(pulse) {
    var root = document.querySelector("[data-cohort-pulse]");
    if (!root) return;
    var hasToday = Number(pulse.answered_today || 0) > 0;
    var active = hasToday ? Number(pulse.active_today || 0) : Number(pulse.active_week || 0);
    var answered = hasToday ? Number(pulse.answered_today || 0) : Number(pulse.answered_week || 0);
    var accuracy = hasToday ? Number(pulse.accuracy_today || 0) : Number(pulse.accuracy_week || 0);
    var title = hasToday ? "The Stoa is awake" : (pulse.answered_week ? "The Stoa is quiet today" : "The archive waits");
    var hardest = pulse.hardest_topic || null;
    var practiced = pulse.most_practiced_block || null;

    root.dataset.cohortStatus = pulse.status || "empty";
    setText("[data-cohort-pulse-title]", title);
    setText("[data-cohort-pulse-copy]", pulse.copy || "The archive is gathering today's signal.");
    setText("[data-cohort-active-label]", hasToday ? "Active today" : "Active this week");
    setText("[data-cohort-answered-label]", hasToday ? "Questions today" : "Questions this week");
    setText("[data-cohort-accuracy-label]", hasToday ? "Cohort accuracy" : "Weekly accuracy");
    setText("[data-cohort-active]", formatNumber(active));
    setText("[data-cohort-answered]", formatNumber(answered));
    setText("[data-cohort-accuracy]", (accuracy || 0) + "%");
    setText("[data-cohort-hardest]", hardest ? hardest.label + " · " + hardest.accuracy + "% across " + hardest.attempted + " " + plural(hardest.attempted, "attempt", "attempts") : "Awaiting attempts");
    setText("[data-cohort-practiced]", practiced ? practiced.label + " · " + practiced.attempted + " " + plural(practiced.attempted, "question", "questions") : "Awaiting attempts");

    var link = document.querySelector("[data-cohort-drill]");
    if (!link) return;
    if (hardest && hardest.label) {
      link.href = "/practice?topic=" + encodeURIComponent(hardest.label);
      link.classList.remove("hidden");
    } else {
      link.classList.add("hidden");
    }
  }

  async function initProgress() {
    try {
      var data = await api("/api/stats");
      setText("[data-stat-attempted]", data.summary.attempted);
      setText("[data-stat-correct]", data.summary.correct);
      setText("[data-stat-accuracy]", data.summary.accuracy + "%");
      setText("[data-stat-due]", data.summary.due_count);
      setText("[data-stat-completion]", data.summary.completion + "%");
      setText("[data-stat-time]", data.summary.avg_time + "s");
      setText("[data-next-review]", data.summary.next_due_label || "No review scheduled");
      renderQuestionProgress(data.summary);
      renderRows("[data-block-stats]", data.by_block || [], false);
      renderRows("[data-weak-topics]", data.weakest_topics || [], true);
      renderDueSoon(data.due_soon || []);
      renderRecentMistakes(data.recent_mistakes || []);
      renderRecentActivity(data.recent_activity || []);
      renderProgressRecommendation(data);
      renderXPChart(data.xp_history || []);
      renderRadarChart(data.by_block || []);
    } catch (error) {
      showAuthPanel("login");
    }
  }

  function renderProgressRecommendation(data) {
    var summary = data.summary || {};
    var weakest = (data.weakest_topics || [])[0];
    var title = "Continue practice";
    var copy = "A fresh mixed session will keep the archive moving.";
    var href = "/practice";
    var action = "Start";
    if ((summary.due_count || 0) > 0) {
      title = "Clear " + summary.due_count + " due " + plural(summary.due_count, "review", "reviews");
      copy = "Due questions are the highest-value work right now.";
      href = "/practice?mode=due";
      action = "Review";
    } else if (weakest && weakest.label) {
      title = "Repair " + weakest.label;
      copy = weakest.accuracy + "% accuracy across " + weakest.attempted + " attempts.";
      href = "/practice?mode=incorrect&topic=" + encodeURIComponent(weakest.label);
      action = "Drill";
    } else if (!(summary.attempted || 0)) {
      title = "Create your baseline";
      copy = "A short first session will unlock useful progress signals.";
      href = "/practice";
      action = "Begin";
    } else if ((summary.completion || 0) < 100) {
      title = "Find new questions";
      copy = summary.completion + "% of the bank has been seen.";
      href = "/practice";
      action = "Continue";
    }
    setText("[data-progress-action-title]", title);
    setText("[data-progress-action-copy]", copy);
    setLink("[data-progress-action-link]", href, action);
  }

  function renderRankBadge(level) {
    var badge = document.querySelector("[data-rank-badge]");
    if (!badge) return;
    var rank = Math.min(10, Math.max(1, Number(level && level.level ? level.level : 1)));
    badge.src = "/static/assets/aesculon/ranks/rank-" + rank + ".png";
    badge.title = level && level.display ? level.display : "";
  }

  function renderQuestionProgress(source) {
    var total = Number(source.total_questions || 0);
    var answered = Number(source.answered_unique || 0);
    var completion = total ? Math.min(100, Math.max(0, Number(source.completion || ((answered / total) * 100)))) : 0;
    var rounded = completion % 1 === 0 ? String(completion) : completion.toFixed(1);
    setText("[data-question-progress-percent]", rounded + "%");
    setText("[data-question-progress-count]", answered + " of " + total + " " + plural(total, "question", "questions") + " seen");
    var fill = document.querySelector("[data-question-progress-fill]");
    if (fill) fill.style.width = completion + "%";
  }

  function renderRows(selector, rows, linkToPractice) {
    var target = document.querySelector(selector);
    if (!target) return;
    if (!rows.length) {
      target.innerHTML = "<div class=\"empty-state-inline\"><span class=\"empty-asset empty-asset--progress\" aria-hidden=\"true\"></span><p class=\"muted\">No attempts recorded yet.</p></div>";
      return;
    }
    target.innerHTML = rows
      .map(function (row) {
        var link = linkToPractice ? "<a class=\"ghost-btn\" href=\"/practice?topic=" + encodeURIComponent(row.label) + "\">Drill</a>" : "<span></span>";
        return "<div class=\"topic-row\"><span>" + escapeHtml(row.label) + "<br><small class=\"muted\">" + row.attempted + " attempts</small></span><span class=\"mono\">" + row.accuracy + "%</span>" + link + "</div>";
      })
      .join("");
  }

  function renderRecentActivity(rows) {
    var target = document.querySelector("[data-recent-activity]");
    if (!target) return;
    if (!rows.length) {
      target.innerHTML = "<p class=\"muted\">No recent activity yet.</p>";
      return;
    }
    target.innerHTML = rows
      .map(function (row) {
        var mark = row.correct ? "Correct" : "Incorrect";
        return "<div class=\"topic-row\"><span>" + escapeHtml(row.topic) + "<br><small class=\"muted\">" + escapeHtml(row.block) + " · " + escapeHtml(row.question_id) + "</small></span><span class=\"mono\">" + mark + "</span><span></span></div>";
      })
      .join("");
  }

  function renderRecentMistakes(rows) {
    var target = document.querySelector("[data-recent-mistakes]");
    if (!target) return;
    if (!rows.length) {
      target.innerHTML = "<p class=\"muted\">No mistakes recorded yet.</p>";
      return;
    }
    target.innerHTML = rows
      .map(function (row) {
        return "<div class=\"topic-row\"><span>" + escapeHtml(row.topic) + "<br><small class=\"muted\">" + escapeHtml(row.block) + " · " + escapeHtml(row.question_id) + "</small></span><a class=\"ghost-btn\" href=\"/practice?mode=incorrect&topic=" + encodeURIComponent(row.topic) + "\">Drill</a><span></span></div>";
      })
      .join("");
  }

  function renderDueSoon(rows) {
    var target = document.querySelector("[data-due-soon]");
    if (!target) return;
    if (!rows.length) {
      target.innerHTML = "<div class=\"empty-state-inline\"><span class=\"empty-asset empty-asset--review-clear\" aria-hidden=\"true\"></span><p class=\"muted\">No reviews scheduled yet.</p></div>";
      return;
    }
    target.innerHTML = rows
      .map(function (row) {
        return "<div class=\"topic-row\"><span>" + escapeHtml(row.topic) + "<br><small class=\"muted\">" + escapeHtml(row.block) + " · " + escapeHtml(row.question_id) + "</small></span><span class=\"mono\">" + escapeHtml(row.next_review_label) + "</span><a class=\"ghost-btn\" href=\"/practice?mode=due\">Review</a></div>";
      })
      .join("");
  }

  function renderXPChart(history) {
    var container = document.querySelector("[data-xp-chart]");
    if (!container) return;
    if (!history || !history.length) {
      container.innerHTML = "<p class=\"muted\">No study effort history available yet.</p>";
      return;
    }

    var width = 600;
    var height = 220;
    var topMargin = 20;
    var rightMargin = 15;
    var bottomMargin = 30;
    var leftMargin = 55;

    var chartWidth = width - leftMargin - rightMargin;
    var chartHeight = height - topMargin - bottomMargin;

    var maxXP = 0;
    for (var i = 0; i < history.length; i++) {
      if ((history[i].xp || 0) > maxXP) {
        maxXP = history[i].xp;
      }
    }

    var maxY = 10;
    if (maxXP > 10) {
      if (maxXP <= 50) maxY = Math.ceil(maxXP / 10) * 10;
      else if (maxXP <= 100) maxY = Math.ceil(maxXP / 20) * 20;
      else maxY = Math.ceil(maxXP / 50) * 50;
    }

    // Grid lines and Y axis guide
    var gridSvg = "";
    var gridLevels = [0, 0.25, 0.5, 0.75, 1.0];
    for (var g = 0; g < gridLevels.length; g++) {
      var ratio = gridLevels[g];
      var gridY = topMargin + chartHeight * (1 - ratio);
      var gridVal = Math.round(ratio * maxY);
      // Grid line
      gridSvg += '<line class="' + (ratio === 0 ? 'chart-axis-line' : 'chart-grid-line-dash') + '" x1="' + leftMargin + '" y1="' + gridY + '" x2="' + (width - rightMargin) + '" y2="' + gridY + '" />\n';
      // Label text
      gridSvg += '<text class="chart-label-text" x="' + (leftMargin - 8) + '" y="' + (gridY + 4) + '" text-anchor="end">' + gridVal + ' XP</text>\n';
    }

    // Columns
    var barWidth = 20;
    var spacing = (chartWidth - (history.length * barWidth)) / (history.length - 1);
    var barsSvg = "";
    var labelsSvg = "";

    for (var k = 0; k < history.length; k++) {
      var item = history[k];
      var val = item.xp || 0;
      var h = Math.max(val > 0 ? 3 : 0, (val / maxY) * chartHeight);
      var x = leftMargin + k * (barWidth + spacing);
      var y = topMargin + chartHeight - h;
      var isToday = (k === history.length - 1);
      var barClass = isToday ? "chart-bar-rect chart-bar-rect-today" : "chart-bar-rect";

      // Draw column rect and value label inside a group
      barsSvg += '<g class="chart-bar-group">\n';
      if (val > 0) {
        barsSvg += '  <rect class="' + barClass + '" x="' + x + '" y="' + y + '" width="' + barWidth + '" height="' + h + '" rx="' + (h > 6 ? 3 : 1) + '" ry="' + (h > 6 ? 3 : 1) + '">\n';
        barsSvg += '    <title>' + val + ' XP on ' + formatDisplayDate(item.date) + '</title>\n';
        barsSvg += '  </rect>\n';
        barsSvg += '  <text class="chart-value-text" x="' + (x + barWidth / 2) + '" y="' + (y - 6) + '" text-anchor="middle">' + val + '</text>\n';
      } else {
        // Draw tiny indicator for 0 XP so columns are still aligned
        barsSvg += '  <rect class="' + barClass + '" x="' + x + '" y="' + (topMargin + chartHeight - 1) + '" width="' + barWidth + '" height="1" opacity="0.3" rx="1" ry="1">\n';
        barsSvg += '    <title>0 XP on ' + formatDisplayDate(item.date) + '</title>\n';
        barsSvg += '  </rect>\n';
        barsSvg += '  <text class="chart-value-text" x="' + (x + barWidth / 2) + '" y="' + (topMargin + chartHeight - 7) + '" text-anchor="middle">0</text>\n';
      }
      barsSvg += '</g>\n';

      // X-axis label
      var labelText = isToday ? "Today" : getDayLetter(item.date);
      labelsSvg += '<text class="chart-label-text" x="' + (x + barWidth / 2) + '" y="' + (height - 8) + '" text-anchor="middle">' + labelText + '</text>\n';
    }

    container.innerHTML = '<svg class="chart-svg" viewBox="0 0 ' + width + ' ' + height + '">\n' +
      gridSvg +
      barsSvg +
      labelsSvg +
      '</svg>';
  }

  function renderRadarChart(blocks) {
    var container = document.querySelector("[data-radar-chart]");
    if (!container) return;
    if (!blocks || !blocks.length) {
      container.innerHTML = '<div class="empty-state-inline" style="padding: var(--space-3); text-align: center; width: 100%;">\n' +
        '  <span class="empty-asset empty-asset--progress" aria-hidden="true" style="margin: 0 auto var(--space-2);"></span>\n' +
        '  <p class="muted" style="font-size: 13px;">Awaiting attempts to map your radar web.</p>\n' +
        '</div>';
      return;
    }

    // Pad blocks if < 3 to avoid degenerate single-point or single-line radar
    var chartBlocks = [].concat(blocks);
    if (chartBlocks.length < 3) {
      var defaultBlocks = ["Population Health", "CVS", "Endocrine", "Year 1"];
      var existing = {};
      for (var b = 0; b < chartBlocks.length; b++) {
        existing[chartBlocks[b].label] = true;
      }
      for (var d = 0; d < defaultBlocks.length; d++) {
        if (chartBlocks.length >= 3) break;
        var name = defaultBlocks[d];
        if (!existing[name]) {
          chartBlocks.push({
            label: name,
            attempted: 0,
            correct: 0,
            accuracy: 0
          });
          existing[name] = true;
        }
      }
      while (chartBlocks.length < 3) {
        chartBlocks.push({
          label: "Block " + (chartBlocks.length + 1),
          attempted: 0,
          correct: 0,
          accuracy: 0
        });
      }
    }

    var width = 400;
    var height = 400;
    var cx = 200;
    var cy = 200;
    var R = 125;

    var N = chartBlocks.length;
    var angleStep = (2 * Math.PI) / N;

    var vertices = [];
    for (var i = 0; i < N; i++) {
      var item = chartBlocks[i];
      var angle = i * angleStep - Math.PI / 2;
      vertices.push({
        label: item.label,
        accuracy: item.accuracy || 0,
        attempted: item.attempted || 0,
        cos: Math.cos(angle),
        sin: Math.sin(angle)
      });
    }

    // Grid webs
    var webSvg = "";
    var gridLevels = [0.25, 0.5, 0.75, 1.0];
    for (var l = 0; l < gridLevels.length; l++) {
      var level = gridLevels[l];
      var pointsArr = [];
      for (var v1 = 0; v1 < N; v1++) {
        var vx = cx + level * R * vertices[v1].cos;
        var vy = cy + level * R * vertices[v1].sin;
        pointsArr.push(vx + "," + vy);
      }
      webSvg += '<polygon class="radar-grid-web" points="' + pointsArr.join(" ") + '" />\n';
    }

    // Axis lines
    var axisSvg = "";
    for (var v2 = 0; v2 < N; v2++) {
      var ax = cx + R * vertices[v2].cos;
      var ay = cy + R * vertices[v2].sin;
      axisSvg += '<line class="radar-axis" x1="' + cx + '" y1="' + cy + '" x2="' + ax + '" y2="' + ay + '" />\n';
    }

    // User accuracy polygon
    var polyPointsArr = [];
    for (var v3 = 0; v3 < N; v3++) {
      var factor = Math.min(100, Math.max(0, vertices[v3].accuracy)) / 100;
      // Use min level so accuracy 0 still plots a tiny visible polygon at the center
      var levelVal = Math.max(0.05, factor);
      var px = cx + levelVal * R * vertices[v3].cos;
      var py = cy + levelVal * R * vertices[v3].sin;
      polyPointsArr.push(px + "," + py);
    }
    var polygonSvg = '<polygon class="radar-poly-area" points="' + polyPointsArr.join(" ") + '" />\n';

    // Scale values top-axis guides
    var scaleGuidesSvg =
      '<text class="chart-label-text" x="205" y="' + (cy - 0.25 * R) + '" dy="0.3em">25%</text>\n' +
      '<text class="chart-label-text" x="205" y="' + (cy - 0.5 * R) + '" dy="0.3em">50%</text>\n' +
      '<text class="chart-label-text" x="205" y="' + (cy - 0.75 * R) + '" dy="0.3em">75%</text>\n' +
      '<text class="chart-label-text" x="205" y="' + (cy - R) + '" dy="0.3em">100%</text>\n';

    // Node circles and text labels
    var nodesSvg = "";
    var labelsSvg = "";
    for (var v4 = 0; v4 < N; v4++) {
      var vert = vertices[v4];
      var factorVal = Math.min(100, Math.max(0, vert.accuracy)) / 100;
      var levelFactor = Math.max(0.05, factorVal);
      var nx = cx + levelFactor * R * vert.cos;
      var ny = cy + levelFactor * R * vert.sin;

      // Draw node circle
      nodesSvg += '<circle class="radar-node-circle" cx="' + nx + '" cy="' + ny + '" r="4.5">\n' +
        '  <title>' + escapeHtml(vert.label) + ': ' + vert.accuracy + '% (' + vert.attempted + ' attempts)</title>\n' +
        '</circle>\n';

      // Text label position (radius + offset)
      var lx = cx + (R + 18) * vert.cos;
      var ly = cy + (R + 18) * vert.sin;

      // text alignment
      var anchor = "middle";
      if (vert.cos > 0.1) anchor = "start";
      else if (vert.cos < -0.1) anchor = "end";

      var dy = "0.3em";
      if (vert.sin > 0.5) dy = "1em";
      else if (vert.sin < -0.5) dy = "-0.4em";

      var textLabel = escapeHtml(vert.label);
      var accuracyLabel = vert.attempted > 0 ? vert.accuracy + "%" : "Unseen";

      labelsSvg += '<text class="radar-label" x="' + lx + '" y="' + ly + '" dy="' + dy + '" text-anchor="' + anchor + '">\n' +
        '  ' + textLabel + '\n' +
        '  <tspan class="radar-label-muted" x="' + lx + '" dy="1.2em">' + accuracyLabel + '</tspan>\n' +
        '</text>\n';
    }

    container.innerHTML = '<svg class="chart-svg" viewBox="0 0 ' + width + ' ' + height + '">\n' +
      webSvg +
      axisSvg +
      polygonSvg +
      scaleGuidesSvg +
      nodesSvg +
      labelsSvg +
      '</svg>';
  }

  function formatDisplayDate(dateStr) {
    if (!dateStr) return "";
    try {
      var parts = dateStr.split("-");
      if (parts.length !== 3) return dateStr;
      var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      var monthIndex = parseInt(parts[1], 10) - 1;
      var day = parseInt(parts[2], 10);
      return months[monthIndex] + " " + day;
    } catch (e) {
      return dateStr;
    }
  }

  function getDayLetter(dateStr) {
    try {
      var d = new Date(dateStr);
      var days = ["S", "M", "T", "W", "T", "F", "S"];
      return days[d.getDay()];
    } catch (e) {
      return "";
    }
  }

  async function initLeaderboard() {
    var body = document.querySelector("[data-leaderboard-body]");
    if (!body) return;
    try {
      var data = await api("/api/leaderboard");
      if (!(data.users || []).length) {
        body.innerHTML = "<tr><td colspan=\"7\"><div class=\"empty-state-inline\"><span class=\"empty-asset empty-asset--leaderboard\" aria-hidden=\"true\"></span><p class=\"muted\">No names are recorded yet.</p></div></td></tr>";
        return;
      }
      body.innerHTML = (data.users || [])
        .map(function (row) {
          return "<tr><td class=\"mono\">" + row.rank + "</td><td>" + escapeHtml(row.username) + "</td><td>" + escapeHtml(row.level_display) + "</td><td class=\"mono\">" + formatNumber(row.xp) + "</td><td class=\"mono\">" + row.streak + "</td><td class=\"mono\">" + row.accuracy + "%</td><td class=\"mono\">" + row.questions_answered + "</td></tr>";
        })
        .join("");
    } catch {
      body.innerHTML = "<tr><td colspan=\"7\">The Pantheon is temporarily unavailable.</td></tr>";
    }
  }

  async function initAdmin() {
    bindAdminRetireForm();
    bindAdminNotificationForm();
    bindAdminNotificationActions();
    bindAdminResetForm();
    bindAdminPatchNotesForm();
    try {
      var data = await api("/api/admin-summary");
      setText("[data-admin-users]", data.users);
      setText("[data-admin-questions]", data.questions);
      setText("[data-admin-deleted-questions]", data.deleted_questions || 0);
      setText("[data-admin-attempts]", data.attempts);
      setText("[data-admin-due]", data.due_reviews);
      setText("[data-admin-reviews]", data.review_records);
      setText("[data-admin-topics]", data.topics);
      setText("[data-admin-latest]", data.latest_attempt_at ? formatDate(data.latest_attempt_at) : "None yet");
      var blocks = document.querySelector("[data-admin-blocks]");
      if (blocks) {
        blocks.innerHTML = (data.blocks || []).length
          ? data.blocks.map(function (block) { return "<span class=\"block-tag\">" + escapeHtml(block) + "</span>"; }).join("")
          : "<span class=\"block-tag\">No blocks loaded</span>";
      }
      renderAdminFeatureFlags(data.feature_flags || {});
      var quality = data.quality || {};
      setText("[data-quality-duplicates]", quality.duplicate_stems || 0);
      setText("[data-quality-missing-explanations]", quality.missing_explanations || 0);
      setText("[data-quality-short-explanations]", quality.short_explanations || 0);
      setText("[data-quality-missing-traps]", quality.missing_traps || 0);
      setText("[data-quality-missing-options]", quality.missing_options || 0);
      setText("[data-site-feedback-count]", data.site_feedback_count || 0);
      renderSiteFeedbackList(data.recent_site_feedback || []);
      loadAdminNotifications();
      loadAdminPatchNotes();
    } catch {
      showAuthPanel("login");
    }
  }

  function renderAdminFeatureFlags(flags) {
    var target = document.querySelector("[data-admin-feature-flags]");
    if (!target) return;
    var names = Object.keys(flags || {}).sort();
    target.innerHTML = names.length
      ? names.map(function (name) {
        var enabled = flags[name] !== false;
        return "<span class=\"block-tag feature-flag " + (enabled ? "feature-flag--on" : "feature-flag--off") + "\">"
          + escapeHtml(name.replace(/_/g, " "))
          + " · "
          + (enabled ? "on" : "off")
          + "</span>";
      }).join("")
      : "<span class=\"block-tag\">No feature flags loaded</span>";
  }

  function bindAdminNotificationForm() {
    var form = document.querySelector("[data-admin-notification-form]");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "true";
    form.addEventListener("submit", submitAdminNotification);
  }

  function bindAdminNotificationActions() {
    var list = document.querySelector("[data-admin-notification-list]");
    if (!list || list.dataset.boundActions) return;
    list.dataset.boundActions = "true";
    list.addEventListener("click", function (event) {
      var button = event.target.closest("[data-admin-notification-delete]");
      if (!button) return;
      deleteAdminNotification(button.dataset.adminNotificationDelete);
    });
  }

  async function submitAdminNotification(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var submit = document.querySelector("[data-admin-notification-submit]");
    var message = document.querySelector("[data-admin-notification-message]");
    if (message) {
      message.classList.add("hidden");
      message.textContent = "";
    }
    if (submit) submit.disabled = true;
    var data = new FormData(form);
    try {
      await api("/api/admin/notifications", {
        method: "POST",
        body: JSON.stringify({
          kind: data.get("kind"),
          title: data.get("title"),
          message: data.get("message"),
          yes_label: data.get("yes_label"),
          no_label: data.get("no_label"),
        }),
      });
      if (message) {
        message.textContent = "Popup published. Accounts will see it once.";
        message.classList.remove("hidden");
      }
      form.reset();
      loadAdminNotifications();
    } catch (error) {
      if (message) {
        message.textContent = error && error.error ? error.error : "Popup could not be published.";
        message.classList.remove("hidden");
      }
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function loadAdminNotifications() {
    var list = document.querySelector("[data-admin-notification-list]");
    if (!list) return;
    try {
      var data = await api("/api/admin/notifications");
      renderAdminNotificationList(data.items || []);
    } catch {
      list.innerHTML = "<p class=\"muted\">Notifications could not be loaded.</p>";
    }
  }

  async function deleteAdminNotification(id) {
    if (!id) return;
    if (!window.confirm("Delete this popup for all users? Poll responses will be removed too.")) return;
    var list = document.querySelector("[data-admin-notification-list]");
    try {
      await api("/api/admin/notifications/" + encodeURIComponent(id) + "/delete", { method: "POST" });
      loadAdminNotifications();
    } catch (error) {
      if (list) {
        list.insertAdjacentHTML(
          "afterbegin",
          "<p class=\"form-note\">" + escapeHtml(error && error.error ? error.error : "Notification could not be deleted.") + "</p>",
        );
      }
    }
  }

  function renderAdminNotificationList(items) {
    var list = document.querySelector("[data-admin-notification-list]");
    if (!list) return;
    if (!items.length) {
      list.innerHTML = "<p class=\"muted\">No notifications yet.</p>";
      return;
    }
    list.innerHTML = items.map(function (item) {
      var counts = item.responses || {};
      var pollCounts = item.kind === "poll"
        ? "<span class=\"block-tag\">Yes " + Number(counts.yes || 0) + "</span><span class=\"block-tag\">No " + Number(counts.no || 0) + "</span>"
        : "";
      var voters = renderNotificationVoters(item.voters || {});
      return "<article class=\"admin-notification-item\">"
        + "<div class=\"admin-notification-item__head\"><strong>" + escapeHtml(item.title || "Aesculon notice") + "</strong><span class=\"block-tag\">" + escapeHtml(notificationKindLabel(item.kind)) + "</span></div>"
        + "<p>" + escapeHtml(item.message || "") + "</p>"
        + "<div class=\"admin-notification-counts\">" + pollCounts + "<span class=\"block-tag\">Dismissed " + Number(counts.dismissed || 0) + "</span><span class=\"block-tag\">Total " + Number(item.total_responses || 0) + "</span></div>"
        + voters
        + "<div class=\"admin-notification-item__foot\"><small class=\"muted\">" + escapeHtml(item.created_by || "Admin") + (item.created_at ? " · " + formatDateTime(item.created_at) : "") + "</small><button class=\"ghost-btn danger\" type=\"button\" data-admin-notification-delete=\"" + escapeHtml(item.id) + "\">Delete for all</button></div>"
        + "</article>";
    }).join("");
  }

  function renderNotificationVoters(voters) {
    var groups = [
      ["yes", "Yes"],
      ["no", "No"],
      ["dismissed", "Dismissed"],
    ].map(function (group) {
      var rows = voters[group[0]] || [];
      if (!rows.length) return "";
      var names = rows.map(function (row) {
        var label = row.username || "Unknown";
        var title = row.created_at ? " title=\"" + escapeHtml(formatDateTime(row.created_at)) + "\"" : "";
        return "<span" + title + ">" + escapeHtml(label) + "</span>";
      }).join("");
      return "<div class=\"admin-notification-voter-group\"><small>" + group[1] + "</small><div>" + names + "</div></div>";
    }).filter(Boolean).join("");
    return groups ? "<div class=\"admin-notification-voters\">" + groups + "</div>" : "";
  }

  function notificationKindLabel(kind) {
    return kind === "poll" ? "Poll" : "Message";
  }

  function bindAdminPatchNotesForm() {
    var form = document.querySelector("[data-admin-patch-notes-form]");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "true";
    form.addEventListener("submit", saveAdminPatchNotes);
  }

  async function saveAdminPatchNotes(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var versionInput = form.querySelector("input[name=\"version\"]");
    var titleInput = form.querySelector("input[name=\"title\"]");
    var contentInput = form.querySelector("textarea[name=\"content\"]");
    var submit = form.querySelector("[data-admin-patch-notes-submit]");
    var message = form.querySelector("[data-admin-patch-notes-message]");
    
    var version = String(versionInput && versionInput.value || "").trim();
    var title = String(titleInput && titleInput.value || "").trim();
    var content = String(contentInput && contentInput.value || "").trim();
    
    if (!version || !title || !content) return;
    if (submit) submit.disabled = true;
    if (message) message.classList.add("hidden");
    
    try {
      await api("/api/admin/patch-notes", {
        method: "POST",
        body: JSON.stringify({
          version: version,
          title: title,
          content: content,
        }),
      });
      if (message) {
        message.textContent = "Patch notes published successfully.";
        message.classList.remove("hidden");
      }
      form.reset();
      loadAdminPatchNotes();
    } catch (error) {
      if (message) {
        message.textContent = error && error.error ? error.error : "Could not save patch notes.";
        message.classList.remove("hidden");
      }
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function loadAdminPatchNotes() {
    var list = document.querySelector("[data-admin-patch-notes-list]");
    if (!list) return;
    try {
      var data = await api("/api/admin/patch-notes");
      renderAdminPatchNotesList(data.items || []);
    } catch {
      list.innerHTML = "<p class=\"muted\">Patch notes could not be loaded.</p>";
    }
  }

  async function deleteAdminPatchNote(id) {
    if (!id) return;
    if (!window.confirm("Delete this patch note?")) return;
    var list = document.querySelector("[data-admin-patch-notes-list]");
    try {
      await api("/api/admin/patch-notes/" + encodeURIComponent(id) + "/delete", { method: "POST" });
      loadAdminPatchNotes();
    } catch (error) {
      if (list) {
        list.insertAdjacentHTML(
          "afterbegin",
          "<p class=\"form-note\">" + escapeHtml(error && error.error ? error.error : "Patch note could not be deleted.") + "</p>"
        );
      }
    }
  }

  function renderAdminPatchNotesList(items) {
    var list = document.querySelector("[data-admin-patch-notes-list]");
    if (!list) return;
    if (!items.length) {
      list.innerHTML = "<p class=\"muted\">No patch notes published yet.</p>";
      return;
    }
    
    list.innerHTML = items.map(function (item) {
      return "<article class=\"admin-notification-item\" style=\"padding: var(--space-2); border: 1px solid var(--ic-border); border-radius: var(--radius-sharp); background: var(--ic-surface);\">"
        + "<div class=\"admin-notification-item__head\" style=\"display: flex; justify-content: space-between; align-items: center;\">"
        + "<strong>" + escapeHtml(item.title) + " (" + escapeHtml(item.version) + ")</strong>"
        + "<button class=\"ghost-btn danger\" type=\"button\" data-patch-note-delete-id=\"" + item.id + "\" style=\"min-height: 24px; padding: 0 8px; font-size: 10px;\">Delete</button>"
        + "</div>"
        + "<pre style=\"white-space: pre-wrap; font-size: 11px; margin-top: 8px; color: var(--ic-muted); font-family: monospace;\">" + escapeHtml(item.content) + "</pre>"
        + "</article>";
    }).join("");
    
    list.querySelectorAll("[data-patch-note-delete-id]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        deleteAdminPatchNote(btn.dataset.patchNoteDeleteId);
      });
    });
  }

  function renderSiteFeedbackList(items) {
    var list = document.querySelector("[data-site-feedback-list]");
    if (!list) return;
    if (!items.length) {
      list.innerHTML = "<p class=\"muted\">No site feedback yet.</p>";
      return;
    }
    list.innerHTML = items.map(function (item) {
      var page = item.page_path ? "<small class=\"muted\">" + escapeHtml(item.page_path) + "</small>" : "";
      return "<article class=\"site-feedback-item\">"
        + "<div><span class=\"block-tag\">" + escapeHtml(siteFeedbackCategoryLabel(item.category)) + "</span><strong>" + escapeHtml(item.username || "Guest") + "</strong></div>"
        + "<p>" + escapeHtml(item.message || "") + "</p>"
        + "<div class=\"site-feedback-meta\">" + page + "<small class=\"muted\">" + (item.created_at ? formatDateTime(item.created_at) : "") + "</small></div>"
        + "</article>";
    }).join("");
  }

  function siteFeedbackCategoryLabel(category) {
    return {
      bug: "Bug",
      idea: "Idea",
      content: "Content",
      general: "General",
    }[category] || "General";
  }

  async function initAdminActivity() {
    var userBody = document.querySelector("[data-activity-users-body]");
    var recentBody = document.querySelector("[data-activity-recent-body]");
    if (!userBody || !recentBody) return;
    try {
      var data = await api("/api/admin/activity");
      var users = data.users || [];
      var activeToday = users.filter(function (user) { return Number(user.today_attempts || 0) > 0; }).length;
      var attemptsToday = users.reduce(function (sum, user) { return sum + Number(user.today_attempts || 0); }, 0);
      var latest = users.map(function (user) { return user.latest_attempt_at; }).filter(Boolean).sort().pop();
      setText("[data-activity-users]", users.length);
      setText("[data-activity-active-today]", activeToday);
      setText("[data-activity-attempts-today]", attemptsToday);
      setText("[data-activity-latest]", latest ? formatDateTime(latest) : "None yet");
      userBody.innerHTML = users.length ? users.map(renderAdminActivityUser).join("") : "<tr><td colspan=\"9\">No users yet.</td></tr>";
      recentBody.innerHTML = (data.recent_attempts || []).length
        ? (data.recent_attempts || []).map(renderAdminRecentAttempt).join("")
        : "<tr><td colspan=\"6\">No attempts yet.</td></tr>";
    } catch {
      showAuthPanel("login");
    }
  }

  function renderAdminActivityUser(user) {
    var email = user.email ? "<small class=\"muted\">" + escapeHtml(user.email) + "</small>" : "";
    return "<tr>"
      + "<td><strong>" + escapeHtml(user.username || "Scholar") + "</strong><br>" + email + "</td>"
      + "<td>" + escapeHtml(user.level || "") + "</td>"
      + "<td class=\"mono\">" + formatNumber(user.xp) + "</td>"
      + "<td class=\"mono\">" + formatNumber(user.attempts) + "<br><small class=\"muted\">" + formatNumber(user.unique_answered) + " unique</small></td>"
      + "<td class=\"mono\">" + formatNumber(user.today_attempts) + "</td>"
      + "<td class=\"mono\">" + escapeHtml(user.accuracy || 0) + "%</td>"
      + "<td class=\"mono\">" + formatNumber(user.due_reviews) + "</td>"
      + "<td class=\"mono\">" + formatNumber(user.feedback_reports) + "</td>"
      + "<td>" + (user.latest_attempt_at ? formatDateTime(user.latest_attempt_at) : "<span class=\"muted\">None</span>") + "</td>"
      + "</tr>";
  }

  function renderAdminRecentAttempt(item) {
    var result = item.is_correct ? "<span class=\"status-pill status-pill--correct\">Correct</span>" : "<span class=\"status-pill status-pill--wrong\">Incorrect</span>";
    return "<tr>"
      + "<td>" + escapeHtml(item.username || "Scholar") + "</td>"
      + "<td class=\"mono\">" + escapeHtml(item.question_id || "") + "<br><small class=\"muted\">" + escapeHtml(item.block || "") + "</small></td>"
      + "<td>" + escapeHtml(item.topic || "") + "</td>"
      + "<td class=\"mono\">" + escapeHtml(item.chosen_answer || "-") + "</td>"
      + "<td>" + result + "</td>"
      + "<td>" + (item.attempted_at ? formatDateTime(item.attempted_at) : "") + "</td>"
      + "</tr>";
  }

  function bindAdminRetireForm() {
    var form = document.querySelector("[data-admin-retire-form]");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "true";
    form.addEventListener("submit", retireAdminQuestion);
  }

  async function retireAdminQuestion(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var input = form.querySelector("input[name=\"question_id\"]");
    var button = form.querySelector("button[type=\"submit\"]");
    var questionId = String(input && input.value || "").trim().toUpperCase();
    var message = document.querySelector("[data-admin-retire-message]");
    if (!questionId) return;
    if (!window.confirm("Retire " + questionId + " from the live question bank and future syncs?")) return;
    if (button) button.disabled = true;
    if (message) {
      message.classList.add("hidden");
      message.classList.remove("form-error");
      message.classList.add("form-note");
    }
    try {
      var data = await api("/api/admin/questions/" + encodeURIComponent(questionId) + "/delete", { method: "POST" });
      if (input) input.value = "";
      if (message) {
        message.textContent = (data.question_id || questionId) + " retired. Future syncs will not restore it.";
        message.classList.remove("hidden");
      }
      await initAdmin();
    } catch {
      if (message) {
        message.textContent = questionId + " could not be retired.";
        message.classList.remove("hidden", "form-note");
        message.classList.add("form-error");
      }
    } finally {
      if (button) button.disabled = false;
    }
  }

  function bindAdminResetForm() {
    var form = document.querySelector("[data-admin-reset-form]");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "true";
    form.addEventListener("submit", generateAdminResetLink);
  }

  async function generateAdminResetLink(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var input = form.querySelector("input[name=\"email\"]");
    var button = form.querySelector("button[type=\"submit\"]");
    var email = String(input && input.value || "").trim();
    var errorNode = form.querySelector("[data-admin-reset-error]");
    var successNode = form.querySelector("[data-admin-reset-success]");
    var urlNode = form.querySelector("[data-admin-reset-url]");
    if (!email) return;
    if (button) button.disabled = true;
    if (errorNode) errorNode.classList.add("hidden");
    if (successNode) successNode.classList.add("hidden");
    try {
      var data = await api("/api/admin/generate-reset-url", {
        method: "POST",
        body: JSON.stringify({ email: email })
      });
      if (urlNode) {
        urlNode.textContent = data.reset_url;
      }
      if (successNode) {
        successNode.classList.remove("hidden");
      }
      if (input) input.value = "";
    } catch (error) {
      if (errorNode) {
        errorNode.textContent = error.error || "Could not generate reset link.";
        errorNode.classList.remove("hidden");
      }
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function initQuestionBankAdmin() {
    var root = document.querySelector("[data-question-bank-admin]");
    if (!root) return;
    bindQuestionBankSearch();
    bindQuestionEditor();
    await loadQuestionBank();
  }

  function bindQuestionBankSearch() {
    var form = document.querySelector("[data-question-bank-search]");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "true";
    var timer = null;
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      loadQuestionBank();
    });
    form.querySelectorAll("input, select").forEach(function (control) {
      control.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(loadQuestionBank, 250);
      });
      control.addEventListener("change", loadQuestionBank);
    });
  }

  function bindQuestionEditor() {
    var form = document.querySelector("[data-question-editor-form]");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "true";
    form.addEventListener("submit", saveQuestionEditor);
    form.querySelectorAll(".question-editor-options textarea").forEach(function (input) {
      input.addEventListener("input", updateTrapOptionsFromEditor);
    });
    var retire = document.querySelector("[data-question-editor-delete]");
    if (retire) retire.addEventListener("click", retireQuestionFromEditor);
  }

  async function loadQuestionBank() {
    var form = document.querySelector("[data-question-bank-search]");
    var list = document.querySelector("[data-question-bank-results]");
    if (!form || !list) return;
    var params = new URLSearchParams();
    ["q", "block", "topic", "status"].forEach(function (name) {
      var value = form.elements[name] ? form.elements[name].value.trim() : "";
      if (value) params.set(name, value);
    });
    try {
      var data = await api("/api/admin/question-bank?" + params.toString());
      populateQuestionBankFilters(data);
      setText("[data-question-bank-count]", formatNumber(data.total_matches || 0));
      setText("[data-question-bank-total]", formatNumber(data.question_count || 0));
      setText("[data-question-bank-protected]", formatNumber(data.live_edited_count || 0));
      renderQuestionBankResults(data.items || []);
    } catch {
      list.innerHTML = "<article class=\"panel\"><p class=\"muted\">Question bank could not be loaded.</p></article>";
    }
  }

  function populateQuestionBankFilters(data) {
    var form = document.querySelector("[data-question-bank-search]");
    if (!form || form.dataset.filtersLoaded) return;
    form.dataset.filtersLoaded = "true";
    fillQuestionBankSelect("[data-question-bank-block]", "All blocks", data.blocks || []);
    fillQuestionBankSelect("[data-question-bank-topic]", "All topics", data.topics || []);
  }

  function fillQuestionBankSelect(selector, label, items) {
    var select = document.querySelector(selector);
    if (!select) return;
    var current = select.value;
    select.innerHTML = "<option value=\"\">" + escapeHtml(label) + "</option>" + items.map(function (item) {
      return "<option value=\"" + escapeHtml(item) + "\">" + escapeHtml(item) + "</option>";
    }).join("");
    if (current) select.value = current;
  }

  function renderQuestionBankResults(items) {
    var list = document.querySelector("[data-question-bank-results]");
    if (!list) return;
    if (!items.length) {
      list.innerHTML = "<article class=\"panel\"><div class=\"empty-state-inline\"><span class=\"empty-asset empty-asset--no-results\" aria-hidden=\"true\"></span><p class=\"muted\">No questions match this search.</p></div></article>";
      return;
    }
    list.innerHTML = items.map(function (item) {
      var protectedTag = item.live_edited ? "<span class=\"block-tag block-tag--accent\">Protected</span>" : "<span class=\"block-tag\">Syncable</span>";
      var votes = Number(item.votes && item.votes.bad || 0) + Number(item.votes && item.votes.not_learnt || 0);
      var blocks = item.blocks && item.blocks.length ? item.blocks.join(" + ") : item.block || "";
      return "<article class=\"question-bank-result panel\" data-question-bank-row=\"" + escapeHtml(item.question_id) + "\">"
        + "<div class=\"question-bank-result__head\">"
        + "<div><p class=\"section-label\">" + escapeHtml(item.question_id) + " · " + escapeHtml(blocks) + "</p><h2 class=\"panel-title\">" + escapeHtml(item.topic || "") + "</h2></div>"
        + protectedTag
        + "</div>"
        + "<p class=\"question-preview\">" + escapeHtml(item.stem || "") + "</p>"
        + "<p class=\"muted question-preview\">" + escapeHtml(item.lead_in || "") + "</p>"
        + "<div class=\"tag-list\"><span class=\"block-tag\">Correct " + escapeHtml(item.correct_answer || "") + "</span><span class=\"block-tag\">" + formatNumber(item.attempts || 0) + " attempts</span><span class=\"block-tag\">" + formatNumber(votes) + " reports</span></div>"
        + "</article>";
    }).join("");
    list.querySelectorAll("[data-question-bank-row]").forEach(function (row) {
      row.addEventListener("click", function () {
        loadQuestionEditor(row.dataset.questionBankRow);
      });
    });
  }

  async function loadQuestionEditor(questionId) {
    if (!questionId) return;
    setQuestionEditorError("");
    setQuestionEditorNote("");
    try {
      var data = await api("/api/admin/questions/" + encodeURIComponent(questionId));
      renderQuestionEditor(data.question);
    } catch {
      setQuestionEditorError("This question could not be loaded.");
    }
  }

  function renderQuestionEditor(question) {
    var form = document.querySelector("[data-question-editor-form]");
    var empty = document.querySelector("[data-question-editor-empty]");
    if (!form || !question) return;
    form.dataset.questionId = question.question_id;
    var blocks = question.blocks && question.blocks.length ? question.blocks.join(" + ") : question.block || "";
    setText("[data-editor-kicker]", question.question_id + " · " + blocks);
    setText("[data-editor-title]", question.topic || "Question");
    var protectedTag = document.querySelector("[data-editor-protected]");
    if (protectedTag) {
      protectedTag.classList.toggle("hidden", !question.live_edited);
      protectedTag.textContent = question.live_edited_by ? "Protected · " + question.live_edited_by : "Protected";
    }
    form.elements.block.value = question.block || "";
    form.elements.secondary_blocks.value = (question.secondary_blocks || []).join(", ");
    form.elements.topic.value = question.topic || "";
    form.elements.lecture_no.value = question.lecture_no || "";
    form.elements.tier.value = question.tier || "";
    form.elements.sba_style.value = question.sba_style || "";
    form.elements.stem.value = question.stem || "";
    form.elements.lead_in.value = question.lead_in || "";
    form.elements.option_a.value = question.options && question.options.A || "";
    form.elements.option_b.value = question.options && question.options.B || "";
    form.elements.option_c.value = question.options && question.options.C || "";
    form.elements.option_d.value = question.options && question.options.D || "";
    form.elements.option_e.value = question.options && question.options.E || "";
    form.elements.correct_answer.value = question.correct_answer || "A";
    form.elements.explanation.value = question.explanation || "";
    form.elements.why_distractor_wrong.value = question.why_distractor_wrong || "";
    updateTrapOptionsFromEditor(question.top_distractor || "");
    form.classList.remove("hidden");
    if (empty) empty.classList.add("hidden");
  }

  function updateTrapOptionsFromEditor(selectedValue) {
    var form = document.querySelector("[data-question-editor-form]");
    var select = document.querySelector("[data-trap-select]");
    if (!form || !select) return;
    var previous = typeof selectedValue === "string" ? selectedValue : select.value;
    var options = [
      ["A", form.elements.option_a.value],
      ["B", form.elements.option_b.value],
      ["C", form.elements.option_c.value],
      ["D", form.elements.option_d.value],
      ["E", form.elements.option_e.value],
    ].filter(function (entry) { return entry[1].trim(); });
    select.innerHTML = "<option value=\"\">No trap selected</option>" + options.map(function (entry) {
      return "<option value=\"" + escapeHtml(entry[1]) + "\">" + escapeHtml(entry[0] + ". " + entry[1]) + "</option>";
    }).join("");
    select.value = previous || "";
  }

  async function saveQuestionEditor(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var questionId = form.dataset.questionId;
    var button = document.querySelector("[data-question-editor-save]");
    if (!questionId) return;
    setQuestionEditorError("");
    setQuestionEditorNote("");
    var payload = {
      block: form.elements.block.value,
      secondary_blocks: form.elements.secondary_blocks.value,
      topic: form.elements.topic.value,
      lecture_no: form.elements.lecture_no.value,
      tier: form.elements.tier.value,
      sba_style: form.elements.sba_style.value,
      stem: form.elements.stem.value,
      lead_in: form.elements.lead_in.value,
      options: {
        A: form.elements.option_a.value,
        B: form.elements.option_b.value,
        C: form.elements.option_c.value,
        D: form.elements.option_d.value,
        E: form.elements.option_e.value,
      },
      correct_answer: form.elements.correct_answer.value,
      explanation: form.elements.explanation.value,
      top_distractor: form.elements.top_distractor.value,
      why_distractor_wrong: form.elements.why_distractor_wrong.value,
    };
    if (button) button.disabled = true;
    try {
      var data = await api("/api/admin/questions/" + encodeURIComponent(questionId), {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      renderQuestionEditor(data.question);
      setQuestionEditorNote(questionId + " saved. Normal syncs will now skip this live edit.");
      await loadQuestionBank();
    } catch (error) {
      setQuestionEditorError(error.error || "This question could not be saved.");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function retireQuestionFromEditor() {
    var form = document.querySelector("[data-question-editor-form]");
    var questionId = form && form.dataset.questionId;
    if (!questionId) return;
    if (!window.confirm("Retire " + questionId + " from the live question bank and future syncs?")) return;
    try {
      await api("/api/admin/questions/" + encodeURIComponent(questionId) + "/delete", { method: "POST" });
      setQuestionEditorNote(questionId + " retired. It will stay excluded from future syncs.");
      clearQuestionEditor();
      await loadQuestionBank();
    } catch {
      setQuestionEditorError(questionId + " could not be retired.");
    }
  }

  function clearQuestionEditor() {
    var form = document.querySelector("[data-question-editor-form]");
    var empty = document.querySelector("[data-question-editor-empty]");
    if (form) {
      form.reset();
      form.dataset.questionId = "";
      form.classList.add("hidden");
    }
    setText("[data-editor-kicker]", "Select a question");
    setText("[data-editor-title]", "No question selected");
    var protectedTag = document.querySelector("[data-editor-protected]");
    if (protectedTag) protectedTag.classList.add("hidden");
    if (empty) empty.classList.remove("hidden");
  }

  function setQuestionEditorError(message) {
    var node = document.querySelector("[data-question-editor-error]");
    if (!node) return;
    node.textContent = message || "";
    node.classList.toggle("hidden", !message);
  }

  function setQuestionEditorNote(message) {
    var node = document.querySelector("[data-question-editor-note]");
    if (!node) return;
    node.textContent = message || "";
    node.classList.toggle("hidden", !message);
  }

  async function initQuestionFeedbackAdmin() {
    var root = document.querySelector("[data-question-feedback-admin]");
    if (!root) return;
    await loadQuestionFeedbackAdmin();
  }

  async function loadQuestionFeedbackAdmin() {
    var list = document.querySelector("[data-feedback-list]");
    try {
      var data = await api("/api/admin/question-feedback");
      var items = data.items || [];
      setText("[data-feedback-count]", items.length);
      renderQuestionFeedbackList(items);
    } catch {
      if (list) list.innerHTML = "<article class=\"panel\"><p class=\"muted\">Question feedback could not be loaded.</p></article>";
    }
  }

  function renderQuestionFeedbackList(items) {
    var list = document.querySelector("[data-feedback-list]");
    if (!list) return;
    if (!items.length) {
      list.innerHTML = "<article class=\"panel\"><div class=\"empty-state-inline\"><span class=\"empty-asset empty-asset--review-clear\" aria-hidden=\"true\"></span><p class=\"muted\">No bad or not-learnt votes are waiting for review.</p></div></article>";
      return;
    }
    list.innerHTML = items.map(function (item) {
      var voters = (item.voters || []).map(function (vote) {
        return "<span class=\"block-tag\">" + escapeHtml(vote.label) + " · " + escapeHtml(vote.username) + "</span>";
      }).join("");
      return "<article class=\"panel feedback-card\" data-feedback-item=\"" + escapeHtml(item.question_id) + "\">"
        + "<div class=\"feedback-card__head\">"
        + "<div><p class=\"section-label\">" + escapeHtml(item.question_id) + " · " + escapeHtml(item.block) + "</p><h2 class=\"panel-title\">" + escapeHtml(item.topic) + "</h2></div>"
        + "<div class=\"feedback-card__votes\"><span class=\"block-tag\">Bad " + (item.bad_count || 0) + "</span><span class=\"block-tag\">Not learnt " + (item.not_learnt_count || 0) + "</span></div>"
        + "</div>"
        + "<p class=\"question-preview\">" + escapeHtml(item.stem || "") + "</p>"
        + "<p class=\"muted question-preview\">" + escapeHtml(item.lead_in || "") + "</p>"
        + "<p class=\"muted\">Correct: <span class=\"answer-correct\">" + escapeHtml(item.correct_answer) + ". " + escapeHtml(item.correct_option || "") + "</span></p>"
        + "<div class=\"tag-list feedback-voters\">" + voters + "</div>"
        + "<div class=\"feedback-reply-form\">"
        + "<label>Admin reply<textarea data-feedback-reply rows=\"3\" placeholder=\"Example: This was covered in Lecture 12, slide 34. The tested idea is...\"></textarea></label>"
        + "<label>Lecture / source anchor<input data-feedback-source type=\"text\" maxlength=\"180\" placeholder=\"Lecture 12 · slide 34\"></label>"
        + "<p class=\"form-error hidden\" data-feedback-error></p>"
        + "</div>"
        + "<div class=\"feedback-actions\">"
        + "<button class=\"ghost-btn\" type=\"button\" data-feedback-action=\"keep\" data-question-id=\"" + escapeHtml(item.question_id) + "\">Reply and keep</button>"
        + "<button class=\"ghost-btn danger\" type=\"button\" data-feedback-action=\"delete\" data-question-id=\"" + escapeHtml(item.question_id) + "\">Delete</button>"
        + "</div>"
        + "</article>";
    }).join("");
    list.querySelectorAll("[data-feedback-action]").forEach(function (button) {
      button.addEventListener("click", function () {
        handleFeedbackAction(button);
      });
    });
  }

  async function handleFeedbackAction(button) {
    var questionId = button.dataset.questionId;
    var action = button.dataset.feedbackAction;
    if (!questionId || !action) return;
    var card = button.closest("[data-feedback-item]");
    var replyNode = card ? card.querySelector("[data-feedback-reply]") : null;
    var sourceNode = card ? card.querySelector("[data-feedback-source]") : null;
    var errorNode = card ? card.querySelector("[data-feedback-error]") : null;
    var reply = replyNode ? replyNode.value.trim() : "";
    var source = sourceNode ? sourceNode.value.trim() : "";
    if (errorNode) errorNode.classList.add("hidden");
    if (action === "keep" && !reply) {
      if (errorNode) {
        errorNode.textContent = "Add a reply or lecture citation before keeping this question.";
        errorNode.classList.remove("hidden");
      }
      if (replyNode) replyNode.focus();
      return;
    }
    if (action === "delete" && !window.confirm("Delete " + questionId + " from the live question bank? This also removes its attempts and review records.")) {
      return;
    }
    button.disabled = true;
    try {
      await api("/api/admin/question-feedback/" + encodeURIComponent(questionId) + "/" + action, {
        method: "POST",
        body: JSON.stringify({ reply: reply, source_anchor: source }),
      });
      if (card) card.remove();
      var remaining = document.querySelectorAll("[data-feedback-item]").length;
      setText("[data-feedback-count]", remaining);
      if (!remaining) {
        renderQuestionFeedbackList([]);
      }
    } catch (error) {
      if (errorNode) {
        errorNode.textContent = error.error || "This feedback could not be resolved.";
        errorNode.classList.remove("hidden");
      }
      button.disabled = false;
    }
  }

  async function initExam() {
    var root = document.querySelector("[data-exam]");
    if (!root) return;
    clearExamTimer();
    if (!state.authenticated) {
      showExamAuth();
      return;
    }
    hideExamAuth();
    bindExamControls();
    updateExamSetupControls();
    await loadExamFilterOptions();
    await updateExamCount();
    await loadExamHistory();
    var sessionId = root.dataset.sessionId || "";
    if (sessionId) await loadExamSession(sessionId);
  }

  function bindExamControls() {
    var form = document.querySelector("[data-exam-form]");
    if (form && !form.dataset.bound) {
      form.dataset.bound = "true";
      form.addEventListener("submit", createExam);
    }
    document.querySelectorAll("[data-exam-filter]").forEach(function (control) {
      if (control.dataset.bound) return;
      control.dataset.bound = "true";
      control.addEventListener("change", async function () {
        if (control.dataset.examFilter === "block") fillExamTopicOptions();
        await updateExamCount();
      });
    });
    document.querySelectorAll("[data-exam-range]").forEach(function (control) {
      if (control.dataset.bound) return;
      control.dataset.bound = "true";
      control.addEventListener("input", updateExamSetupControls);
      control.addEventListener("change", async function () {
        updateExamSetupControls();
        await updateExamCount();
      });
    });
    document.querySelectorAll("[data-exam-range-set]").forEach(function (button) {
      if (button.dataset.bound) return;
      button.dataset.bound = "true";
      button.addEventListener("click", async function () {
        var range = document.querySelector("[data-exam-range=\"" + button.dataset.examRangeSet + "\"]");
        if (!range) return;
        range.value = button.dataset.value || range.value;
        updateExamSetupControls();
        await updateExamCount();
      });
    });
    var prev = document.querySelector("[data-exam-prev]");
    var next = document.querySelector("[data-exam-next]");
    var submit = document.querySelector("[data-exam-submit]");
    if (prev && !prev.dataset.bound) {
      prev.dataset.bound = "true";
      prev.addEventListener("click", function () { moveExamQuestion(-1); });
    }
    if (next && !next.dataset.bound) {
      next.dataset.bound = "true";
      next.addEventListener("click", function () { moveExamQuestion(1); });
    }
    if (submit && !submit.dataset.bound) {
      submit.dataset.bound = "true";
      submit.addEventListener("click", submitExam);
    }
  }

  async function loadExamFilterOptions() {
    try {
      state.options = state.options || await api("/api/filter-options");
      fillExamSelect("block", state.options.blocks || [], "All blocks");
      fillExamSelect("tier", state.options.tiers || [], "All tiers", tierLabel);
      fillExamSelect("style", state.options.styles || [], "All styles");
      fillExamTopicOptions();
    } catch {
      state.options = { blocks: [], tiers: [], styles: [], topics_by_block: {} };
    }
  }

  function fillExamTopicOptions() {
    var block = examFilterValue("block");
    var data = state.options || { topics_by_block: {} };
    var topics = block ? data.topics_by_block[block] || [] : Object.values(data.topics_by_block || {}).flat();
    fillExamSelect("topic", Array.from(new Set(topics)).sort(), "All topics");
  }

  function fillExamSelect(name, items, label, formatter) {
    var select = document.querySelector("[data-exam-filter=\"" + name + "\"]");
    if (!select) return;
    var current = select.value;
    select.innerHTML = "<option value=\"\">" + label + "</option>" + items.map(function (item) {
      return "<option value=\"" + escapeHtml(item) + "\">" + escapeHtml(formatter ? formatter(item) : item) + "</option>";
    }).join("");
    if (current) select.value = current;
  }

  function examFilterValue(name) {
    var node = document.querySelector("[data-exam-filter=\"" + name + "\"]");
    return node ? node.value : "";
  }

  function examPayloadFromForm(form) {
    var formData = new FormData(form);
    var body = {
      question_count: Number(formData.get("question_count") || 10),
      minutes: Number(formData.get("minutes") || 15),
      mode: examFilterValue("mode") || "unanswered",
    };
    ["block", "topic", "tier", "style"].forEach(function (key) {
      var value = examFilterValue(key);
      if (value) body[key] = value;
    });
    return body;
  }

  function updateExamSetupControls() {
    var questionInput = document.querySelector("[data-exam-range=\"question_count\"]");
    var minuteInput = document.querySelector("[data-exam-range=\"minutes\"]");
    var questions = Number(questionInput && questionInput.value || 20);
    var minutes = Number(minuteInput && minuteInput.value || 30);
    setText("[data-exam-question-value]", questions + " " + plural(questions, "question", "questions"));
    setText("[data-exam-time-value]", minutes + " " + plural(minutes, "minute", "minutes"));
    document.querySelectorAll("[data-exam-range-set]").forEach(function (button) {
      var range = document.querySelector("[data-exam-range=\"" + button.dataset.examRangeSet + "\"]");
      button.classList.toggle("active", !!range && String(range.value) === String(button.dataset.value));
    });
    updateExamPaceNote(questions, minutes);
  }

  function updateExamPaceNote(questions, minutes) {
    var node = document.querySelector("[data-exam-pace-note]");
    if (!node || !questions || !minutes) return;
    var secondsPerQuestion = Math.round((minutes * 60) / questions);
    var delta = secondsPerQuestion - 90;
    var pace = "<strong>" + secondsPerQuestion + "s per question</strong>";
    var benchmark = "real exam pace is 1.5 min (90s) per question.";
    if (delta === 0) {
      node.innerHTML = pace + " · matches real exam pace.";
    } else if (delta > 0) {
      node.innerHTML = pace + " · " + delta + "s slower than the real exam; " + benchmark;
    } else {
      node.innerHTML = pace + " · " + Math.abs(delta) + "s faster than the real exam; " + benchmark;
    }
  }

  async function updateExamCount() {
    var form = document.querySelector("[data-exam-form]");
    if (!document.querySelector("[data-exam-count]") || !form || !state.authenticated) return;
    var params = new URLSearchParams(examPayloadFromForm(form));
    try {
      var data = await api("/api/exams/count?" + params.toString());
      setText("[data-exam-count]", formatNumber(data.count || 0));
      setText("[data-exam-count-label]", " questions available");
    } catch (error) {
      setText("[data-exam-count]", error && error.auth_required ? "Sign in" : 0);
      setText("[data-exam-count-label]", error && error.auth_required ? " to count questions" : " questions available");
    }
  }

  async function createExam(event) {
    event.preventDefault();
    setExamError("");
    try {
      var data = await api("/api/exams", {
        method: "POST",
        body: JSON.stringify(examPayloadFromForm(event.currentTarget)),
      });
      state.exam = data;
      state.examIndex = 0;
      navigateExamUrl(data.exam.id);
      renderExamActive(data);
    } catch (error) {
      setExamError(error.error || "This exam could not be created.");
    }
  }

  async function loadExamSession(sessionId) {
    try {
      var data = await api("/api/exams/" + encodeURIComponent(sessionId));
      state.exam = data;
      state.examIndex = 0;
      if (data.exam && data.exam.status === "completed") {
        renderExamSummary(data);
      } else {
        renderExamActive(data);
      }
    } catch (error) {
      setExamError(error.error || "This saved exam could not be loaded.");
    }
  }

  function renderExamActive(data) {
    toggleHidden("[data-exam-setup]", true);
    toggleHidden("[data-exam-summary]", true);
    toggleHidden("[data-exam-active]", false);
    var exam = data.exam || {};
    state.examStartedAt = exam.started_at ? Date.parse(exam.started_at) : Date.now();
    setText("[data-exam-title]", exam.title || "Timed paper");
    renderExamQuestion();
    startExamTimer();
  }

  function renderExamQuestion() {
    var data = state.exam || {};
    var questions = data.questions || [];
    if (!questions.length) return;
    state.examIndex = Math.max(0, Math.min(state.examIndex, questions.length - 1));
    var question = questions[state.examIndex];
    setText("[data-exam-progress]", "Question " + (state.examIndex + 1) + " of " + questions.length);
    var fill = document.querySelector("[data-exam-progress-fill]");
    if (fill) fill.style.width = ((state.examIndex + 1) / questions.length * 100) + "%";
    setHtml("[data-exam-stem]", formatInlineScienceHtml(question.stem || ""));
    setHtml("[data-exam-lead-in]", formatInlineScienceHtml(question.lead_in || ""));
    var options = document.querySelector("[data-exam-options]");
    if (options) {
      options.innerHTML = Object.entries(question.options || {}).filter(function (entry) {
        return entry[1];
      }).map(function (entry) {
        var key = entry[0];
        var active = question.chosen_answer === key ? " active" : "";
        return "<button class=\"opt" + active + "\" type=\"button\" data-exam-answer=\"" + escapeHtml(key) + "\"><span class=\"option-key\">" + escapeHtml(key) + ".</span><span class=\"option-copy\">" + formatInlineScienceHtml(entry[1]) + "</span></button>";
      }).join("");
      options.querySelectorAll("[data-exam-answer]").forEach(function (button) {
        button.addEventListener("click", function () {
          answerExamQuestion(button.dataset.examAnswer);
        });
      });
    }
    renderExamDots();
  }

  function renderExamDots() {
    var dots = document.querySelector("[data-exam-dots]");
    var data = state.exam || {};
    var questions = data.questions || [];
    if (!dots) return;
    dots.innerHTML = questions.map(function (question, index) {
      var classes = ["exam-dot"];
      if (index === state.examIndex) classes.push("active");
      if (question.chosen_answer) classes.push("answered");
      return "<button class=\"" + classes.join(" ") + "\" type=\"button\" data-exam-jump=\"" + index + "\">" + (index + 1) + "</button>";
    }).join("");
    dots.querySelectorAll("[data-exam-jump]").forEach(function (button) {
      button.addEventListener("click", function () {
        state.examIndex = Number(button.dataset.examJump || 0);
        renderExamQuestion();
      });
    });
  }

  async function answerExamQuestion(chosen) {
    var data = state.exam || {};
    var exam = data.exam || {};
    var question = (data.questions || [])[state.examIndex];
    if (!exam.id || !question || !chosen) return;
    question.chosen_answer = chosen;
    renderExamQuestion();
    try {
      await api("/api/exams/" + encodeURIComponent(exam.id) + "/answer", {
        method: "POST",
        body: JSON.stringify({
          question_id: question.question_id,
          chosen_answer: chosen,
          time_taken_seconds: examElapsedSeconds(),
        }),
      });
    } catch (error) {
      setExamError(error.error || "This answer could not be saved.");
    }
  }

  function moveExamQuestion(delta) {
    var questions = state.exam && state.exam.questions ? state.exam.questions : [];
    if (!questions.length) return;
    state.examIndex = Math.max(0, Math.min(questions.length - 1, state.examIndex + delta));
    renderExamQuestion();
  }

  async function submitExam(force) {
    var exam = state.exam && state.exam.exam ? state.exam.exam : {};
    if (!exam.id || state.examSubmitting) return;
    var unanswered = (state.exam.questions || []).filter(function (question) { return !question.chosen_answer; }).length;
    if (!force && unanswered && !window.confirm("Submit with " + unanswered + " unanswered " + plural(unanswered, "question", "questions") + "?")) return;
    state.examSubmitting = true;
    try {
      var data = await api("/api/exams/" + encodeURIComponent(exam.id) + "/submit", { method: "POST" });
      state.exam = data;
      clearExamTimer();
      renderExamSummary(data);
      await refreshSession();
      await loadExamHistory();
    } catch (error) {
      setExamError(error.error || "This exam could not be submitted.");
    } finally {
      state.examSubmitting = false;
    }
  }

  function renderExamSummary(data) {
    toggleHidden("[data-exam-setup]", true);
    toggleHidden("[data-exam-active]", true);
    toggleHidden("[data-exam-summary]", false);
    var exam = data.exam || {};
    setText("[data-exam-summary-title]", exam.title || "Exam complete");
    setText("[data-exam-score]", (exam.score_percent || 0) + "%");
    setText("[data-exam-correct]", (exam.correct_count || 0) + "/" + (exam.question_count || 0));
    setText("[data-exam-answered]", exam.answered_count || 0);
    var list = document.querySelector("[data-exam-review-list]");
    if (!list) return;
    list.innerHTML = (data.questions || []).map(function (question) {
      var result = question.is_correct ? "Correct" : "Missed";
      var chosen = question.chosen_answer || "—";
      var correct = question.correct_answer || "—";
      return "<details class=\"exam-review-item\"><summary><span class=\"mono\">Q" + escapeHtml(question.position || "") + "</span><strong>" + escapeHtml(result) + "</strong><span>Yours " + escapeHtml(chosen) + " · Answer " + escapeHtml(correct) + "</span></summary>"
        + "<div class=\"question-text\"><p>" + formatInlineScienceHtml(question.stem || "") + "</p><p class=\"lead-in\">" + formatInlineScienceHtml(question.lead_in || "") + "</p></div>"
        + "<div class=\"exam-review-options\">" + examReviewOptionsHtml(question) + "</div>"
        + "<div class=\"explanation open\"><p class=\"explanation__label\">Explanation</p>" + examExplanationHtml(question) + examTrapHtml(question)
        + "<div class=\"review-actions\" style=\"margin-top: 16px;\">"
        + "<button class=\"review-btn\" type=\"button\" data-question-vote=\"good\" data-question-id=\"" + escapeHtml(question.question_id || "") + "\">Good</button>"
        + "<button class=\"review-btn\" type=\"button\" data-question-vote=\"bad\" data-question-id=\"" + escapeHtml(question.question_id || "") + "\">Bad</button>"
        + "<button class=\"review-btn\" type=\"button\" data-question-vote=\"not_learnt\" data-question-id=\"" + escapeHtml(question.question_id || "") + "\">Not learnt</button>"
        + "</div>"
        + "<p class=\"muted hidden\" data-question-vote-result style=\"margin-top: 8px;\"></p>"
        + "</div></details>";
    }).join("");
  }

  function examReviewOptionsHtml(question) {
    return Object.entries(question.options || {}).filter(function (entry) {
      return entry[1];
    }).map(function (entry) {
      var key = entry[0];
      var classes = ["opt"];
      if (key === question.correct_answer) classes.push("is-correct");
      if (key === question.chosen_answer && key !== question.correct_answer) classes.push("is-wrong");
      if (key !== question.correct_answer && key !== question.chosen_answer) classes.push("is-muted");
      return "<div class=\"" + classes.join(" ") + "\"><span class=\"option-key\">" + escapeHtml(key) + ".</span><span class=\"option-copy\">" + formatInlineScienceHtml(entry[1]) + "</span></div>";
    }).join("");
  }

  function examExplanationHtml(question) {
    var optionText = question.options ? question.options[question.correct_answer] : "";
    var detail = stripOptionReference(question.explanation || "No explanation was recorded.", optionText);
    return optionReferenceHtmlForQuestion(question.correct_answer, optionText, detail);
  }

  function examTrapHtml(question) {
    if (!question.top_distractor && !question.why_distractor_wrong) return "";
    var key = findOptionKeyInQuestion(question, question.top_distractor);
    var optionText = key ? question.options[key] : stripLeadingOptionLetter(question.top_distractor || "");
    var detail = question.why_distractor_wrong || "";
    return "<div class=\"trap\"><p class=\"trap__label\">Common trap</p>" + optionReferenceHtmlForQuestion(key, optionText, detail) + "</div>";
  }

  function optionReferenceHtmlForQuestion(key, optionText, detail) {
    var prefix = key ? "<span class=\"answer-reference__key\">" + escapeHtml(key) + ".</span>" : "";
    var text = optionText ? "<span class=\"answer-reference__text\">" + formatInlineScienceHtml(optionText) + "</span>" : "";
    var body = detail ? "<span class=\"answer-reference__detail\">" + formatInlineScienceHtml(stripOptionReference(detail, optionText)) + "</span>" : "";
    return "<p><span class=\"answer-reference\">" + prefix + text + "</span>" + (body ? " " + body : "") + "</p>";
  }

  function findOptionKeyInQuestion(question, value) {
    var stripped = stripLeadingOptionLetter(value || "").trim().toLowerCase();
    var match = Object.entries(question.options || {}).find(function (entry) {
      return String(entry[1] || "").trim().toLowerCase() === stripped;
    });
    return match ? match[0] : "";
  }

  async function loadExamHistory() {
    var target = document.querySelector("[data-exam-history]");
    if (!target || !state.authenticated) return;
    try {
      var data = await api("/api/exams");
      var exams = data.exams || [];
      if (!exams.length) {
        target.innerHTML = "<p class=\"muted\">No saved exams yet.</p>";
        return;
      }
      target.innerHTML = exams.map(function (exam) {
        var score = exam.status === "completed" ? (exam.score_percent || 0) + "%" : "In progress";
        return "<a class=\"exam-history-item\" href=\"/exam/" + escapeHtml(exam.id) + "\"><strong>" + escapeHtml(exam.title || "Exam") + "</strong><span>" + escapeHtml(score) + " · " + escapeHtml(exam.question_count || 0) + " questions · " + escapeHtml(formatDateTime(exam.started_at)) + "</span></a>";
      }).join("");
    } catch {
      target.innerHTML = "<p class=\"muted\">Saved exams could not be loaded.</p>";
    }
  }

  function startExamTimer() {
    clearExamTimer();
    updateExamTimer();
    state.examTimer = window.setInterval(updateExamTimer, 1000);
  }

  function clearExamTimer() {
    if (state.examTimer) window.clearInterval(state.examTimer);
    state.examTimer = null;
  }

  function updateExamTimer() {
    var exam = state.exam && state.exam.exam ? state.exam.exam : {};
    if (!exam.minutes || !state.examStartedAt) return;
    var total = exam.minutes * 60;
    var remaining = Math.max(0, total - examElapsedSeconds());
    setText("[data-exam-timer]", formatDuration(remaining));
    if (remaining <= 0) {
      clearExamTimer();
      submitExam(true);
    }
  }

  function examElapsedSeconds() {
    if (!state.examStartedAt) return 0;
    return Math.max(0, Math.round((Date.now() - state.examStartedAt) / 1000));
  }

  function formatDuration(seconds) {
    var minutes = Math.floor(seconds / 60);
    var remainder = seconds % 60;
    return minutes + ":" + String(remainder).padStart(2, "0");
  }

  function navigateExamUrl(id) {
    if (!id) return;
    window.history.replaceState({}, "", "/exam/" + id);
    var root = document.querySelector("[data-exam]");
    if (root) root.dataset.sessionId = id;
  }

  function showExamAuth() {
    toggleHidden("[data-exam-auth]", false);
    toggleHidden("[data-exam-setup]", true);
    toggleHidden("[data-exam-active]", true);
    toggleHidden("[data-exam-summary]", true);
    toggleHidden("[data-exam-history-panel]", true);
  }

  function hideExamAuth() {
    toggleHidden("[data-exam-auth]", true);
    toggleHidden("[data-exam-setup]", false);
    toggleHidden("[data-exam-history-panel]", false);
  }

  function setExamError(message) {
    var node = document.querySelector("[data-exam-error]");
    if (!node) return;
    node.textContent = message || "";
    node.classList.toggle("hidden", !message);
  }

  async function initDuel() {
    var root = document.querySelector("[data-duel]");
    if (!root) return;
    clearDuelPoll();
    clearDuelRoomsPoll();
    state.duelCode = root.dataset.inviteCode || "";
    if (!state.authenticated) {
      setDuelSeasonVisible(false);
      showDuelAuth();
      return;
    }
    setDuelSeasonVisible(!state.duelCode);
    hideDuelAuth();
    await loadDuelFilterOptions();
    bindDuelControls();
    await loadDuelSeason();
    if (state.duelCode) {
      await loadDuelState();
    } else {
      showDuelPanel("create");
      updateDuelCreateLabel();
      await loadOpenDuelRooms();
      scheduleDuelRoomsPoll();
    }
  }

  async function loadDuelSeason() {
    var root = document.querySelector("[data-duel-season]");
    if (!root || !state.authenticated) return;
    try {
      var data = await api("/api/duels/season");
      renderDuelSeason(data);
    } catch {
      var board = document.querySelector("[data-duel-season-board]");
      if (board) board.innerHTML = "<p class=\"muted\">Arena standings could not be loaded.</p>";
    }
  }

  function renderDuelSeason(data) {
    var season = data.season || {};
    var viewer = data.viewer || {};
    var rows = data.leaderboard || [];
    setText("[data-duel-season-label]", season.label || "Arena Season");
    setText("[data-duel-season-rank]", viewer.rank ? "#" + viewer.rank : "--");
    setText("[data-duel-season-points]", formatNumber(viewer.arena_points || 0));
    setText("[data-duel-season-record]", (viewer.wins || 0) + "W-" + (viewer.losses || 0) + "L-" + (viewer.draws || 0) + "D");
    setText("[data-duel-season-streak]", viewer.streak || 0);
    var board = document.querySelector("[data-duel-season-board]");
    if (!board) return;
    if (!rows.length) {
      board.innerHTML = "<p class=\"muted\">No ranked duels this season yet.</p>";
      return;
    }
    board.innerHTML = "<table class=\"data-table arena-season-table\"><thead><tr><th>Rank</th><th>Scholar</th><th>AP</th><th>Record</th><th>Accuracy</th></tr></thead><tbody>" + rows.map(function (row) {
      var record = (row.wins || 0) + "-" + (row.losses || 0) + "-" + (row.draws || 0);
      var active = state.user && row.user_id === state.user.id ? " class=\"is-viewer\"" : "";
      return "<tr" + active + "><td class=\"mono\">#" + escapeHtml(row.rank || "") + "</td><td>" + escapeHtml(row.username || "Scholar") + "</td><td class=\"mono\">" + escapeHtml(row.arena_points || 0) + "</td><td>" + escapeHtml(record) + "</td><td>" + escapeHtml(row.accuracy || 0) + "%</td></tr>";
    }).join("") + "</tbody></table>";
  }

  function setDuelSeasonVisible(visible) {
    toggleHidden("[data-duel-season]", !visible);
  }

  function bindDuelControls() {
    var form = document.querySelector("[data-duel-form]");
    if (form && !form.dataset.bound) {
      form.dataset.bound = "true";
      form.addEventListener("submit", createDuel);
    }
    var join = document.querySelector("[data-duel-join]");
    if (join && !join.dataset.bound) {
      join.dataset.bound = "true";
      join.addEventListener("click", joinDuel);
    }
    var ready = document.querySelector("[data-duel-ready]");
    var next = document.querySelector("[data-duel-next]");
    var cancel = document.querySelector("[data-duel-cancel]");
    if (ready && !ready.dataset.bound) {
      ready.dataset.bound = "true";
      ready.addEventListener("click", readyDuel);
    }
    if (next && !next.dataset.bound) {
      next.dataset.bound = "true";
      next.addEventListener("click", nextDuelRound);
    }
    if (cancel && !cancel.dataset.bound) {
      cancel.dataset.bound = "true";
      cancel.addEventListener("click", cancelDuel);
    }
    var copy = document.querySelector("[data-duel-copy]");
    if (copy && !copy.dataset.bound) {
      copy.dataset.bound = "true";
      copy.addEventListener("click", copyDuelInvite);
    }
    var refreshRooms = document.querySelector("[data-duel-refresh-rooms]");
    if (refreshRooms && !refreshRooms.dataset.bound) {
      refreshRooms.dataset.bound = "true";
      refreshRooms.addEventListener("click", loadOpenDuelRooms);
    }
    var roomList = document.querySelector("[data-duel-open-rooms]");
    if (roomList && !roomList.dataset.bound) {
      roomList.dataset.bound = "true";
      roomList.addEventListener("click", function (event) {
        var remove = event.target.closest ? event.target.closest("[data-duel-room-remove]") : null;
        if (remove) {
          cancelOpenDuelRoom(remove.dataset.duelRoomRemove);
          return;
        }
        var button = event.target.closest ? event.target.closest("[data-duel-room-join]") : null;
        if (!button) return;
        joinOpenDuelRoom(button.dataset.duelRoomJoin);
      });
    }
    document.querySelectorAll("input[name=\"visibility\"]").forEach(function (control) {
      if (control.dataset.bound) return;
      control.dataset.bound = "true";
      control.addEventListener("change", updateDuelCreateLabel);
    });
    document.querySelectorAll("[data-duel-filter]").forEach(function (control) {
      if (control.dataset.bound) return;
      control.dataset.bound = "true";
      control.addEventListener("change", function () {
        if (control.dataset.duelFilter === "block") {
          fillDuelTopicOptions();
        }
      });
    });
    bindQuestionVoteControls();
  }

  async function loadDuelFilterOptions() {
    try {
      state.options = state.options || await api("/api/filter-options");
      fillDuelSelect("block", state.options.blocks || [], "All blocks");
      fillDuelSelect("tier", state.options.tiers || [], "All tiers", tierLabel);
      fillDuelSelect("style", state.options.styles || [], "All styles");
      fillDuelTopicOptions();
    } catch {}
  }

  function fillDuelTopicOptions() {
    var block = duelFilterValue("block");
    var data = state.options || { topics_by_block: {} };
    var topics = block ? data.topics_by_block[block] || [] : Object.values(data.topics_by_block || {}).flat();
    fillDuelSelect("topic", Array.from(new Set(topics)).sort(), "All topics");
  }

  function fillDuelSelect(name, items, label, formatter) {
    var select = document.querySelector("[data-duel-filter=\"" + name + "\"]");
    if (!select) return;
    var current = select.value;
    select.innerHTML = "<option value=\"\">" + label + "</option>" + items.map(function (item) {
      return "<option value=\"" + escapeHtml(item) + "\">" + escapeHtml(formatter ? formatter(item) : item) + "</option>";
    }).join("");
    if (current) select.value = current;
  }

  function duelFilterValue(name) {
    var node = document.querySelector("[data-duel-filter=\"" + name + "\"]");
    return node ? node.value : "";
  }

  function duelPayloadFromForm(form) {
    var formData = new FormData(form);
    var body = {
      question_count: Number(formData.get("question_count") || 5),
      seconds_per_question: Number(formData.get("seconds_per_question") || 30),
      visibility: formData.get("visibility") || "private",
    };
    ["block", "topic", "tier", "style", "mode"].forEach(function (key) {
      var value = duelFilterValue(key);
      if (value) body[key] = value;
    });
    return body;
  }

  function selectedDuelVisibility() {
    var selected = document.querySelector("input[name=\"visibility\"]:checked");
    return selected ? selected.value : "private";
  }

  function updateDuelCreateLabel() {
    var label = document.querySelector("[data-duel-create-label]");
    if (!label) return;
    label.textContent = selectedDuelVisibility() === "public" ? "Create open room" : "Create private invite";
  }

  async function createDuel(event) {
    event.preventDefault();
    setDuelError("");
    try {
      var data = await api("/api/duels", {
        method: "POST",
        body: JSON.stringify(duelPayloadFromForm(event.currentTarget)),
      });
      state.duelCode = data.duel.invite_code;
      window.history.replaceState({}, "", "/duel/" + state.duelCode);
      renderDuelState(data);
    } catch (error) {
      setDuelError(error.error || "The duel could not be created.");
    }
  }

  async function loadDuelState() {
    if (!state.duelCode) return;
    try {
      var data = await api("/api/duels/" + encodeURIComponent(state.duelCode) + "/state");
      renderDuelState(data);
    } catch (error) {
      setDuelError(error.error || "This duel could not be loaded.");
      showDuelPanel("create");
    }
  }

  async function joinDuel() {
    if (!state.duelCode) return;
    setDuelError("");
    try {
      var data = await api("/api/duels/" + encodeURIComponent(state.duelCode) + "/join", { method: "POST" });
      renderDuelState(data);
    } catch (error) {
      setDuelError(error.error || "The duel could not be joined.");
    }
  }

  async function joinOpenDuelRoom(code) {
    if (!code) return;
    state.duelCode = code;
    window.history.replaceState({}, "", "/duel/" + state.duelCode);
    clearDuelRoomsPoll();
    await joinDuel();
  }

  async function cancelOpenDuelRoom(code) {
    if (!code) return;
    if (!window.confirm("Remove this open lobby? It will disappear from the room list.")) return;
    try {
      await api("/api/duels/" + encodeURIComponent(code) + "/cancel", { method: "POST" });
      await loadOpenDuelRooms();
    } catch (error) {
      setDuelError(error.error || "This lobby could not be removed.");
    }
  }

  async function loadOpenDuelRooms() {
    var target = document.querySelector("[data-duel-open-rooms]");
    if (!target || !state.authenticated) return;
    try {
      var data = await api("/api/duels/open");
      renderOpenDuelRooms(data.duels || []);
    } catch (error) {
      target.innerHTML = "<article class=\"duel-room duel-room-empty\">Open rooms could not be loaded.</article>";
    }
  }

  function renderOpenDuelRooms(rooms) {
    var target = document.querySelector("[data-duel-open-rooms]");
    if (!target) return;
    if (!rooms.length) {
      target.innerHTML = "<article class=\"duel-room duel-room-empty\">No open rooms waiting.</article>";
      return;
    }
    target.innerHTML = rooms.map(function (room) {
      var creator = room.creator || {};
      var isMine = state.user && creator.id === state.user.id;
      var action = isMine
        ? "<div class=\"duel-room__actions\"><button class=\"ghost-btn\" type=\"button\" data-duel-room-join=\"" + escapeHtml(room.invite_code) + "\">Return</button><button class=\"ghost-btn danger\" type=\"button\" data-duel-room-remove=\"" + escapeHtml(room.invite_code) + "\">Remove</button></div>"
        : "<button class=\"next-action__button\" type=\"button\" data-duel-room-join=\"" + escapeHtml(room.invite_code) + "\">Join</button>";
      if (room.room_full && !isMine) action = "<button class=\"ghost-btn\" type=\"button\" disabled>Full</button>";
      return "<article class=\"duel-room\"><div><span class=\"section-label\">Open room</span><strong>" + escapeHtml(creator.username || "Scholar") + "</strong><small class=\"muted\">" + escapeHtml(creator.level_display || "") + "</small></div><div><span>" + escapeHtml(room.player_count || 1) + "/" + escapeHtml(room.max_players || 2) + " scholars · " + escapeHtml(room.question_count || 5) + " questions · " + escapeHtml(room.seconds_per_question || 30) + "s</span><small class=\"muted\">" + escapeHtml(room.filter_summary || "All questions") + "</small></div>" + action + "</article>";
    }).join("");
  }

  async function readyDuel() {
    if (!state.duelCode) return;
    setDuelError("");
    var button = document.querySelector("[data-duel-ready]");
    if (button) button.disabled = true;
    try {
      var data = await api("/api/duels/" + encodeURIComponent(state.duelCode) + "/ready", { method: "POST" });
      renderDuelState(data);
    } catch (error) {
      if (button) button.disabled = false;
      setDuelError(error.error || "The duel could not be readied.");
    }
  }

  async function cancelDuel() {
    if (!state.duelCode) return;
    if (!window.confirm("Remove this lobby? Other scholars will no longer be able to join it.")) return;
    var button = document.querySelector("[data-duel-cancel]");
    if (button) button.disabled = true;
    try {
      await api("/api/duels/" + encodeURIComponent(state.duelCode) + "/cancel", { method: "POST" });
      state.duelCode = "";
      clearDuelPoll();
      window.history.replaceState({}, "", "/duel");
      showDuelPanel("create");
      updateDuelCreateLabel();
      await loadOpenDuelRooms();
      scheduleDuelRoomsPoll();
    } catch (error) {
      setDuelError(error.error || "This lobby could not be removed.");
      if (button) button.disabled = false;
    }
  }

  async function nextDuelRound() {
    if (!state.duelCode) return;
    var button = document.querySelector("[data-duel-next]");
    if (button) button.disabled = true;
    try {
      var data = await api("/api/duels/" + encodeURIComponent(state.duelCode) + "/next", { method: "POST" });
      renderDuelState(data);
    } catch {
      if (button) button.disabled = false;
    }
  }

  async function answerDuel(button) {
    if (!state.duelCode || button.disabled) return;
    var chosen = button.dataset.duelAnswer;
    document.querySelectorAll("[data-duel-answer]").forEach(function (item) {
      item.disabled = true;
    });
    try {
      var data = await api("/api/duels/" + encodeURIComponent(state.duelCode) + "/answer", {
        method: "POST",
        body: JSON.stringify({ chosen_answer: chosen }),
      });
      renderDuelState(data);
    } catch {}
  }

  function renderDuelState(data) {
    var duel = data.duel || {};
    if (!["active", "reveal"].includes(duel.status)) {
      state.renderedDuelQuestionId = "";
    }
    state.duelCode = duel.invite_code || state.duelCode;
    setValue("[data-duel-invite]", duel.invite_url || "");
    setText("[data-duel-status]", duelStatusLabel(duel.status));
    var isPublic = duel.visibility === "public";
    setText("[data-duel-lobby-kicker]", isPublic ? "Open room" : "Private invite");
    toggleHidden("[data-duel-invite-row]", isPublic);
    renderDuelPlayers(data.players || compactPlayers(duel));

    if (duel.status === "cancelled") {
      setDuelSeasonVisible(true);
      showDuelPanel("lobby");
      setText("[data-duel-lobby-title]", "Lobby removed");
      setText("[data-duel-lobby-copy]", "This duel lobby is no longer open.");
      toggleHidden("[data-duel-join]", true);
      toggleHidden("[data-duel-ready]", true);
      toggleHidden("[data-duel-cancel]", true);
      scheduleDuelPoll(duel.status);
      return;
    }

    if (data.viewer_role === "observer") {
      setDuelSeasonVisible(true);
      showDuelPanel("lobby");
      setText("[data-duel-lobby-title]", "Join this duel");
      setText("[data-duel-lobby-copy]", "Aesculon will lock a fair shared unseen set once you join.");
      toggleHidden("[data-duel-join]", !!duel.room_full || !["waiting", "ready"].includes(duel.status));
      toggleHidden("[data-duel-ready]", true);
      toggleHidden("[data-duel-cancel]", true);
      scheduleDuelPoll(duel.status);
      return;
    }

    if (duel.status === "waiting" || duel.status === "ready") {
      setDuelSeasonVisible(true);
      showDuelPanel("lobby");
      setText("[data-duel-lobby-title]", duel.status === "waiting" ? "Waiting for scholars" : "Ready the Arena");
      setText("[data-duel-lobby-copy]", duel.status === "waiting" ? (isPublic ? "This room is visible in the open lobby." : "Send this link to invite scholars.") : "Every scholar in the room must ready up before the first question.");
      toggleHidden("[data-duel-join]", true);
      var player = (data.players || []).find(function (item) { return item.role === data.viewer_role; });
      var readyButton = document.querySelector("[data-duel-ready]");
      toggleHidden("[data-duel-ready]", duel.status !== "ready");
      toggleHidden("[data-duel-cancel]", data.viewer_role !== "creator");
      if (readyButton) {
        readyButton.disabled = !!(player && player.ready);
        readyButton.textContent = player && player.ready ? "Ready" : "Ready";
      }
    } else if (duel.status === "active" || duel.status === "reveal") {
      setDuelSeasonVisible(false);
      toggleHidden("[data-duel-cancel]", true);
      showDuelPanel("live");
      renderDuelRound(data);
    } else if (duel.status === "completed") {
      setDuelSeasonVisible(false);
      toggleHidden("[data-duel-cancel]", true);
      showDuelPanel("results");
      renderDuelResults(data);
      loadDuelSeason();
    }
    scheduleDuelPoll(duel.status);
  }

  function renderDuelRound(data) {
    var round = data.round || {};
    var question = round.question || {};
    state.currentQuestion = question;
    state.optionDisplayByAnswer = { A: "A", B: "B", C: "C", D: "D", E: "E" };
    setText("[data-duel-round-label]", "Question " + (round.position || 1) + " of " + (round.total || 1));
    setText("[data-duel-phase]", round.status === "reveal" ? "Reveal" : (round.viewer_answer ? "Waiting for the room" : "Answer now"));
    setText("[data-duel-timer]", round.status === "active" ? (round.seconds_remaining || 0) + "s" : "Reveal");
    updateDuelTimerBar(round);
    renderDuelScoreRow(data.players || []);
    
    var questionId = question.question_id || "";
    var questionChanged = (state.renderedDuelQuestionId !== questionId);
    
    if (questionChanged) {
      state.renderedDuelQuestionId = questionId;
      var duelStem = document.querySelector("[data-duel-stem]");
      var duelLead = document.querySelector("[data-duel-lead-in]");
      if (duelStem) duelStem.innerHTML = formatInlineScienceHtml(question.stem || "");
      if (duelLead) duelLead.innerHTML = formatInlineScienceHtml(question.lead_in || "");
      var options = document.querySelector("[data-duel-options]");
      if (options) {
        options.innerHTML = Object.entries(question.options || {}).filter(function (entry) {
          return entry[1];
        }).map(function (entry) {
          return "<button class=\"opt\" type=\"button\" data-duel-answer=\"" + escapeHtml(entry[0]) + "\"><span class=\"option-key\">" + escapeHtml(entry[0]) + ".</span><span class=\"option-copy\">" + formatInlineScienceHtml(entry[1]) + "</span></button>";
        }).join("");
        options.querySelectorAll("[data-duel-answer]").forEach(function (button) {
          button.addEventListener("click", function () { answerDuel(button); });
        });
      }
    }
    
    var options = document.querySelector("[data-duel-options]");
    if (options) {
      options.querySelectorAll("[data-duel-answer]").forEach(function (button) {
        button.disabled = !!round.viewer_answer || round.status !== "active";
      });
    }
    if (round.viewer_answer) paintDuelOptions(round.viewer_answer.chosen_answer, question.correct_answer, round.status === "reveal");
    var explanation = document.querySelector("[data-duel-explanation]");
    if (round.status === "reveal") {
      paintDuelOptions(round.viewer_answer && round.viewer_answer.chosen_answer, question.correct_answer, true);
      setHtml("[data-duel-explanation-body]", duelExplanationHtml(question));
      renderDuelTrap(question);
      showQuestionFeedback("[data-duel-question-feedback]");
      setText("[data-duel-opponent-status]", round.answers_locked ? "All answers are locked. Review the explanation, then advance together." : "Time expired before every answer arrived.");
      renderDuelNextState(round);
      if (explanation) {
        explanation.classList.remove("hidden");
        explanation.classList.add("open");
      }
    } else if (explanation) {
      explanation.classList.add("hidden");
      explanation.classList.remove("open");
      toggleHidden("[data-duel-trap]", true);
      toggleHidden("[data-duel-question-feedback]", true);
    }
  }

  function renderDuelTrap(question) {
    var trap = document.querySelector("[data-duel-trap]");
    var trapCopy = trapExplanationHtml(question || {});
    if (!trap) return;
    if (trapCopy) {
      setHtml("[data-duel-trap-body]", trapCopy);
      trap.classList.remove("hidden");
    } else {
      trap.classList.add("hidden");
    }
  }

  function renderDuelNextState(round) {
    var button = document.querySelector("[data-duel-next]");
    var status = document.querySelector("[data-duel-next-status]");
    var ready = Number(round.advance_count || 0);
    var total = Number(round.participant_count || 0);
    if (button) {
      button.disabled = !!round.viewer_ready;
      button.textContent = round.viewer_ready ? "Waiting for room" : (round.position >= round.total ? "Finish duel" : "Next question");
    }
    if (status) {
      status.textContent = ready + " of " + total + " ready";
    }
  }

  function paintDuelOptions(chosen, correctAnswer, reveal) {
    document.querySelectorAll("[data-duel-answer]").forEach(function (item) {
      item.classList.toggle("is-correct", !!reveal && item.dataset.duelAnswer === correctAnswer);
      item.classList.toggle("is-locked", !!chosen && !reveal && item.dataset.duelAnswer === chosen);
      item.classList.toggle("is-wrong", !!reveal && !!chosen && item.dataset.duelAnswer === chosen && chosen !== correctAnswer);
      item.classList.toggle("is-muted", !!reveal && item.dataset.duelAnswer !== correctAnswer && item.dataset.duelAnswer !== chosen);
    });
  }

  function updateDuelTimerBar(round) {
    var bar = document.querySelector("[data-duel-timer-bar]");
    if (!bar) return;
    var total = Number(round.seconds_per_question || 30);
    var remaining = Number(round.seconds_remaining || 0);
    var pct = round.status === "active" ? Math.max(0, Math.min(100, (remaining / Math.max(1, total)) * 100)) : 100;
    var timerKey = [round.position || 1, round.total || 1, round.status, total].join(":");
    if (round.status !== "active") {
      state.duelTimerKey = "";
      bar.style.transition = "none";
      bar.style.width = pct + "%";
    } else if (state.duelTimerKey !== timerKey) {
      state.duelTimerKey = timerKey;
      bar.style.transition = "none";
      bar.style.width = pct + "%";
      bar.offsetWidth;
      bar.style.transition = "width " + Math.max(0.1, remaining) + "s linear, background 220ms ease";
      bar.style.width = "0%";
    }
    bar.classList.toggle("is-low", round.status === "active" && remaining <= 5);
  }

  function duelExplanationHtml(question) {
    var key = question.correct_answer;
    var optionText = question.options && key ? question.options[key] : "";
    var detail = stripOptionReference(remapSeededOptionLetters(question.explanation || "No explanation was recorded."), optionText);
    return optionReferenceHtml(key, optionText, detail);
  }

  function renderDuelScoreRow(players) {
    var target = document.querySelector("[data-duel-score-row]");
    if (!target) return;
    target.innerHTML = players.map(function (player) {
      return "<span><strong>" + escapeHtml(player.username || "Scholar") + "</strong><br><span class=\"mono\">" + (player.score || 0) + " pts · " + (player.correct || 0) + " correct</span></span>";
    }).join("");
  }

  function renderDuelResults(data) {
    var results = data.results || {};
    var players = results.players || [];
    var viewer = data.viewer || {};
    var winner = players.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); })[0];
    setText("[data-duel-result-title]", winner ? winner.username + " takes the Arena" : "Duel complete");
    var grid = document.querySelector("[data-duel-result-grid]");
    if (grid) {
      grid.innerHTML = players.map(function (player) {
        var weak = player.weakest_topic ? "<br><span class=\"muted\">Weakest: " + escapeHtml(player.weakest_topic.label) + "</span>" : "";
        return "<article class=\"metric\"><span>" + escapeHtml(player.username) + "</span><strong>" + (player.score || 0) + "</strong><p class=\"muted\">" + player.correct + "/" + player.total + " correct · " + player.avg_time + "s avg" + weak + "</p></article>";
      }).join("");
    }
    var insights = results.insights || {};
    var insightNode = document.querySelector("[data-duel-insights]");
    if (insightNode) {
      insightNode.innerHTML = "<span class=\"block-tag\">Everyone missed " + (insights.shared_misses || 0) + "</span><span class=\"block-tag\">Only you knew " + (insights.viewer_only || 0) + "</span><span class=\"block-tag\">Only others knew " + (insights.opponent_only || 0) + "</span>";
    }
    renderDuelSeasonAwards(results.season_awards || null, viewer.id);
    renderDuelBreakdown(results.rows || [], viewer.id, players);
  }

  function renderDuelSeasonAwards(awards, viewerId) {
    var target = document.querySelector("[data-duel-season-awards]");
    if (!target) return;
    if (!awards || !awards.players || !awards.players.length) {
      target.classList.add("hidden");
      target.innerHTML = "";
      return;
    }
    var viewerAward = awards.players.find(function (item) { return item.user_id === viewerId; }) || awards.players[0];
    var label = awards.season && awards.season.label ? awards.season.label : "Arena Season";
    target.innerHTML = "<span class=\"section-label\">" + escapeHtml(label) + "</span><strong>+" + escapeHtml(viewerAward.arena_points || 0) + " AP</strong><p class=\"muted\">" + escapeHtml(outcomeLabel(viewerAward.outcome)) + " · " + escapeHtml(viewerAward.duel_score || 0) + " duel points</p>";
    target.classList.remove("hidden");
  }

  function outcomeLabel(outcome) {
    return {
      win: "Victory recorded",
      loss: "Arena effort recorded",
      draw: "Draw recorded",
    }[outcome] || "Arena result recorded";
  }

  function renderDuelBreakdown(rows, viewerId, players) {
    var body = document.querySelector("[data-duel-breakdown]");
    if (!body) return;
    var orderedPlayers = (players || []).slice().sort(function (a, b) {
      if (a.id === viewerId) return -1;
      if (b.id === viewerId) return 1;
      return (b.score || 0) - (a.score || 0);
    });
    var head = document.querySelector("[data-duel-breakdown-head]");
    if (head) {
      head.innerHTML = "<th>Q</th><th>Topic</th>" + orderedPlayers.map(function (player) {
        return "<th>" + escapeHtml(player.id === viewerId ? "You" : player.username) + "</th>";
      }).join("") + "<th>Answer</th>";
    }
    body.innerHTML = rows.map(function (row) {
      var playerCells = orderedPlayers.map(function (player) {
        var answer = row.players && row.players[String(player.id)];
        return "<td>" + duelAnswerMark(answer) + "</td>";
      }).join("");
      return "<tr><td class=\"mono\">" + row.position + "</td><td>" + escapeHtml(row.topic) + "<br><small class=\"muted\">" + escapeHtml(row.block) + "</small></td>" + playerCells + "<td>" + escapeHtml(row.correct_answer + ". " + (row.correct_option || "")) + "</td></tr>";
    }).join("");
  }

  function duelAnswerMark(answer) {
    if (!answer || !answer.chosen_answer) return "<span class=\"muted\">No answer</span>";
    return "<span class=\"" + (answer.correct ? "answer-correct" : "answer-wrong") + "\">" + escapeHtml(answer.chosen_answer) + "</span><br><small class=\"muted\">" + answer.score + " pts · " + answer.time_taken_seconds + "s</small>";
  }

  function renderDuelPlayers(players) {
    var target = document.querySelector("[data-duel-players]");
    if (!target) return;
    target.innerHTML = (players || []).map(function (player) {
      return "<article class=\"duel-player\"><span>" + escapeHtml(player.role || "scholar") + "</span><strong>" + escapeHtml(player.username || "Waiting") + "</strong><small class=\"muted\">" + escapeHtml(player.level_display || "") + (player.ready ? " · ready" : "") + "</small></article>";
    }).join("");
  }

  function compactPlayers(duel) {
    return (duel.players || [duel.creator, duel.opponent]).filter(Boolean).map(function (player, index) {
      return { ...player, role: index === 0 ? "creator" : "opponent", ready: false, score: 0, correct: 0 };
    });
  }

  function showDuelPanel(name) {
    var map = {
      create: "[data-duel-create]",
      lobby: "[data-duel-lobby]",
      live: "[data-duel-live]",
      results: "[data-duel-results]",
    };
    Object.entries(map).forEach(function (entry) {
      toggleHidden(entry[1], entry[0] !== name);
    });
  }

  function scheduleDuelPoll(status) {
    clearDuelPoll();
    if (!["waiting", "ready", "active", "reveal"].includes(status)) return;
    state.duelPoll = window.setTimeout(loadDuelState, status === "active" ? 1000 : 1800);
  }

  function clearDuelPoll() {
    if (state.duelPoll) window.clearTimeout(state.duelPoll);
    state.duelPoll = null;
  }

  function scheduleDuelRoomsPoll() {
    clearDuelRoomsPoll();
    state.duelRoomsPoll = window.setTimeout(async function () {
      await loadOpenDuelRooms();
      scheduleDuelRoomsPoll();
    }, 5000);
  }

  function clearDuelRoomsPoll() {
    if (state.duelRoomsPoll) window.clearTimeout(state.duelRoomsPoll);
    state.duelRoomsPoll = null;
  }

  function showDuelAuth() {
    showDuelPanel("create");
    var auth = document.querySelector("[data-duel-auth]");
    if (auth) auth.classList.remove("hidden");
    var create = document.querySelector("[data-duel-create]");
    if (create) create.classList.add("hidden");
  }

  function hideDuelAuth() {
    var auth = document.querySelector("[data-duel-auth]");
    if (auth) auth.classList.add("hidden");
  }

  function setDuelError(message) {
    var target = document.querySelector("[data-duel-error]");
    if (target) {
      target.textContent = message;
      target.classList.toggle("hidden", !message);
    }
    var lobbyTarget = document.querySelector("[data-duel-lobby-error]");
    if (lobbyTarget) {
      lobbyTarget.textContent = message;
      lobbyTarget.classList.toggle("hidden", !message);
    }
  }

  function copyDuelInvite() {
    var input = document.querySelector("[data-duel-invite]");
    if (!input) return;
    input.select();
    if (navigator.clipboard) navigator.clipboard.writeText(input.value).catch(function () {});
  }

  function duelStatusLabel(status) {
    return {
      waiting: "Waiting",
      ready: "Ready",
      active: "Live",
      reveal: "Reveal",
      completed: "Complete",
    }[status] || "Duel";
  }

  async function initAgora() {
    hydrateFiltersFromUrl();
    initDrawerControls();
    await loadFilterOptions();
    await updateFilterCount();
    updateModeLabel();
    updateSessionLine();
    if (!state.authenticated) {
      showAuthInline();
      return;
    }
    await refreshDueModeCount();
    await loadQuestion(true);
  }

  async function refreshDueModeCount() {
    var target = document.querySelector("[data-due-mode-label]");
    if (!target || !state.authenticated) return;
    try {
      var data = await api("/api/review-queue");
      target.textContent = "Due Review (" + (data.count || 0) + ")";
    } catch {
      target.textContent = "Due Review";
    }
  }

  function hydrateFiltersFromUrl() {
    var params = new URLSearchParams(window.location.search);
    state.filters.block = params.get("block") || "";
    state.filters.topic = params.get("topic") || "";
    state.filters.mode = normalizeMode(params.get("mode"));
    state.filters.tier = params.get("tier") || "";
    state.filters.style = params.get("style") || "";
    state.draftFilters = cloneFilters(state.filters);
    state.openFilters = params.get("filters") === "open";
  }

  function initDrawerControls() {
    var open = document.querySelector("[data-filter-open]");
    var drawer = document.querySelector("[data-filter-drawer]");
    var close = document.querySelector("[data-filter-close]");
    var apply = document.querySelector("[data-filter-apply]");
    var clear = document.querySelector("[data-filter-clear]");
    var cancel = document.querySelector("[data-filter-cancel]");
    var next = document.querySelector("[data-next-question]");
    if (open && drawer && !open.dataset.bound) {
      open.dataset.bound = "true";
      open.addEventListener("click", async function () {
        if (drawer.classList.contains("open")) {
          await cancelFilterDraft(drawer);
        } else {
          await openFilterDrawer(drawer);
        }
      });
      if (state.openFilters) drawer.classList.add("open");
    }
    if (close && drawer && !close.dataset.bound) {
      close.dataset.bound = "true";
      close.addEventListener("click", function () {
        cancelFilterDraft(drawer);
      });
    }
    document.querySelectorAll("[data-filter]").forEach(function (control) {
      if (control.dataset.bound) return;
      control.dataset.bound = "true";
      control.addEventListener("change", async function () {
        syncDraftFiltersFromControls();
        if (control.dataset.filter === "block") {
          state.draftFilters.topic = "";
          fillTopicOptions(state.draftFilters);
          syncControlsFromDraftFilters();
        }
        await updateFilterCount(state.draftFilters);
      });
    });
    document.querySelectorAll("[data-mode-choice]").forEach(function (button) {
      if (button.dataset.bound) return;
      button.dataset.bound = "true";
      button.addEventListener("click", async function () {
        state.filters.mode = normalizeMode(button.dataset.modeChoice);
        state.draftFilters = cloneFilters(state.filters);
        syncControlsFromDraftFilters();
        updateAgoraUrl();
        updateModeLabel();
        resetSession();
        await updateFilterCount();
        await loadQuestion(true);
      });
    });
    if (!state.filterChipBound) {
      state.filterChipBound = true;
      document.addEventListener("click", async function (event) {
        var chip = event.target.closest ? event.target.closest("[data-clear-filter]") : null;
        if (!chip) return;
        event.preventDefault();
        var key = chip.dataset.clearFilter;
        if (key === "mode") state.filters.mode = "unanswered";
        if (["block", "topic", "tier", "style"].includes(key)) state.filters[key] = "";
        if (key === "block") state.filters.topic = "";
        state.draftFilters = cloneFilters(state.filters);
        syncControlsFromDraftFilters();
        fillTopicOptions(state.draftFilters);
        updateAgoraUrl();
        updateModeLabel();
        resetSession();
        await updateFilterCount();
        await loadQuestion(true);
      });
    }
    if (apply && !apply.dataset.bound) {
      apply.dataset.bound = "true";
      apply.addEventListener("click", async function () {
        syncDraftFiltersFromControls();
        state.filters = cloneFilters(state.draftFilters);
        updateAgoraUrl();
        updateModeLabel();
        resetSession();
        if (drawer) drawer.classList.remove("open");
        await updateFilterCount(state.filters);
        await loadQuestion(true);
      });
    }
    if (clear && !clear.dataset.bound) {
      clear.dataset.bound = "true";
      clear.addEventListener("click", async function () {
        state.draftFilters = defaultFilters();
        syncControlsFromDraftFilters();
        fillTopicOptions(state.draftFilters);
        await updateFilterCount(state.draftFilters);
      });
    }
    if (cancel && drawer && !cancel.dataset.bound) {
      cancel.dataset.bound = "true";
      cancel.addEventListener("click", function () {
        cancelFilterDraft(drawer);
      });
    }
    if (next && !next.dataset.bound) {
      next.dataset.bound = "true";
      next.addEventListener("click", function () {
        loadQuestion(false);
      });
    }
    document.querySelectorAll("[data-quality]").forEach(function (button) {
      if (button.dataset.bound) return;
      button.dataset.bound = "true";
      button.addEventListener("click", function () {
        submitReview(Number(button.dataset.quality));
      });
    });
    bindQuestionVoteControls();
  }

  async function loadFilterOptions() {
    try {
      state.options = await api("/api/filter-options");
      fillSelect("block", state.options.blocks || [], "All blocks");
      fillSelect("tier", state.options.tiers || [], "All tiers", tierLabel);
      fillSelect("style", state.options.styles || [], "All styles");
      state.draftFilters = cloneFilters(state.filters);
      syncControlsFromDraftFilters();
      fillTopicOptions(state.draftFilters);
      syncControlsFromDraftFilters();
    } catch {
      state.options = { blocks: [], tiers: [], topics_by_block: {} };
    }
  }

  async function openFilterDrawer(drawer) {
    state.draftFilters = cloneFilters(state.filters);
    syncControlsFromDraftFilters();
    fillTopicOptions(state.draftFilters);
    drawer.classList.add("open");
    await updateFilterCount(state.draftFilters);
  }

  async function cancelFilterDraft(drawer) {
    state.draftFilters = cloneFilters(state.filters);
    syncControlsFromDraftFilters();
    fillTopicOptions(state.draftFilters);
    if (drawer) drawer.classList.remove("open");
    await updateFilterCount(state.filters);
  }

  function syncDraftFiltersFromControls() {
    state.draftFilters.block = valueOf("[data-filter=\"block\"]");
    state.draftFilters.topic = valueOf("[data-filter=\"topic\"]");
    state.draftFilters.mode = normalizeMode(valueOf("[data-filter=\"mode\"]"));
    state.draftFilters.tier = valueOf("[data-filter=\"tier\"]");
    state.draftFilters.style = valueOf("[data-filter=\"style\"]");
  }

  function syncControlsFromDraftFilters() {
    setValue("[data-filter=\"block\"]", state.draftFilters.block);
    setValue("[data-filter=\"mode\"]", state.draftFilters.mode);
    setValue("[data-filter=\"tier\"]", state.draftFilters.tier);
    setValue("[data-filter=\"style\"]", state.draftFilters.style);
    setValue("[data-filter=\"topic\"]", state.draftFilters.topic);
  }

  function fillTopicOptions(filters) {
    var data = state.options || { topics_by_block: {} };
    var source = filters || state.draftFilters;
    var topics = source.block ? data.topics_by_block[source.block] || [] : Object.values(data.topics_by_block || {}).flat();
    fillSelect("topic", Array.from(new Set(topics)).sort(), "All topics");
    setValue("[data-filter=\"topic\"]", source.topic);
  }

  function fillSelect(name, items, label, formatter) {
    var select = document.querySelector("[data-filter=\"" + name + "\"]");
    if (!select) return;
    var current = select.value;
    select.innerHTML = "<option value=\"\">" + label + "</option>" + items.map(function (item) {
      return "<option value=\"" + escapeHtml(item) + "\">" + escapeHtml(formatter ? formatter(item) : item) + "</option>";
    }).join("");
    if (current) select.value = current;
  }

  async function updateFilterCount(filters) {
    try {
      var data = await api("/api/filter-count?" + buildFilterParams(filters).toString());
      setText("[data-filter-count]", data.count);
      setText("[data-filter-count-label]", " questions match");
    } catch (error) {
      setText("[data-filter-count]", error && error.auth_required ? "Sign in" : 0);
      setText("[data-filter-count-label]", error && error.auth_required ? " to count this mode" : " questions match");
    }
  }

  async function loadQuestion(resetAnswerState) {
    showSkeleton();
    hideAuthInline();
    if (resetAnswerState) clearAnswerState();
    if (!state.authenticated) {
      showAuthInline();
      return;
    }
    if (state.user) {
      updateStreakLine(state.user.streak_days);
    }
    try {
      var params = buildFilterParams();
      state.sessionQuestionIds.forEach(function (questionId) {
        params.append("exclude", questionId);
      });
      var data = await api("/api/next-question?" + params.toString());
      state.currentQuestion = data.question;
      state.startedAt = Date.now();
      renderQuestion(data.question);
    } catch (error) {
      state.currentQuestion = null;
      hideSkeleton();
      if (error && error.auth_required) {
        showAuthInline();
      } else {
        showEmptyQuestion(error || {});
      }
    }
  }

  function renderQuestion(question) {
    if (!question) {
      showEmptyQuestion({ message: "No matching questions." });
      return;
    }
    hideSkeleton();
    clearAnswerState();
    document.querySelector("[data-question-state]").classList.remove("hidden");
    setText("[data-block-tag]", question.block || "Block");
    setText("[data-q-counter]", "Q " + String(state.sessionAnswered + 1).padStart(2, "0"));
    updateModeLabel();
    renderQuestionCopy(question);
    var options = document.querySelector("[data-options]");
    var shuffledOptions = shuffleEntries(Object.entries(question.options || {}).filter(function (entry) {
      return entry[1];
    }));
    state.optionDisplayByAnswer = {};
    options.innerHTML = shuffledOptions.map(function (entry, index) {
      var key = entry[0];
      var text = entry[1] || "";
      var displayKey = String.fromCharCode(65 + index);
      state.optionDisplayByAnswer[key] = displayKey;
      return "<button class=\"opt\" type=\"button\" data-answer=\"" + escapeHtml(key) + "\"><span class=\"option-key\">" + displayKey + ".</span><span class=\"option-copy\">" + formatInlineScienceHtml(text) + "</span></button>";
    }).join("");
    options.querySelectorAll("[data-answer]").forEach(function (button) {
      button.addEventListener("click", function () {
        submitAnswer(button);
      });
    });
  }

  function renderQuestionCopy(question) {
    var stem = String(question.stem || "").trim();
    var leadIn = String(question.lead_in || "").trim();
    var questionText = document.querySelector(".question-text");
    var stemNode = document.querySelector("[data-stem]");
    var leadNode = document.querySelector("[data-lead-in]");
    if (questionText) questionText.classList.toggle("lead-only", !stem && !!leadIn);
    if (stemNode) stemNode.hidden = !stem;
    if (stemNode) stemNode.innerHTML = formatInlineScienceHtml(stem);
    if (leadNode) leadNode.innerHTML = formatInlineScienceHtml(leadIn);
  }

  async function submitAnswer(button) {
    if (!state.currentQuestion || button.disabled || state.answerSubmitting || hasAnswerResolved()) return;
    var chosen = button.dataset.answer;
    state.answerSubmitting = true;
    state.answerSubmittingAt = Date.now();
    showAnswerError("");
    disableOptions();
    try {
      var data = await apiWithTimeout("/api/attempt", {
        method: "POST",
        body: JSON.stringify({
          question_id: state.currentQuestion.question_id,
          chosen_answer: chosen,
          time_taken_seconds: Math.round((Date.now() - state.startedAt) / 1000),
        }),
      }, 15000);
      state.sessionAnswered += 1;
      rememberSessionQuestion(state.currentQuestion.question_id);
      if (data.correct) state.sessionCorrect += 1;
      paintOptions(chosen, data.correct_answer);
      showExplanation(data);
      showXpToast(data.xp_earned || (data.correct ? 10 : 2), data.correct);
      updateSessionProgress();
      updateSessionLine();
      updateTopbarFromAttempt(data);
      showLevelBanner(data);
      showReviewSchedule(data);
      showFirstQuestionDisclaimer();
      var next = document.querySelector("[data-next-question]");
      if (next) next.disabled = false;
      if (state.filters.mode === "due") showReviewRating();
    } catch (error) {
      if (error && error.auth_required) {
        showAuthInline();
      } else {
        enableOptions();
        showAnswerError("Connection woke up slowly. Try that answer again.");
      }
    } finally {
      state.answerSubmitting = false;
      state.answerSubmittingAt = 0;
    }
  }

  function disableOptions() {
    document.querySelectorAll("[data-answer]").forEach(function (item) {
      item.disabled = true;
    });
  }

  function enableOptions() {
    if (hasAnswerResolved()) return;
    document.querySelectorAll("[data-answer]").forEach(function (item) {
      item.disabled = false;
    });
  }

  function hasAnswerResolved() {
    var explanation = document.querySelector("[data-explanation]");
    return !!(explanation && !explanation.classList.contains("hidden"));
  }

  function showAnswerError(message) {
    var node = document.querySelector("[data-answer-error]");
    if (!node) return;
    node.textContent = message || "";
    node.classList.toggle("hidden", !message);
  }

  function paintOptions(chosen, correctAnswer) {
    document.querySelectorAll("[data-answer]").forEach(function (item) {
      if (item.dataset.answer === correctAnswer) item.classList.add("is-correct");
      if (item.dataset.answer === chosen && chosen !== correctAnswer) item.classList.add("is-wrong");
      if (item.dataset.answer !== correctAnswer && item.dataset.answer !== chosen) item.classList.add("is-muted");
    });
  }

  function showExplanation(data) {
    var explanation = document.querySelector("[data-explanation]");
    var trap = document.querySelector("[data-trap]");
    setHtml("[data-explanation-body]", optionExplanationHtml(data));
    var trapCopy = trapExplanationHtml(data);
    if (trapCopy) {
      setHtml("[data-trap-body]", trapCopy);
      trap.classList.remove("hidden");
    } else {
      trap.classList.add("hidden");
    }
    explanation.classList.remove("hidden");
    showQuestionFeedback();
    requestAnimationFrame(function () {
      explanation.classList.add("open");
    });
  }

  function bindQuestionVoteControls() {
    if (state.questionVoteDelegated) return;
    state.questionVoteDelegated = true;

    document.addEventListener("click", async function (event) {
      var button = event.target.closest("[data-question-vote]");
      if (!button) return;
      event.preventDefault();
      
      var vote = button.dataset.questionVote;
      var questionId = button.dataset.questionId;
      if (!questionId && state.currentQuestion) {
        questionId = state.currentQuestion.question_id;
      }
      if (!questionId) return;

      var container = button.closest(".question-feedback") || button.closest(".exam-review-item") || button.closest(".explanation") || button.closest(".explanation-box") || button.closest(".review-row") || button.closest(".review-actions") || document;
      var buttons = container.querySelectorAll("[data-question-vote]");
      var resultNode = container.querySelector("[data-question-vote-result]");
      
      buttons.forEach(function (btn) {
        btn.disabled = true;
        btn.classList.toggle("active", btn.dataset.questionVote === vote);
      });
      if (resultNode) resultNode.classList.add("hidden");

      try {
        var data = await api("/api/question-quality", {
          method: "POST",
          body: JSON.stringify({
            question_id: questionId,
            vote: vote,
          }),
        });
        if (resultNode) {
          resultNode.textContent = "Marked: " + (data.label || vote);
          resultNode.classList.remove("hidden");
        }
      } catch (error) {
        buttons.forEach(function (btn) {
          btn.disabled = false;
        });
        if (resultNode) {
          resultNode.textContent = error && error.auth_required ? "Enter the temple to mark question quality." : "This mark could not be saved.";
          resultNode.classList.remove("hidden");
        }
      }
    });
  }

  function showQuestionFeedback(selector) {
    var feedback = document.querySelector(selector || "[data-question-feedback]");
    var result = document.querySelector("[data-question-vote-result]");
    if (result) result.classList.add("hidden");
    document.querySelectorAll("[data-question-vote]").forEach(function (button) {
      button.classList.remove("active");
      button.disabled = false;
    });
    if (feedback) feedback.classList.remove("hidden");
  }

  function showFirstQuestionDisclaimer() {
    try {
      if (localStorage.getItem(QUESTION_DISCLAIMER_KEY)) return;
      localStorage.setItem(QUESTION_DISCLAIMER_KEY, "seen");
    } catch {}
    var dialog = document.querySelector("[data-question-disclaimer]");
    if (dialog && typeof dialog.showModal === "function") {
      dialog.showModal();
      return;
    }
    window.alert("Some questions may include content outside of what was covered in the lectures. Please mark these questions as \"Not learnt\".");
  }

  function showReviewRating() {
    var rating = document.querySelector("[data-review-rating]");
    var result = document.querySelector("[data-review-result]");
    if (result) result.classList.add("hidden");
    if (rating) rating.classList.remove("hidden");
  }

  async function submitReview(quality) {
    if (!state.currentQuestion) return;
    try {
      var data = await api("/api/review", {
        method: "POST",
        body: JSON.stringify({
          question_id: state.currentQuestion.question_id,
          quality: quality,
        }),
      });
      var result = document.querySelector("[data-review-result]");
      if (result) {
        result.textContent = "Scheduled: " + (data.next_review_label || formatDate(data.next_review_date));
        result.classList.remove("hidden");
      }
      showReviewSchedule(data);
      await refreshDueModeCount();
    } catch {}
  }

  function showXpToast(xp, correct) {
    var toast = document.querySelector("[data-xp-toast]");
    if (!toast) return;
    toast.textContent = "+" + xp + " xp";
    toast.classList.toggle("good", !!correct);
    toast.classList.remove("hidden");
  }

  function updateSessionProgress() {
    var bar = document.querySelector("[data-answer-progress]");
    if (bar) bar.style.width = Math.min(100, state.sessionAnswered * 10) + "%";
  }

  function updateSessionLine() {
    setText("[data-session-line]", state.sessionAnswered + " answered · " + state.sessionCorrect + " correct");
  }

  function updateTopbarFromAttempt(data) {
    if (data.new_total_xp !== undefined) {
      var xp = document.querySelector("[data-xp-pill]");
      if (xp) {
        xp.textContent = formatNumber(data.new_total_xp) + " xp";
        xp.hidden = false;
      }
    }
    updateStreakLine(data.streak_days);
  }

  function updateStreakLine(streakDays) {
    var streakLine = document.querySelector("[data-streak-line]");
    if (streakLine) {
      streakLine.textContent = "◆ " + (streakDays || 0) + " day streak";
      streakLine.classList.toggle("active-streak", (streakDays || 0) > 0);
    }
  }

  function showLevelBanner(data) {
    var banner = document.querySelector("[data-level-banner]");
    if (!banner || !data.levelled_up) return;
    banner.textContent = "— You are now " + data.new_level_title + " · " + roman(data.new_level);
    banner.classList.remove("hidden");
    window.setTimeout(function () {
      banner.classList.add("hidden");
    }, 4000);
  }

  function showReviewSchedule(data) {
    var node = document.querySelector("[data-review-schedule]");
    if (!node) return;
    if (!data || !data.next_review_date) {
      node.classList.add("hidden");
      return;
    }
    node.textContent = "Next review: " + (data.next_review_label || formatDate(data.next_review_date));
    node.classList.remove("hidden");
  }

  function showSkeleton() {
    var loading = document.querySelector("[data-loading-state]");
    var question = document.querySelector("[data-question-state]");
    if (loading) loading.classList.remove("hidden");
    if (question) question.classList.add("hidden");
    var next = document.querySelector("[data-next-question]");
    if (next) next.disabled = true;
  }

  function hideSkeleton() {
    var loading = document.querySelector("[data-loading-state]");
    if (loading) loading.classList.add("hidden");
  }

  function showEmptyQuestion(error) {
    var question = document.querySelector("[data-question-state]");
    var options = document.querySelector("[data-options]");
    var empty = document.querySelector("[data-empty-state]");
    hideSkeleton();
    if (question) question.classList.remove("hidden");
    setText("[data-block-tag]", "Agora");
    setText("[data-q-counter]", "Q --");
    updateModeLabel();
    renderQuestionCopy({ stem: "", lead_in: "" });
    if (options) options.innerHTML = "";
    if (empty) {
      var due = state.filters.mode === "due";
      var asset = document.querySelector("[data-empty-asset]");
      if (asset) {
        asset.className = "empty-asset " + (due ? "empty-asset--review-clear" : "empty-asset--no-results");
      }
      setText("[data-empty-label]", due ? "Review clear" : "No matching questions");
      setText("[data-empty-copy]", error && error.message ? error.message : "No questions match this session.");
      setText("[data-empty-detail]", due && error && error.next_due_date ? "Next review: " + formatDate(error.next_due_date) : "Try clearing filters or changing mode.");
      empty.classList.remove("hidden");
    }
  }

  function showAuthInline() {
    var target = document.querySelector("[data-auth-inline]");
    if (!target) return;
    hideSkeleton();
    var question = document.querySelector("[data-question-state]");
    if (question) question.classList.add("hidden");
    target.innerHTML = "<div class=\"auth-inline\"><p>Enter the temple to practise. Aesculon saves your XP, streak, answers, and review schedule to your account.</p><div class=\"auth-inline__actions\"><a class=\"ghost-btn\" href=\"#\" data-inline-auth=\"register\">Register</a><a class=\"ghost-btn\" href=\"#\" data-inline-auth=\"login\">Login</a></div></div>";
    target.classList.remove("hidden");
    target.querySelectorAll("[data-inline-auth]").forEach(function (link) {
      link.addEventListener("click", function (event) {
        event.preventDefault();
        showAuthPanel(link.dataset.inlineAuth);
      });
    });
  }

  function hideAuthInline() {
    var target = document.querySelector("[data-auth-inline]");
    if (target) target.classList.add("hidden");
  }

  function clearAnswerState() {
    var explanation = document.querySelector("[data-explanation]");
    var rating = document.querySelector("[data-review-rating]");
    var feedback = document.querySelector("[data-question-feedback]");
    var toast = document.querySelector("[data-xp-toast]");
    var banner = document.querySelector("[data-level-banner]");
    var empty = document.querySelector("[data-empty-state]");
    var schedule = document.querySelector("[data-review-schedule]");
    if (explanation) {
      explanation.classList.add("hidden");
      explanation.classList.remove("open");
    }
    if (rating) rating.classList.add("hidden");
    if (feedback) feedback.classList.add("hidden");
    if (toast) toast.classList.add("hidden");
    if (banner) banner.classList.add("hidden");
    if (empty) empty.classList.add("hidden");
    if (schedule) schedule.classList.add("hidden");
    var next = document.querySelector("[data-next-question]");
    if (next) next.disabled = true;
  }

  function resetSession() {
    state.sessionAnswered = 0;
    state.sessionCorrect = 0;
    state.sessionQuestionIds = [];
    updateSessionLine();
    var bar = document.querySelector("[data-answer-progress]");
    if (bar) bar.style.width = "0%";
  }

  function buildFilterParams(filters) {
    var source = filters || state.filters;
    var params = new URLSearchParams();
    if (source.block) params.set("block", source.block);
    if (source.topic) params.set("topic", source.topic);
    if (source.mode && source.mode !== "unanswered") params.set("mode", source.mode);
    if (source.tier) params.set("tier", source.tier);
    if (source.style) params.set("style", source.style);
    return params;
  }

  function updateAgoraUrl() {
    var params = buildFilterParams().toString();
    window.history.replaceState({}, "", params ? "/practice?" + params : "/practice");
  }

  function normalizeMode(mode) {
    return ["unanswered", "incorrect", "due"].includes(mode) ? mode : "unanswered";
  }

  function updateModeLabel() {
    var labels = {
      unanswered: "New",
      incorrect: "Incorrect",
      due: "Due Review",
    };
    setText("[data-mode-label]", labels[state.filters.mode] || "New");
    setText("[data-session-intent]", sessionIntent(labels[state.filters.mode] || "New"));
    document.querySelectorAll("[data-mode-choice]").forEach(function (button) {
      button.classList.toggle("active", normalizeMode(button.dataset.modeChoice) === state.filters.mode);
    });
    renderActiveFilters(labels);
  }

  function sessionIntent(modeLabel) {
    if (state.filters.mode === "due") return "Due Review. The Oracle remembers what has not yet settled.";
    if (state.filters.mode === "unanswered") return "New questions across the archive.";
    if (state.filters.mode === "incorrect") return "Incorrect questions. Rework the places where recall slipped.";
    return modeLabel + " questions across the archive.";
  }

  function renderActiveFilters(labels) {
    var target = document.querySelector("[data-active-filters]");
    if (!target) return;
    var chips = [];
    if (state.filters.mode !== "unanswered") chips.push({ key: "mode", label: labels[state.filters.mode] || state.filters.mode });
    if (state.filters.block) chips.push({ key: "block", label: state.filters.block });
    if (state.filters.topic) chips.push({ key: "topic", label: state.filters.topic });
    if (state.filters.tier) chips.push({ key: "tier", label: tierLabel(state.filters.tier) });
    if (state.filters.style) chips.push({ key: "style", label: state.filters.style });
    target.classList.toggle("hidden", !chips.length);
    target.innerHTML = chips.map(function (chip) {
      return "<button class=\"filter-chip\" type=\"button\" data-clear-filter=\"" + escapeHtml(chip.key) + "\"><span>" + escapeHtml(chip.label) + "</span><span aria-hidden=\"true\">x</span></button>";
    }).join("");
  }

  function tierLabel(tier) {
    if (String(tier).includes("1")) return "Tier 1";
    if (String(tier).includes("2")) return "Tier 2";
    if (String(tier).includes("3")) return "Tier 3";
    return tier;
  }

  function roman(number) {
    return ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][number] || number;
  }

  function valueOf(selector) {
    var node = document.querySelector(selector);
    return node ? node.value : "";
  }

  function setValue(selector, value) {
    var node = document.querySelector(selector);
    if (node) node.value = value || "";
  }

  function setText(selector, value) {
    var node = document.querySelector(selector);
    if (node) node.textContent = value;
  }

  function setHtml(selector, value) {
    var node = document.querySelector(selector);
    if (node) node.innerHTML = value;
  }

  function setLink(selector, href, label) {
    var node = document.querySelector(selector);
    if (!node) return;
    node.href = href;
    node.textContent = label;
  }

  function navigateTo(href) {
    if (window.Turbo && typeof window.Turbo.visit === "function") {
      window.Turbo.visit(href);
      return;
    }
    window.location.href = href;
  }

  function toggleHidden(selector, hidden) {
    var node = document.querySelector(selector);
    if (node) node.classList.toggle("hidden", hidden);
  }

  function plural(count, singular, pluralValue) {
    return Number(count) === 1 ? singular : pluralValue;
  }

  function rememberSessionQuestion(questionId) {
    if (questionId && !state.sessionQuestionIds.includes(questionId)) {
      state.sessionQuestionIds.push(questionId);
    }
  }

  function optionExplanationHtml(data) {
    var key = data.correct_answer;
    var optionText = optionTextForKey(key);
    var detail = stripOptionReference(remapSeededOptionLetters(data.explanation || "No explanation was recorded."), optionText);
    return optionReferenceHtml(key, optionText, detail);
  }

  function trapExplanationHtml(data) {
    if (!data.top_distractor && !data.why_distractor_wrong) return "";
    var key = findOptionKeyByText(data.top_distractor);
    var optionText = key ? optionTextForKey(key) : stripLeadingOptionLetter(data.top_distractor || "");
    var detail = remapSeededOptionLetters(data.why_distractor_wrong || "");
    if (key || optionText) return optionReferenceHtml(key, optionText, detail);
    return "<p>" + formatInlineScienceHtml(detail) + "</p>";
  }

  function optionReferenceHtml(key, optionText, detail) {
    var displayKey = key ? displayKeyForAnswer(key) : "";
    var prefix = displayKey
      ? "<span class=\"answer-reference__key\">" + escapeHtml(displayKey) + ".</span>"
      : "";
    var text = optionText
      ? "<span class=\"answer-reference__text\">" + formatInlineScienceHtml(optionText) + "</span>"
      : "";
    var body = detail ? "<span class=\"answer-reference__detail\">" + formatInlineScienceHtml(detail) + "</span>" : "";
    return "<p><span class=\"answer-reference\">" + prefix + text + "</span>" + (body ? " " + body : "") + "</p>";
  }

  function stripOptionReference(value, optionText) {
    var text = stripLeadingOptionLetter(value);
    if (optionText && text.indexOf(optionText) === 0) {
      text = text.slice(optionText.length).replace(/^[\s.;:—-]+/, "").trim();
    }
    return text;
  }

  function stripLeadingOptionLetter(value) {
    return String(value || "").replace(/^[A-E]\.\s+/, "").trim();
  }

  function optionTextForKey(key) {
    var options = state.currentQuestion && state.currentQuestion.options ? state.currentQuestion.options : {};
    return options[String(key || "").toUpperCase()] || "";
  }

  function findOptionKeyByText(value) {
    if (!value || !state.currentQuestion || !state.currentQuestion.options) return "";
    var target = normalizeOptionText(value);
    var match = Object.entries(state.currentQuestion.options).find(function (entry) {
      return normalizeOptionText(entry[1]) === target;
    });
    return match ? match[0] : "";
  }

  function normalizeOptionText(value) {
    return String(value || "").replace(/^[A-E]\.\s+/, "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function remapSeededOptionLetters(value) {
    return String(value == null ? "" : value)
      .replace(/(^|\n)([A-E])\.\s+/g, function (match, prefix, key) {
        return prefix + displayKeyForAnswer(key) + ". ";
      })
      .replace(/\b([Oo]ption)\s+([A-E])\b/g, function (match, label, key) {
        return label + " " + displayKeyForAnswer(key);
      })
      .replace(/\b(answer\s+is)\s+([A-E])\b/gi, function (match, label, key) {
        return label + " " + displayKeyForAnswer(key);
      });
  }

  function displayKeyForAnswer(key) {
    return state.optionDisplayByAnswer[String(key || "").toUpperCase()] || key;
  }

  function defaultFilters() {
    return { block: "", topic: "", mode: "unanswered", tier: "", style: "" };
  }

  function cloneFilters(filters) {
    var source = filters || defaultFilters();
    return {
      block: source.block || "",
      topic: source.topic || "",
      mode: normalizeMode(source.mode),
      tier: source.tier || "",
      style: source.style || "",
    };
  }

  function shuffleEntries(items) {
    var shuffled = items.slice();
    for (var index = shuffled.length - 1; index > 0; index -= 1) {
      var swapIndex = randomIndex(index + 1);
      var current = shuffled[index];
      shuffled[index] = shuffled[swapIndex];
      shuffled[swapIndex] = current;
    }
    return shuffled;
  }

  function randomIndex(max) {
    if (window.crypto && window.crypto.getRandomValues) {
      var values = new Uint32Array(1);
      var limit = Math.floor(0x100000000 / max) * max;
      do {
        window.crypto.getRandomValues(values);
      } while (values[0] >= limit);
      return values[0] % max;
    }
    return Math.floor(Math.random() * max);
  }

  async function api(url, options) {
    var response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      ...(options || {}),
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw data;
    return data;
  }

  async function apiWithTimeout(url, options, timeoutMs) {
    if (!window.AbortController) return api(url, options);
    var controller = new AbortController();
    var timer = window.setTimeout(function () {
      controller.abort();
    }, timeoutMs || 15000);
    try {
      return await api(url, {
        ...(options || {}),
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw { error: "Request timed out." };
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString();
  }

  function formatDate(value) {
    if (!value) return "None scheduled";
    var dateOnly = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    var date = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatDateTime(value) {
    if (!value) return "";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function formatInlineScienceHtml(value) {
    var html = escapeHtml(value);
    html = html.replace(/\$([^$]+)\$/g, function (match, expression) {
      return formatScienceNotation(expression);
    });
    return formatScienceNotation(html);
  }

  function formatScienceNotation(html) {
    return String(html || "")
      .replace(/\^\{([^}]+)\}/g, "<sup>$1</sup>")
      .replace(/_\{([^}]+)\}/g, "<sub>$1</sub>")
      .replace(/\^([+\-]?\d+|[+\-])/g, "<sup>$1</sup>")
      .replace(/_([A-Za-z0-9+\-]+)/g, "<sub>$1</sub>");
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();

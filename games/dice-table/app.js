/* =========================================================
   骰局 — UI, room flow, and host-authoritative sync
   ========================================================= */
(function () {
  "use strict";

  var UI = window.ArcadeUI;
  var P2P = window.ArcadeP2P;
  var Engine = window.DiceEngine;

  var PLAYER_IDS = ["host", "guest"];
  var SCREEN_IDS = ["home", "connect", "room", "table"];

  var App = {
    screen: "home",
    role: null,
    localId: null,
    connected: false,
    connection: null,
    opToken: 0,
    leaving: false,
    suppressClose: false,
    room: null,
    invite: null,
    game: null,
    pending: false,
    pendingTimer: null,
    resultShown: false,
    rackSigs: { banker: "", child: "" },
    lastBetKey: "",
    lastLogCount: 0,
    loanPlayerId: null,
    roomEntered: false,
    connectError: ""
  };

  function $(id) {
    return document.getElementById(id);
  }

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function setText(id, text) {
    var node = typeof id === "string" ? $(id) : id;
    if (node) node.textContent = text == null ? "" : text;
  }

  function setHidden(node, hidden) {
    if (!node) return;
    node.classList.toggle("hidden", !!hidden);
  }

  function fmt(value) {
    return UI.formatInt(value);
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function otherId(id) {
    return id === "host" ? "guest" : "host";
  }

  function nowTitle() {
    var g = App.game;
    if (g && g.phase === "gameover") return "骰局 · 终局";
    if (App.screen === "table" && g) {
      return isLocalTurn() ? "● 骰局 · 轮到你" : "骰局 · 等待对方";
    }
    if (App.screen === "connect") return "骰局 · 联机";
    if (App.screen === "room") return "骰局 · 房间";
    return "骰局 · 游戏集";
  }

  function updateHead() {
    var context = "THREE DICE · TWO PLAYERS";
    var round = "";
    if (App.screen === "connect") {
      context = "SERVERLESS ROOM";
      round = App.connected ? "已连接" : "交换联机码";
    } else if (App.screen === "room") {
      context = "ROOM ESTABLISHED";
      round = "双方已连接";
    } else if (App.screen === "table" && App.game) {
      context = "DICE TABLE · ROUND";
      round = "第 " + App.game.handNo + " 手";
    }
    setText("head-context", context);
    setText("head-round", round);
    updateConnectionUI();
    document.title = nowTitle();
  }

  function updateConnectionUI() {
    var pill = $("connection-pill");
    if (!pill) return;
    var text;
    if (App.connected) text = "已连接";
    else if (App.connection) text = "连接中";
    else text = "未联机";
    setText("connection-text", text);
    pill.classList.toggle("is-offline", !App.connected);
  }

  function showScreen(name) {
    if (SCREEN_IDS.indexOf(name) === -1) return;
    SCREEN_IDS.forEach(function (screen) {
      var node = $("screen-" + screen);
      if (node) node.classList.toggle("is-active", screen === name);
    });
    App.screen = name;
    updateHead();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function isLocalTurn() {
    var g = App.game;
    if (!g || g.phase === "gameover") return false;
    if (g.phase === "settled") return true;
    if (g.phase === "betting" || g.phase === "child-decision") return App.localId === g.childId;
    if (g.phase === "banker-turn") return App.localId === g.bankerId;
    return false;
  }

  function player(id) {
    return App.game && App.game.players ? App.game.players[id] : null;
  }

  function localPlayer() {
    return player(App.localId);
  }

  function modeInfo(id) {
    return (Engine.MODE_GUIDE && Engine.MODE_GUIDE[id]) || Engine.MODE_GUIDE.classic;
  }

  function modeLabel(id) {
    return modeInfo(id).label;
  }

  function settingsSummary(settings) {
    if (!settings) return "";
    var parts = [modeLabel(settings.gameMode), "初始 " + fmt(settings.startingChips)];
    if (settings.loansEnabled) {
      parts.push(
        "贷款上限 " + fmt(settings.debtLimit) + " / 利息 " + settings.interestRate + "% 每手"
      );
    } else {
      parts.push("贷款关");
    }
    parts.push("弃权" + (settings.allowFold ? "开" : "关"));
    return parts.join(" · ");
  }

  function roleLabel(id) {
    if (!App.game) return "";
    return id === App.game.bankerId ? "庄家" : "闲家";
  }

  function namesForRoom(room) {
    return {
      host: room && room.hostName ? room.hostName : "房主",
      guest: room && room.guestName ? room.guestName : "客人"
    };
  }

  /* =========================================================
     Boot
     ========================================================= */

  UI.onReady(function () {
    if (!Engine || !P2P) {
      setText("create-error", "游戏文件加载不完整，请刷新页面。");
      return;
    }

    initCreateDefaults();
    bindEvents();
    buildRulesTable();
    updateHead();
    showScreen("home");
    window.addEventListener("beforeunload", function (event) {
      if (
        App.connected &&
        App.game &&
        !App.leaving &&
        !App.suppressClose &&
        App.game.phase !== "gameover"
      ) {
        sendLeaveSignal();
        event.preventDefault();
        event.returnValue = "";
      }
    });

    if (!P2P.isSupported()) {
      setText("create-error", "当前浏览器不支持 WebRTC 联机，请使用最新版 Chrome / Edge / Safari。");
      setText("join-error", "当前浏览器不支持 WebRTC 联机，请使用最新版 Chrome / Edge / Safari。");
      $("btn-create").disabled = true;
      $("btn-read-invite").disabled = true;
    }

    if (/[?&]debug=1/.test(window.location.search)) {
      window.__diceDebug = {
        App: App,
        Engine: Engine,
        showScreen: showScreen,
        showTable: function (state) {
          if (state) App.game = state;
          showScreen("table");
          renderAll();
        },
        renderAll: renderAll,
        showGameOver: showGameOver,
        preview: mountDebugPreview
      };
    }
  });

  function initCreateDefaults() {
    var defaults = Engine.DEFAULT_SETTINGS;
    $("create-chips").value = defaults.startingChips;
    $("create-debt-limit").value = defaults.debtLimit;
    $("create-interest").value = defaults.interestRate;
    $("create-loans").checked = defaults.loansEnabled;
    $("create-fold").checked = defaults.allowFold;
    var modeInput = document.querySelector(
      'input[name="gameMode"][value="' + (defaults.gameMode || "classic") + '"]'
    );
    if (modeInput) modeInput.checked = true;
    syncModePicker();
    syncCreateLoanFields();
  }

  function syncModePicker() {
    var inputs = document.querySelectorAll('input[name="gameMode"]');
    for (var i = 0; i < inputs.length; i += 1) {
      var option = inputs[i].closest(".mode-option");
      if (option) option.classList.toggle("is-selected", inputs[i].checked);
    }
  }

  function syncCreateLoanFields() {
    var loans = $("create-loans").checked;
    setHidden($("debt-limit-field"), !loans);
    $("create-interest").disabled = !loans;
    var interestField = $("create-interest").closest(".field");
    if (interestField) interestField.style.opacity = loans ? "" : "0.42";
  }

  function setHomeMode(mode) {
    if (mode !== "create" && mode !== "join") return;
    var grid = $("home-grid");
    if (grid) grid.setAttribute("data-mode", mode);
    qsa("[data-home-tab]").forEach(function (tab) {
      var active = tab.getAttribute("data-home-tab") === mode;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  /* =========================================================
     Rules
     ========================================================= */

  function buildRulesTable() {
    var body = $("rules-hand-body");
    if (!body) return;
    body.innerHTML = "";
    Engine.HAND_GUIDE.forEach(function (row) {
      var tr = document.createElement("tr");
      var label = document.createElement("td");
      label.textContent = row.label;
      var term = document.createElement("span");
      term.className = "rule-term";
      term.textContent = " / " + row.term;
      label.appendChild(term);

      var dice = document.createElement("td");
      dice.textContent = row.dice;

      var strength = document.createElement("td");
      strength.textContent = row.strength;

      var odds = document.createElement("td");
      odds.className = "rules-odds";
      odds.textContent = row.odds;

      tr.appendChild(label);
      tr.appendChild(dice);
      tr.appendChild(strength);
      tr.appendChild(odds);
      body.appendChild(tr);
    });
  }

  /* =========================================================
     Event wiring
     ========================================================= */

  function bindEvents() {
    $("create-form").addEventListener("submit", onCreateRoom);
    $("join-form").addEventListener("submit", onReadInvite);
    $("create-loans").addEventListener("change", syncCreateLoanFields);
    qsa('input[name="gameMode"]').forEach(function (input) {
      input.addEventListener("change", syncModePicker);
    });
    qsa("[data-home-tab]").forEach(function (tab) {
      tab.addEventListener("click", function () {
        setHomeMode(tab.getAttribute("data-home-tab"));
      });
    });
    $("connect-back").addEventListener("click", leaveConnect);
    $("btn-generate-answer").addEventListener("click", onGenerateAnswer);
    $("btn-accept-answer").addEventListener("click", onAcceptAnswer);
    $("btn-start-game").addEventListener("click", onStartGame);
    $("btn-table-leave").addEventListener("click", confirmLeaveTable);
    $("btn-result-home").addEventListener("click", resetToHome);
    $("btn-disconnect-home").addEventListener("click", resetToHome);

    $("action-bet").addEventListener("submit", onBetSubmit);
    $("bet-input").addEventListener("input", updateBetHint);
    $("btn-roll-banker").addEventListener("click", function () {
      performLocal("bankerRoll", {});
    });
    $("btn-roll-child").addEventListener("click", function () {
      performLocal("childRoll", {});
    });
    $("btn-fold").addEventListener("click", onFoldClick);
    $("btn-ready").addEventListener("click", onReadyClick);
    $("btn-ready-loan").addEventListener("click", function () {
      openLoanModal(App.localId);
    });

    $("btn-borrow").addEventListener("click", onBorrowClick);
    $("btn-repay").addEventListener("click", onRepayClick);
    $("loan-borrow-input").addEventListener("input", renderLoanPreview);
    $("loan-repay-input").addEventListener("input", renderLoanPreview);

    $("link-home").addEventListener("click", function (event) {
      if (App.screen === "home") return;
      event.preventDefault();
      confirmGoHub();
    });

    document.addEventListener("click", function (event) {
      var copyButton = event.target.closest("[data-copy-target]");
      if (copyButton) {
        var target = $(copyButton.getAttribute("data-copy-target"));
        if (target && target.value) {
          UI.copyFrom(target, copyButton).then(function (ok) {
            UI.toast(ok ? "联机码已复制" : "复制失败，请手动选中复制", {
              type: ok ? "good" : "error"
            });
          });
        } else {
          UI.toast("还没有可复制的联机码。", { type: "error" });
        }
        return;
      }

      var loanButton = event.target.closest("[data-loan-player]");
      if (loanButton) {
        openLoanModal(loanButton.getAttribute("data-loan-player"));
        return;
      }

      var betQuick = event.target.closest("[data-bet-fill]");
      if (betQuick) {
        fillBet(Number(betQuick.getAttribute("data-bet-fill")));
        return;
      }

      var loanQuick = event.target.closest("[data-loan-fill]");
      if (loanQuick) {
        fillLoanInput(
          loanQuick.getAttribute("data-loan-fill"),
          Number(loanQuick.getAttribute("data-loan-pct")) || 1
        );
        return;
      }

      if (event.target.closest('[data-modal-open="modal-rules"]')) {
        window.setTimeout(function () {
          var panel = qs("#modal-rules .modal__panel");
          if (panel) panel.scrollTop = 0;
        }, 30);
      }
    });

  }

  /* =========================================================
     Home — create room
     ========================================================= */

  function readCreateForm() {
    var hostName = $("host-name").value.trim() || "房主";
    var modeInput = document.querySelector('input[name="gameMode"]:checked');
    var loans = $("create-loans").checked;
    var startingChips = Number($("create-chips").value);
    var debtLimit = Number($("create-debt-limit").value);
    if (!loans && (!Number.isFinite(debtLimit) || debtLimit < 1)) {
      debtLimit = Number.isFinite(startingChips) && startingChips >= 1 ? startingChips : 1;
    }
    var raw = {
      startingChips: startingChips,
      loansEnabled: loans,
      debtLimit: debtLimit,
      interestRate: loans ? Number($("create-interest").value) : 0,
      allowFold: $("create-fold").checked,
      gameMode: modeInput ? modeInput.value : "classic"
    };
    var validated = Engine.validateSettings(raw);
    if (!validated.ok) return { ok: false, error: validated.error };
    $("create-chips").value = validated.settings.startingChips;
    $("create-debt-limit").value = validated.settings.debtLimit;
    $("create-interest").value = validated.settings.interestRate;
    return { ok: true, hostName: hostName, settings: validated.settings };
  }

  function onCreateRoom(event) {
    event.preventDefault();
    if (!P2P.isSupported()) return;
    var error = $("create-error");
    error.classList.add("hidden");
    var form = readCreateForm();
    if (!form.ok) {
      error.textContent = form.error;
      error.classList.remove("hidden");
      error.scrollIntoView({ block: "nearest" });
      return;
    }

    App.role = "host";
    App.localId = "host";
    App.opToken += 1;
    var token = App.opToken;
    App.room = {
      hostName: form.hostName,
      guestName: "",
      settings: form.settings
    };
    App.connection = null;
    App.connected = false;
    App.roomEntered = false;

    prepareConnectHost();
    var room = {
      game: "dice-table",
      version: 1,
      hostName: form.hostName,
      settings: form.settings
    };

    P2P.createHost({
      room: room,
      callbacks: makeCallbacks("host", token)
    })
      .then(function (result) {
        if (token !== App.opToken) {
          result.session.close("stale");
          return;
        }
        App.connection = result.session;
        App._roomToastShown = false;
        $("invite-out").value = result.inviteCode;
        setHidden($("connect-loading"), true);
        setHidden($("host-connect-flow"), false);
        setText("connect-title", "把邀请码发给对方");
        setText("connect-lead", "对方读取邀请码后，会生成一段应答码。把它粘贴回第 2 步。");
        setConnectStatus("host", "等待对方生成应答码", false);
        updateHead();
        UI.toast("房间已创建，把邀请码发给对方。", { type: "good" });
      })
      .catch(function (err) {
        if (token !== App.opToken) return;
        showConnectFailure("无法创建房间", err && err.message ? err.message : "未知错误");
        UI.toast(err && err.message ? err.message : "创建房间失败", { type: "error" });
      });
  }

  function prepareConnectHost() {
    showScreen("connect");
    setText("connect-eyebrow", "Host a table");
    setText("connect-title", "正在准备房间");
    setText("connect-lead", "系统正在收集网络地址，并生成一次性邀请码。");
    setHidden($("connect-loading"), false);
    setText("connect-loading-text", "正在生成邀请码…");
    setHidden($("host-connect-flow"), true);
    setHidden($("guest-connect-flow"), true);
    setHidden($("answer-error"), true);
    $("answer-in").value = "";
    $("invite-out").value = "";
    updateConnectSummary();
    updateHead();
  }

  function showConnectFailure(title, message) {
    setHidden($("connect-loading"), true);
    setHidden($("host-connect-flow"), true);
    setHidden($("guest-connect-flow"), true);
    setText("connect-title", title);
    setText("connect-lead", message);
    setText("connect-eyebrow", "Connection failed");
    updateHead();
  }

  /* =========================================================
     Home — join room
     ========================================================= */

  function onReadInvite(event) {
    event.preventDefault();
    if (!P2P.isSupported()) return;
    var error = $("join-error");
    error.classList.add("hidden");
    var guestName = $("guest-name").value.trim() || "客人";
    var code = $("invite-code").value.trim();
    if (!code) {
      error.textContent = "请先粘贴房主发来的邀请码。";
      error.classList.remove("hidden");
      return;
    }

    var button = $("btn-read-invite");
    UI.setButtonBusy(button, true, "读取中…");

    P2P.decodeCode(code)
      .then(function (payload) {
        if (payload.k !== "offer") throw new Error("这是应答码，不是邀请码。");
        if (!payload.room || payload.room.game !== "dice-table") {
          throw new Error("这个邀请码不是「骰局」房间。");
        }
        var settingsResult = Engine.validateSettings(payload.room.settings || {});
        if (!settingsResult.ok) throw new Error(settingsResult.error);
        var hostName = String(payload.room.hostName || "").trim().slice(0, 14) || "房主";
        App.opToken += 1;
        App.role = "guest";
        App.localId = "guest";
        App.room = {
          hostName: hostName,
          guestName: guestName,
          settings: settingsResult.settings
        };
        App.invite = { code: code, payload: payload };
        App.connection = null;
        App.connected = false;
        App.roomEntered = false;
        prepareConnectGuest();
        UI.toast("邀请码已读取，请确认房间设置。", { type: "good" });
      })
      .catch(function (err) {
        error.textContent = err && err.message ? err.message : "邀请码读取失败。";
        error.classList.remove("hidden");
        UI.toast(error.textContent, { type: "error" });
      })
      .finally(function () {
        UI.setButtonBusy(button, false);
      });
  }

  function prepareConnectGuest() {
    showScreen("connect");
    setText("connect-eyebrow", "Guest · Invite accepted");
    setText("connect-title", "确认房间设置");
    setText("connect-lead", "看完设置后生成应答码，再把它发回给房主。");
    setHidden($("connect-loading"), true);
    setHidden($("host-connect-flow"), true);
    setHidden($("guest-connect-flow"), false);
    setHidden($("guest-answer-step"), true);
    setHidden($("btn-generate-answer"), false);
    $("answer-out").value = "";
    setConnectStatus("guest", "等待生成应答码", false);
    renderInviteSummary();
    updateConnectSummary();
    updateHead();
  }

  function renderInviteSummary() {
    var wrap = $("invite-summary");
    if (!wrap || !App.room) return;
    wrap.innerHTML = "";
    var settings = App.room.settings;
    var rows = [
      ["房主", App.room.hostName],
      ["对局模式", modeLabel(settings.gameMode)],
      ["初始筹码", fmt(settings.startingChips)],
      ["贷款", settings.loansEnabled ? "开启" : "关闭"],
      ["债务上限", settings.loansEnabled ? fmt(settings.debtLimit) : "—"],
      ["每手利率", settings.loansEnabled ? settings.interestRate + "%" : "—"],
      ["弃权", settings.allowFold ? "允许" : "禁止"]
    ];
    rows.forEach(function (row) {
      var div = document.createElement("div");
      var dt = document.createElement("dt");
      var dd = document.createElement("dd");
      dt.textContent = row[0];
      dd.textContent = row[1];
      div.appendChild(dt);
      div.appendChild(dd);
      wrap.appendChild(div);
    });
  }

  function onGenerateAnswer() {
    if (!App.invite || App.role !== "guest") return;
    var button = $("btn-generate-answer");
    UI.setButtonBusy(button, true, "正在生成…");
    setConnectStatus("guest", "正在收集网络地址并生成应答码…", false);
    var token = App.opToken;

    P2P.joinWithInvite(App.invite.code, {
      guestName: App.room.guestName,
      callbacks: makeCallbacks("guest", token)
    })
      .then(function (result) {
        if (token !== App.opToken) {
          result.session.close("stale");
          return;
        }
        App.connection = result.session;
        $("answer-out").value = result.answerCode;
        setHidden($("guest-answer-step"), false);
        setHidden($("btn-generate-answer"), true);
        setText("connect-title", "把应答码发回给房主");
        setText("connect-lead", "房主粘贴应答码后，连接会自动建立。保持页面打开。");
        setConnectStatus("guest", "把应答码发回给房主，等待连接建立", false);
        updateHead();
        UI.toast("应答码已生成。", { type: "good" });
      })
      .catch(function (err) {
        setConnectStatus("guest", err && err.message ? err.message : "生成应答码失败", true);
        UI.toast(err && err.message ? err.message : "生成应答码失败", { type: "error" });
      })
      .finally(function () {
        UI.setButtonBusy(button, false);
      });
  }

  function onAcceptAnswer() {
    if (!App.connection || App.role !== "host") return;
    var code = $("answer-in").value.trim();
    var errorNode = $("answer-error");
    errorNode.classList.add("hidden");
    if (!code) {
      errorNode.textContent = "请先粘贴对方发来的应答码。";
      errorNode.classList.remove("hidden");
      return;
    }
    var button = $("btn-accept-answer");
    UI.setButtonBusy(button, true, "连接中…");
    setConnectStatus("host", "正在建立点对点连接…", false);

    App.connection
      .acceptAnswer(code)
      .then(function (remoteMeta) {
        App.room.guestName = String(
          (remoteMeta && remoteMeta.guestName) || ""
        ).trim().slice(0, 14) || "客人";
        App.connected = true;
        App.roomEntered = false;
        enterRoom();
      })
      .catch(function (err) {
        errorNode.textContent = err && err.message ? err.message : "连接失败，请检查应答码。";
        errorNode.classList.remove("hidden");
        setConnectStatus("host", errorNode.textContent, true);
        UI.toast("连接失败，请重新交换联机码。", { type: "error" });
        UI.setButtonBusy(button, false);
      });
  }

  function setConnectStatus(which, text, isError) {
    var node = which === "host" ? $("host-connect-status") : $("guest-connect-status");
    if (!node) return;
    node.classList.toggle("is-error", !!isError);
    var span = node.querySelector("span:last-child");
    if (span) span.textContent = text;
  }

  function updateConnectSummary() {
    if (!App.room) return;
    var s = App.room.settings;
    setText("connect-host-name", App.room.hostName || "—");
    setText("connect-mode", modeLabel(s.gameMode));
    setText("connect-chips", fmt(s.startingChips));
    setText("connect-loans", s.loansEnabled ? "开启" : "关闭");
    setText("connect-debt", s.loansEnabled ? fmt(s.debtLimit) : "—");
    setText("connect-interest", s.loansEnabled ? s.interestRate + "% / 手" : "—");
    setText("connect-fold", s.allowFold ? "允许" : "禁止");
  }

  /* =========================================================
     P2P callbacks
     ========================================================= */

  function makeCallbacks(role, token) {
    return {
      onState: function (payload) {
        if (token !== App.opToken) return;
        var status = payload && payload.status ? payload.status : "connecting";
        if (App.screen !== "connect") return;
        if (status === "preparing" || status === "gathering") {
          setText(
            "connect-loading-text",
            status === "preparing" ? "正在创建房间…" : "正在收集网络地址…"
          );
        }
        if (App.role === "host" && !$("host-connect-flow").classList.contains("hidden")) {
          if (status === "connecting") setConnectStatus("host", "正在建立点对点连接…", false);
          if (status === "channel-ready") setConnectStatus("host", "已找到数据通道，等待连接…", false);
          if (status === "unstable") setConnectStatus("host", "网络波动，正在尝试恢复…", false);
        }
        if (App.role === "guest" && !$("guest-connect-flow").classList.contains("hidden")) {
          if (status === "connecting") setConnectStatus("guest", "正在建立点对点连接…", false);
          if (status === "channel-ready") setConnectStatus("guest", "已找到数据通道，等待房主连接", false);
          if (status === "waiting-host") setConnectStatus("guest", "把应答码发回给房主，等待连接建立", false);
          if (status === "unstable") setConnectStatus("guest", "网络波动，正在尝试恢复…", false);
        }
      },
      onOpen: function (session) {
        if (token !== App.opToken) return;
        App.connected = true;
        updateHead();
        if (role === "guest") {
          App.roomEntered = false;
          enterRoom();
        } else {
          setConnectStatus("host", "连接已建立，正在进入房间", false);
        }
      },
      onMessage: function (message) {
        if (token !== App.opToken) return;
        if (role === "host") handleGuestMessage(message);
        else handleHostMessage(message);
      },
      onClose: function (reason) {
        if (token !== App.opToken) return;
        handleSessionClose(reason);
      },
      onError: function (err) {
        if (token !== App.opToken) return;
        handleSessionError(err);
      }
    };
  }

  function handleSessionError(err) {
    var message = err && err.message ? err.message : "连接发生错误。";
    if (App.screen === "connect") {
      if (App.role === "host" && !$("host-connect-flow").classList.contains("hidden")) {
        setConnectStatus("host", message, true);
      }
      if (App.role === "guest" && !$("guest-connect-flow").classList.contains("hidden")) {
        setConnectStatus("guest", message, true);
      }
    }
    UI.toast(message, { type: "error" });
  }

  function peerLeft(reason) {
    if (App.suppressClose) return;
    var session = App.connection;
    App.suppressClose = true;
    if (session) {
      try {
        session.close("peer-left");
      } catch (err) {
        /* noop */
      }
    }
    App.suppressClose = false;
    App.connection = null;
    handleSessionClose(reason || "对方离开了牌桌");
  }

  function handleSessionClose(reason) {
    if (App.suppressClose || App.leaving) return;
    App.connected = false;
    App.connection = null;
    App.pending = false;
    clearPendingTimer();
    updateHead();
    if (App.screen === "connect") {
      showConnectFailure("连接已关闭", reason || "对方或本机已关闭连接，请重新生成联机码。");
      return;
    }
    if (App.screen === "table" && App.game && App.game.phase === "gameover") {
      return;
    }
    if (App.screen === "room" || App.screen === "table") {
      setText(
        "disconnect-copy",
        reason
          ? "连接中断：" + reason + "。本局无法继续。"
          : "对方已离开牌桌，连接已关闭。本局无法继续。"
      );
      UI.openModal("modal-disconnect");
    }
  }

  /* =========================================================
     Room & start
     ========================================================= */

  function enterRoom() {
    if (App.screen === "room" || App.screen === "table") return;
    if (!App.connection || !App.room) return;
    if (!App.room.guestName) App.room.guestName = "客人";
    App.roomEntered = true;
    App.connected = true;
    renderRoom();
    showScreen("room");
    updateHead();
    if (!App._roomToastShown) {
      UI.toast("连接已建立。", { type: "good" });
      App._roomToastShown = true;
    }
  }

  function renderRoom() {
    if (!App.room) return;
    var names = namesForRoom(App.room);
    setText("room-host-name", names.host);
    setText("room-guest-name", names.guest);
    renderRoomSettings(App.room.settings);
    var isHost = App.role === "host";
    setHidden($("btn-start-game"), !isHost);
    setHidden($("room-waiting-mark"), isHost);
    setText(
      "room-wait-note",
      isHost ? "双方已连接。设置不可再更改，确认后开始对局。" : "等待房主开始对局。"
    );
  }

  function renderRoomSettings(settings) {
    var wrap = $("room-settings");
    if (!wrap) return;
    wrap.innerHTML = "";
    var rows = [
      ["对局模式", modeLabel(settings.gameMode)],
      ["初始筹码", fmt(settings.startingChips)],
      ["贷款", settings.loansEnabled ? "开启" : "关闭"],
      ["债务上限", settings.loansEnabled ? fmt(settings.debtLimit) : "—"],
      ["每手利率", settings.loansEnabled ? settings.interestRate + "%" : "—"],
      ["弃权", settings.allowFold ? "允许" : "禁止"]
    ];
    rows.forEach(function (row) {
      var div = document.createElement("div");
      var dt = document.createElement("dt");
      var dd = document.createElement("dd");
      dt.textContent = row[0];
      dd.textContent = row[1];
      div.appendChild(dt);
      div.appendChild(dd);
      wrap.appendChild(div);
    });
  }

  function onStartGame() {
    if (App.role !== "host" || !App.connection || !App.connection.isOpen) {
      UI.toast("连接尚未建立。", { type: "error" });
      return;
    }
    if (!App.room) return;
    var button = $("btn-start-game");
    UI.setButtonBusy(button, true, "正在开局…");
    var created = Engine.createGame({
      settings: App.room.settings,
      hostName: App.room.hostName,
      guestName: App.room.guestName
    });
    if (!created.ok) {
      UI.setButtonBusy(button, false);
      UI.toast(created.error, { type: "error" });
      return;
    }
    App.game = created.state;
    App.localId = "host";
    App.connected = true;
    App.rackSigs = { banker: "", child: "" };
    App.lastBetKey = "";
    var sent = sendToPeer({ t: "start", state: publicState() });
    if (!sent) {
      UI.setButtonBusy(button, false);
      handleSessionClose("无法发送开局数据");
      return;
    }
    App.connected = true;
    showScreen("table");
    App.lastLogCount = 0;
    renderAll();
    updateHead();
    UI.toast("对局开始。", { type: "good" });
  }

  /* =========================================================
     Networking messages
     ========================================================= */

  function publicState() {
    return JSON.parse(JSON.stringify(App.game));
  }

  function sendToPeer(message) {
    if (!App.connection || !App.connection.isOpen) {
      UI.toast("连接已断开。", { type: "error" });
      return false;
    }
    var ok = App.connection.send(message);
    if (!ok) {
      UI.toast("消息发送失败，请检查连接。", { type: "error" });
    }
    return ok;
  }

  function broadcastState() {
    if (!App.game || !App.connected) return false;
    return sendToPeer({ t: "state", state: publicState() });
  }

  function handleGuestMessage(message) {
    if (!message) return;
    if (message.t === "leave") {
      peerLeft("对方离开了牌桌");
      return;
    }
    if (!App.game || App.role !== "host") return;
    if (message.t !== "intent") return;
    var result = performEngineAction("guest", message.kind, message.payload || {});
    if (!result.ok) {
      sendToPeer({ t: "error", message: result.error || "操作无效。" });
      return;
    }
    var sent = broadcastState();
    afterStateUpdate();
    if (!sent) handleSessionClose("无法把对局状态同步给对方");
  }

  function handleHostMessage(message) {
    if (!message) return;
    if (message.t === "leave") {
      peerLeft("对方离开了牌桌");
      return;
    }
    if (message.t === "error") {
      App.pending = false;
      clearPendingTimer();
      UI.toast(message.message || "操作未生效。", { type: "error" });
      renderAll();
      return;
    }
    if (message.t !== "start" && message.t !== "state") return;
    if (!isStateLike(message.state)) {
      UI.toast("收到的对局数据不完整。", { type: "error" });
      return;
    }
    App.pending = false;
    clearPendingTimer();
    var firstState = App.screen !== "table";
    App.game = message.state;
    App.connected = true;
    if (firstState) {
      App.rackSigs = { banker: "", child: "" };
      App.lastBetKey = "";
      App.lastLogCount = 0;
      showScreen("table");
    }
    renderAll();
    updateHead();
    if (App.game.phase === "gameover") showGameOver();
    else closeLoanIfUnavailable();
  }

  function isStateLike(state) {
    return !!(
      state &&
      typeof state === "object" &&
      state.players &&
      state.players.host &&
      state.players.guest &&
      state.settings &&
      typeof state.phase === "string" &&
      typeof state.handNo === "number"
    );
  }

  /* =========================================================
     Engine commands / pending
     ========================================================= */

  function performEngineAction(playerId, kind, payload) {
    if (!App.game) return { ok: false, error: "对局尚未开始。" };
    if (!App.connected) return { ok: false, error: "连接已断开。" };
    payload = payload || {};
    var state = App.game;
    var result;
    switch (kind) {
      case "bet":
        result = Engine.placeBet(state, playerId, Number(payload.amount));
        break;
      case "bankerRoll":
        result = Engine.rollBanker(state, playerId);
        break;
      case "childRoll":
        result = Engine.childAction(state, playerId, "roll");
        break;
      case "fold":
        result = Engine.childAction(state, playerId, "fold");
        break;
      case "loanBorrow":
        result = Engine.manageLoan(state, playerId, { borrow: Number(payload.amount) });
        break;
      case "loanRepay":
        result = Engine.manageLoan(state, playerId, { repay: Number(payload.amount) });
        break;
      case "ready":
        result = Engine.setReady(state, playerId, !!payload.ready);
        break;
      default:
        return { ok: false, error: "未知操作。" };
    }
    if (result && result.ok) App.game = result.state;
    return result || { ok: false, error: "操作失败。" };
  }

  function performLocal(kind, payload) {
    if (!App.connection || !App.connection.isOpen || !App.connected) {
      UI.toast("连接已断开，无法继续。", { type: "error" });
      return;
    }
    if (App.pending) return;
    if (App.role === "host") {
      var result = performEngineAction("host", kind, payload);
      if (!result.ok) {
        UI.toast(result.error || "操作无效。", { type: "error" });
        return;
      }
      var sent = broadcastState();
      afterStateUpdate();
      if (!sent) handleSessionClose("无法把对局状态同步给对方");
      return;
    }
    var sent = sendToPeer({ t: "intent", kind: kind, payload: payload || {} });
    if (sent) setPending(true);
  }

  function sendLeaveSignal() {
    if (App.connection && App.connection.isOpen) {
      try {
        App.connection.send({ t: "leave" });
      } catch (err) {
        /* noop */
      }
    }
  }

  function setPending(value) {
    App.pending = !!value;
    if (value) {
      clearPendingTimer();
      App.pendingTimer = window.setTimeout(function () {
        if (!App.pending) return;
        App.pending = false;
        UI.toast("操作确认超时，请检查连接或重试。", { type: "error" });
        renderActionDock();
      }, 12000);
    } else {
      clearPendingTimer();
    }
    renderActionDock();
  }

  function clearPendingTimer() {
    if (App.pendingTimer) {
      window.clearTimeout(App.pendingTimer);
      App.pendingTimer = null;
    }
  }

  function afterStateUpdate() {
    App.pending = false;
    clearPendingTimer();
    if (!App.game) return;
    if (App.screen !== "table") showScreen("table");
    App.connected = true;
    renderAll();
    updateHead();
    if (App.game.phase === "gameover") showGameOver();
    else closeLoanIfUnavailable();
  }

  function closeLoanIfUnavailable() {
    var modal = $("modal-loan");
    if (!modal || !modal.classList.contains("is-open")) return;
    if (!canManageLoans(App.loanPlayerId)) UI.closeModal("modal-loan");
    else renderLoanModal(false);
  }

  /* =========================================================
     Rendering
     ========================================================= */

  function renderAll() {
    if (!App.game) return;
    renderTable();
    updateHead();
  }

  function renderTable() {
    var g = App.game;
    if (!g) return;
    setText("table-context", "TABLE · 第 " + g.handNo + " 手");
    setText("table-settings", settingsSummary(g.settings));
    setText("table-hand", pad2(g.handNo));
    setText("log-hand", "HAND " + pad2(g.handNo));
    var betValue = qs("#stage-bet strong");
    if (betValue) betValue.textContent = g.bet ? fmt(g.bet) : "—";
    setText("head-round", "第 " + g.handNo + " 手");

    renderPlayerCards();
    renderRack("banker");
    renderRack("child");
    renderStage();
    renderActionDock();
    renderLog();
  }

  function renderPlayerCards() {
    var g = App.game;
    if (!g) return;
    var actorId =
      g.phase === "banker-turn"
        ? g.bankerId
        : g.phase === "betting" || g.phase === "child-decision"
        ? g.childId
        : null;

    PLAYER_IDS.forEach(function (id) {
      var p = g.players[id];
      if (!p) return;
      var card = qs('[data-player-card="' + id + '"]');
      if (!card) return;
      var roleBadge = qs('[data-role-badge="' + id + '"]');
      var youBadge = qs('[data-you-badge="' + id + '"]');
      var loanButton = qs('[data-loan-player="' + id + '"]');
      var nameNode = qs('[data-player-name="' + id + '"]');
      var chipsNode = qs('[data-player-chips="' + id + '"]');
      var debtNode = qs('[data-player-debt="' + id + '"]');
      var netNode = qs('[data-player-net="' + id + '"]');
      var stateNode = qs('[data-player-state="' + id + '"]');
      var readyNode = qs('[data-player-ready="' + id + '"]');
      var debtFigure = debtNode ? debtNode.closest(".debt-figure") : null;
      var netFigure = netNode ? netNode.closest(".net-figure") : null;

      if (nameNode) nameNode.textContent = p.name;
      if (chipsNode) chipsNode.textContent = fmt(p.chips);
      if (debtNode) {
        debtNode.textContent = fmt(p.debt);
        debtNode.classList.toggle("is-zero", p.debt === 0);
      }
      if (netNode) netNode.textContent = fmt(p.chips - p.debt);
      if (debtFigure) debtFigure.style.display = g.settings.loansEnabled ? "" : "none";
      if (netFigure) netFigure.style.display = g.settings.loansEnabled ? "" : "none";

      if (roleBadge) {
        roleBadge.textContent = id === g.bankerId ? "庄家" : "闲家";
        roleBadge.classList.toggle("is-banker", id === g.bankerId);
      }
      if (youBadge) setHidden(youBadge, id !== App.localId);
      card.classList.toggle("is-local", id === App.localId);
      card.classList.toggle("is-banker-now", id === g.bankerId);

      if (loanButton) {
        var showLoan =
          g.settings.loansEnabled && id === App.localId && g.phase !== "gameover";
        loanButton.style.display = showLoan ? "" : "none";
        loanButton.disabled = !canManageLoans(id);
      }

      if (stateNode) {
        stateNode.textContent = playerStatusText(id);
        stateNode.classList.toggle("is-active", !!actorId && actorId === id);
      }
      if (readyNode) {
        if (g.phase === "settled") {
          readyNode.textContent = p.ready ? "已准备" : "未准备";
          readyNode.classList.toggle("is-pending", !p.ready);
        } else {
          readyNode.textContent = "";
          readyNode.classList.remove("is-pending");
        }
      }
    });
  }

  function playerStatusText(id) {
    var g = App.game;
    var p = g.players[id];
    if (!p) return "";
    if (g.phase === "gameover") {
      if (g.gameOver && g.gameOver.draw) return "和局";
      return g.gameOver && g.gameOver.winnerId === id ? "胜者" : "终局";
    }
    if (g.phase === "betting") return id === g.childId ? "等待下注" : "等待闲家";
    if (g.phase === "banker-turn") return id === g.bankerId ? "等待掷骰" : "等待庄家";
    if (g.phase === "child-decision") return id === g.childId ? "考虑中" : "等待闲家";
    if (g.phase === "settled") return p.ready ? "已准备" : "可准备";
    return "";
  }

  function renderRack(role) {
    var g = App.game;
    if (!g) return;
    var id = role === "banker" ? g.bankerId : g.childId;
    var p = g.players[id];
    var rack = qs('[data-rack="' + role + '"]');
    var nameNode = qs('[data-rack-name="' + role + '"]');
    var diceRow = qs('[data-rack-dice="' + role + '"]');
    var handNode = qs('[data-rack-hand="' + role + '"]');
    var historyNode = qs('[data-rack-history="' + role + '"]');
    if (!rack || !p || !diceRow || !handNode) return;

    var rolls = role === "banker" ? g.bankerRolls : g.childRolls;
    var hand = role === "banker" ? g.bankerHand : g.childHand;
    var folded = role === "child" && g.outcome && g.outcome.type === "fold";
    var lastRoll = rolls && rolls.length ? rolls[rolls.length - 1] : null;
    var displayDice = !folded && lastRoll ? lastRoll.dice : null;

    if (nameNode) nameNode.textContent = p.name;

    var active =
      (role === "banker" && g.phase === "banker-turn") ||
      (role === "child" && g.phase === "child-decision");
    var isWinner =
      g.outcome && !g.outcome.draw && g.outcome.winnerId === id &&
      (g.phase === "settled" || g.phase === "gameover");
    rack.classList.toggle("is-active", active);
    rack.classList.toggle("is-winner", !!isWinner);

    var signature = JSON.stringify([
      g.handNo,
      role,
      displayDice,
      hand ? hand.label : null,
      hand ? hand.multiplier : null,
      hand ? hand.autoLoss : null,
      !!folded,
      rolls.length
    ]);
    var changed = App.rackSigs[role] !== signature;
    if (changed) {
      App.rackSigs[role] = signature;
      diceRow.innerHTML = "";
      var animate = !!(displayDice && displayDice.length);
      for (var i = 0; i < 3; i += 1) {
        var die = document.createElement("span");
        die.className = "die3d";
        if (displayDice && displayDice[i]) {
          UI.renderPips(die, displayDice[i]);
        } else {
          die.classList.add("is-empty");
        }
        diceRow.appendChild(die);
      }
      diceRow.classList.toggle("is-new", animate);
      diceRow.setAttribute(
        "aria-label",
        displayDice
          ? p.name + " 的骰子：" + displayDice.join("、")
          : p.name + " 尚未掷骰"
      );
    }

    handNode.innerHTML = "";
    handNode.classList.remove("is-set", "is-accent");
    if (folded) {
      handNode.textContent = "已弃权";
      handNode.classList.add("is-set");
    } else if (hand) {
      handNode.appendChild(document.createTextNode(hand.label));
      handNode.classList.add("is-set");
      var multiply = document.createElement("span");
      multiply.className = "hand-mult";
      if (hand.autoLoss) {
        multiply.textContent = "输 " + hand.multiplier + "×";
        multiply.classList.add("is-hot");
        handNode.classList.add("is-accent");
      } else if (hand.multiplier > 1) {
        multiply.textContent = "×" + hand.multiplier;
        multiply.classList.add("is-hot");
        handNode.classList.add("is-accent");
      } else {
        multiply.textContent = "×1";
      }
      handNode.appendChild(multiply);
    } else if (role === "banker") {
      handNode.textContent = g.phase === "betting" ? "等待下注" : "等待掷骰";
    } else if (
      (g.phase === "settled" || g.phase === "gameover") &&
      g.outcome &&
      (g.outcome.type === "banker-bust" || g.outcome.type === "banker-hifumi")
    ) {
      handNode.textContent = "无需掷骰";
    } else if (g.phase === "settled" || g.phase === "gameover") {
      handNode.textContent = "本手结束";
    } else if (g.phase === "child-decision") {
      handNode.textContent = "待决定";
    } else {
      handNode.textContent = "等待庄家";
    }

    if (historyNode) {
      historyNode.innerHTML = "";
      if (rolls && rolls.length && !folded) {
        rolls.forEach(function (roll, index) {
          var span = document.createElement("span");
          span.textContent =
            index + 1 + "投 " + roll.dice.join("·") + (roll.hand.resolved ? "" : " 无目");
          historyNode.appendChild(span);
        });
      }
    }
  }

  function renderStage() {
    var g = App.game;
    if (!g) return;
    var phaseNode = $("stage-phase");
    var outcomeNode = $("stage-outcome");
    var hasOutcome = !!g.outcome && (g.phase === "settled" || g.phase === "gameover");
    setHidden(outcomeNode, !hasOutcome);
    setHidden(phaseNode, hasOutcome);

    if (hasOutcome) {
      setText("stage-outcome-title", g.outcome.title);
      var detail = g.outcome.detail || "";
      var interestTotal = (g.outcome.interest || []).reduce(function (sum, line) {
        return sum + (line.amount || 0);
      }, 0);
      if (interestTotal > 0) {
        detail += " 本手计息 " + fmt(interestTotal) + "。";
      }
      setText("stage-outcome-detail", detail);

      var figures = $("stage-outcome-figures");
      figures.innerHTML = "";
      if (g.outcome.amount > 0) {
        figures.appendChild(makeOutcomeFigure("本手赔付", fmt(g.outcome.amount), false));
      }
      if (g.outcome.forcedBorrow > 0) {
        figures.appendChild(makeOutcomeFigure("强制借款", fmt(g.outcome.forcedBorrow), true));
      }
      if (interestTotal > 0) {
        figures.appendChild(makeOutcomeFigure("本手利息", fmt(interestTotal), true));
      }
      if (!figures.children.length) {
        figures.appendChild(makeOutcomeFigure("本手", "和局", false));
      }
    } else if (phaseNode) {
      var child = g.players[g.childId];
      var banker = g.players[g.bankerId];
      var text = "";
      if (g.phase === "betting") {
        text = child.name + " 正在决定注额 · 无时间限制";
      } else if (g.phase === "banker-turn") {
        text = "注额 " + fmt(g.bet) + " · 等待 " + banker.name + " 掷骰";
      } else if (g.phase === "child-decision") {
        text =
          "庄家 " + banker.name + " 已定牌：" + (g.bankerHand ? g.bankerHand.label : "—") +
          " · 等待 " + child.name + " 决定";
      } else if (g.phase === "gameover") {
        text = "对局结束。";
      }
      phaseNode.textContent = text;
    }
  }

  function makeOutcomeFigure(label, value, isDebt) {
    var div = document.createElement("div");
    if (isDebt) div.className = "is-debt";
    var span = document.createElement("span");
    var strong = document.createElement("strong");
    span.textContent = label;
    strong.textContent = value;
    div.appendChild(span);
    div.appendChild(strong);
    return div;
  }

  function hideActionControls() {
    ["action-wait", "action-bet", "action-banker", "action-child", "action-ready"].forEach(
      function (id) {
        setHidden($(id), true);
      }
    );
  }

  function setActionMeta(eyebrow, title, sub, tag) {
    setText("action-eyebrow", eyebrow);
    setText("action-title", title);
    setText("action-sub", sub || "");
    setText("action-turn-tag", tag || "");
  }

  function showActionWait(text, title, sub, tag) {
    setHidden($("action-wait"), false);
    setText("action-wait-text", text);
    setActionMeta("Waiting", title, sub, tag || "WAITING");
  }

  function renderActionDock() {
    var g = App.game;
    hideActionControls();
    if (!g) {
      showActionWait("等待对局开始", "等待开始", "", "WAITING");
      return;
    }
    if (App.game.phase === "gameover") {
      showActionWait("对局已结束，查看终局结算", "牌局结束", "", "GAME OVER");
      setText("action-status", "终局");
      return;
    }
    if (App.pending) {
      showActionWait("正在等待对方确认本次操作…", "同步中", "", "SYNCING");
      setText("action-status", "正在同步…");
      return;
    }
    if (!App.connected || !App.connection || !App.connection.isOpen) {
      showActionWait("连接已断开", "无法继续", "请返回首页重新联机。", "OFFLINE");
      setText("action-status", "连接中断");
      return;
    }

    var isChild = App.localId === g.childId;
    var isBanker = App.localId === g.bankerId;
    var local = localPlayer();
    var child = g.players[g.childId];
    var banker = g.players[g.bankerId];

    setText("action-status", "无时间限制 · 请从容决定");
    setHidden($("action-wait"), false);

    if (g.phase === "betting" && isChild) {
      hideActionControls();
      setHidden($("action-bet"), false);
      setActionMeta(
        "Your bet",
        "轮到你下注",
        "注额最少 1，最多不超过当前筹码。",
        "YOUR TURN"
      );
      prepareBetInput();
      return;
    }

    if (g.phase === "betting" && isBanker) {
      showActionWait(
        "等待 " + child.name + " 下注",
        "等待对方下注",
        "闲家可以先用贷款调整筹码。",
        "WAITING"
      );
      setText("action-status", "无时间限制");
      return;
    }

    if (g.phase === "banker-turn" && isBanker) {
      hideActionControls();
      setHidden($("action-banker"), false);
      setText(
        "banker-roll-copy",
        g.settings.gameMode === "single"
          ? "一投定局，无目判负。"
          : "最多三投，出有效牌型即停。无目自动判负。"
      );
      setActionMeta(
        "Your roll",
        "轮到你掷骰",
        "本手注额 " + fmt(g.bet) + "。" +
          (g.settings.gameMode === "single"
            ? "一投定局，无目判负。"
            : "出有效牌型即停，最多三投。"),
        "YOUR TURN"
      );
      return;
    }

    if (g.phase === "banker-turn" && isChild) {
      showActionWait(
        "等待 " + banker.name + " 掷骰",
        "等待庄家",
        "庄家的牌会显示在牌桌上。",
        "WAITING"
      );
      return;
    }

    if (g.phase === "child-decision" && isChild) {
      hideActionControls();
      setHidden($("action-child"), false);
      var fee = Math.max(1, Math.ceil(g.bet * Engine.FOLD_RATE));
      setText(
        "child-control-copy",
        "庄家已定牌：" + (g.bankerHand ? g.bankerHand.label : "—") + "。" +
          (g.settings.gameMode === "single"
            ? "你只有一投，无目判负；也可以弃权。"
            : "你可以弃权，或掷骰比牌。")
      );
      var foldButton = $("btn-fold");
      setHidden(foldButton, !g.settings.allowFold);
      foldButton.textContent = "弃权 · 付 " + fmt(fee);
      setActionMeta(
        "Your call",
        "看完庄家的牌",
        "弃权费为注额的 50%，向上取整；" +
          (g.settings.gameMode === "single"
            ? "掷骰一投定局，无目判负。"
            : "掷骰最多三投，按牌型结算。"),
        "YOUR TURN"
      );
      return;
    }

    if (g.phase === "child-decision" && isBanker) {
      showActionWait(
        "等待 " + child.name + " 决定弃权或掷骰",
        "等待对方决定",
        "庄家已定牌：" + (g.bankerHand ? g.bankerHand.label : "—"),
        "WAITING"
      );
      return;
    }

    if (g.phase === "settled") {
      hideActionControls();
      setHidden($("action-ready"), false);
      var other = g.players[otherId(App.localId)];
      var readyText = local.ready && other.ready
        ? "双方已准备。"
        : local.ready
        ? "你已准备，等待对方。"
        : other.ready
        ? "对方已准备，等你。"
        : "双方尚未准备。";
      setText("ready-copy", "整理贷款后准备下一手。" + readyText);
      var readyButton = $("btn-ready");
      readyButton.textContent = local.ready ? "取消准备" : "准备下一手";
      readyButton.classList.toggle("btn--accent", !local.ready);
      readyButton.classList.toggle("btn--ghost", local.ready);
      var loanButton = $("btn-ready-loan");
      setHidden(loanButton, !g.settings.loansEnabled);
      loanButton.disabled = local.ready || !canManageLoans(App.localId);
      setActionMeta(
        "Between hands",
        "本手结束",
        g.settings.loansEnabled
          ? "可以整理贷款；双方准备后进入下一手。"
          : "双方准备后进入下一手。",
        "BETWEEN HANDS"
      );
      setText("action-status", "计息已完成 · 无时间限制");
      return;
    }

    showActionWait("等待下一步", "等待中", "", "WAITING");
  }

  function prepareBetInput() {
    var g = App.game;
    var local = localPlayer();
    if (!g || !local) return;
    var input = $("bet-input");
    var max = Math.max(0, local.chips);
    var key = g.handNo + ":" + local.id;
    input.max = String(Math.max(1, max));
    if (App.lastBetKey !== key) {
      App.lastBetKey = key;
      input.value = max > 0 ? String(Math.min(100, max)) : "";
    }
    if (document.activeElement !== input) {
      var value = Number(input.value);
      if (!Number.isFinite(value) || value < 1) value = max > 0 ? Math.min(100, max) : 0;
      if (max > 0) value = Math.min(max, Math.max(1, Math.round(value)));
      input.value = max > 0 ? String(value) : "";
    }
    $("btn-bet").disabled = max < 1 || App.pending || !App.connected;
    updateBetHint();
  }

  function updateBetHint() {
    var g = App.game;
    var local = localPlayer();
    var hint = $("bet-hint");
    if (!hint || !g || !local) return;
    var input = $("bet-input");
    var max = local.chips;
    if (max < 1) {
      hint.textContent = g.settings.loansEnabled
        ? "当前没有筹码。请先用左侧「贷款」按钮借款。"
        : "当前没有筹码，无法下注。";
      return;
    }
    var value = Number(input.value);
    var parts = ["可用筹码 " + fmt(max)];
    if (Number.isFinite(value) && value > max) parts.push("已超过可下注上限");
    if (g.settings.loansEnabled) parts.push("可先贷款再下注");
    parts.push("无时间限制");
    hint.textContent = parts.join(" · ");
  }

  function fillBet(ratio) {
    var g = App.game;
    var local = localPlayer();
    if (!g || !local || g.phase !== "betting") return;
    var max = Math.max(0, local.chips);
    if (!max) return;
    var amount = ratio >= 1 ? max : Math.max(1, Math.floor(max * ratio));
    amount = Math.min(max, amount);
    var input = $("bet-input");
    input.value = String(amount);
    updateBetHint();
  }

  function renderLog() {
    var g = App.game;
    var list = $("log-list");
    if (!g || !list) return;
    var wasNearBottom =
      list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    var newEntries = g.log.length - App.lastLogCount;
    list.innerHTML = "";
    var fragment = document.createDocumentFragment();
    g.log.forEach(function (entry) {
      var row = document.createElement("div");
      row.className = "log-entry log-entry--" + (entry.kind || "info");
      var hand = document.createElement("span");
      hand.className = "log-entry__hand";
      hand.textContent = "H" + pad2(entry.handNo || g.handNo);
      var text = document.createElement("span");
      text.className = "log-entry__text";
      text.textContent = entry.text;
      row.appendChild(hand);
      row.appendChild(text);
      fragment.appendChild(row);
    });
    list.appendChild(fragment);
    App.lastLogCount = g.log.length;
    if (wasNearBottom || newEntries > 0) {
      list.scrollTop = list.scrollHeight;
    }
  }

  /* =========================================================
     Actions
     ========================================================= */

  function onBetSubmit(event) {
    event.preventDefault();
    var g = App.game;
    if (!g || g.phase !== "betting" || App.localId !== g.childId) return;
    var amount = Number($("bet-input").value);
    var local = localPlayer();
    if (!Number.isFinite(amount) || Math.floor(amount) !== amount || amount < 1) {
      UI.toast("请输入大于 0 的整数注额。", { type: "error" });
      return;
    }
    if (amount > local.chips) {
      UI.toast("注额不能超过当前筹码。", { type: "error" });
      return;
    }
    performLocal("bet", { amount: amount });
  }

  function onFoldClick() {
    var g = App.game;
    if (!g || g.phase !== "child-decision" || App.localId !== g.childId) return;
    if (!g.settings.allowFold) return;
    var fee = Math.max(1, Math.ceil(g.bet * Engine.FOLD_RATE));
    UI.confirm({
      title: "确认弃权？",
      message:
        "弃权将支付 " + fmt(fee) + " 筹码（注额的 50%，向上取整），本手立即结束。",
      confirmLabel: "弃权",
      danger: true
    }).then(function (ok) {
      if (ok) performLocal("fold", {});
    });
  }

  function onReadyClick() {
    var g = App.game;
    if (!g || g.phase !== "settled") return;
    var local = localPlayer();
    performLocal("ready", { ready: !local.ready });
  }

  /* =========================================================
     Loans
     ========================================================= */

  function maxBorrowFor(p) {
    if (!App.game || !App.game.settings.loansEnabled) return 0;
    return Math.max(0, App.game.settings.debtLimit - p.debt);
  }

  function canManageLoans(playerId) {
    if (!playerId || playerId !== App.localId) return false;
    var g = App.game;
    if (!g || !g.settings.loansEnabled || g.phase === "gameover") return false;
    if (g.phase !== "betting" && g.phase !== "settled") return false;
    if (!App.connected || !App.connection || !App.connection.isOpen) return false;
    if (App.pending) return false;
    var p = g.players[playerId];
    if (!p) return false;
    if (g.phase === "settled" && p.ready) return false;
    return true;
  }

  function openLoanModal(playerId) {
    if (playerId !== App.localId) return;
    if (!canManageLoans(playerId)) {
      UI.toast(
        App.game && App.game.phase === "settled" && player(playerId).ready
          ? "取消准备后才能操作贷款。"
          : "现在不能操作贷款。",
        { type: "error" }
      );
      return;
    }
    App.loanPlayerId = playerId;
    $("loan-borrow-input").value = "";
    $("loan-repay-input").value = "";
    renderLoanModal(true);
    UI.openModal("modal-loan", { focus: "#loan-borrow-input" });
  }

  function renderLoanModal(resetValues) {
    var g = App.game;
    var id = App.loanPlayerId;
    if (!g || !id || !g.players[id]) return;
    var p = g.players[id];
    var maxBorrow = maxBorrowFor(p);
    var maxRepay = Math.min(p.chips, p.debt);
    setText("loan-player-name", p.name);
    setText("loan-chips", fmt(p.chips));
    setText("loan-debt", fmt(p.debt));
    setText("loan-credit", fmt(maxBorrow));
    setText(
      "loan-rule-line",
      "每手利息 " + g.settings.interestRate + "% · 债务上限 " +
        fmt(g.settings.debtLimit) + " · 净资产 " + fmt(p.chips - p.debt)
    );
    var borrowInput = $("loan-borrow-input");
    var repayInput = $("loan-repay-input");
    borrowInput.max = String(Math.max(1, maxBorrow));
    repayInput.max = String(Math.max(1, maxRepay));
    var allowed = canManageLoans(id);
    borrowInput.disabled = !allowed;
    repayInput.disabled = !allowed;
    setText(
      "loan-repay-note",
      maxRepay > 0
        ? "最多可还 " + fmt(maxRepay) + "，还清后欠款归零。"
        : "当前没有可还款的筹码或欠款。"
    );
    if (resetValues) {
      borrowInput.value = "";
      repayInput.value = "";
    }
    renderLoanPreview();
    qsa("[data-loan-fill]").forEach(function (btn) {
      var kind = btn.getAttribute("data-loan-fill");
      var max = kind === "borrow" ? maxBorrow : maxRepay;
      btn.disabled = max <= 0 || !allowed;
    });
    var borrowButton = $("btn-borrow");
    var repayButton = $("btn-repay");
    borrowButton.disabled = !allowed || maxBorrow <= 0;
    repayButton.disabled = !allowed || maxRepay <= 0;
    borrowButton.textContent = maxBorrow > 0 ? "确认借款" : "无可借额度";
    repayButton.textContent = maxRepay > 0 ? "确认还款" : "暂无可还";
    renderLoanPreview();
  }

  function renderLoanPreview() {
    var g = App.game;
    var p = App.loanPlayerId && g ? g.players[App.loanPlayerId] : null;
    if (!g || !p) return;
    var maxBorrow = maxBorrowFor(p);
    var maxRepay = Math.min(p.chips, p.debt);
    var borrow = Number($("loan-borrow-input").value);
    var repay = Number($("loan-repay-input").value);
    var allowed = canManageLoans(p.id);
    var warning = $("borrow-warning");
    warning.classList.add("hidden");
    warning.textContent = "";
    if (Number.isFinite(borrow) && borrow > 0) {
      if (borrow > maxBorrow) {
        warning.textContent = "最多还能借 " + fmt(maxBorrow) + "。";
        warning.classList.remove("hidden");
      } else if (p.debt + borrow >= g.settings.debtLimit) {
        warning.textContent =
          "这笔借款会让累计欠款达到债务上限 " + fmt(g.settings.debtLimit) +
          "，对局会立即结束。";
        warning.classList.remove("hidden");
      }
    }
    $("btn-borrow").disabled =
      !allowed || !Number.isFinite(borrow) || borrow <= 0 || borrow > maxBorrow;
    $("btn-repay").disabled =
      !allowed || !Number.isFinite(repay) || repay <= 0 || repay > maxRepay;
  }

  function fillLoanInput(kind, pct) {
    var g = App.game;
    var p = App.loanPlayerId && g ? g.players[App.loanPlayerId] : null;
    if (!g || !p) return;
    var max = kind === "borrow" ? maxBorrowFor(p) : Math.min(p.chips, p.debt);
    if (max <= 0) return;
    var amount = pct >= 1 ? max : Math.max(1, Math.floor(max * pct));
    amount = Math.min(max, amount);
    var input = kind === "borrow" ? $("loan-borrow-input") : $("loan-repay-input");
    input.value = String(amount);
    renderLoanPreview();
  }

  function onBorrowClick() {
    var g = App.game;
    var p = App.loanPlayerId && g ? g.players[App.loanPlayerId] : null;
    if (!g || !p) return;
    if (!canManageLoans(p.id)) {
      UI.toast("现在不能操作贷款。", { type: "error" });
      return;
    }
    var maxBorrow = maxBorrowFor(p);
    var amount = Number($("loan-borrow-input").value);
    if (!Number.isFinite(amount) || Math.floor(amount) !== amount || amount < 1) {
      UI.toast("请输入大于 0 的整数借款金额。", { type: "error" });
      return;
    }
    if (amount > maxBorrow) {
      UI.toast("最多还能借 " + fmt(maxBorrow) + "。", { type: "error" });
      return;
    }
    var proceed = function () {
      UI.closeModal("modal-loan");
      performLocal("loanBorrow", { amount: amount });
    };
    if (p.debt + amount >= g.settings.debtLimit) {
      UI.confirm({
        title: "这会结束对局",
        message:
          "借款后累计欠款会达到债务上限 " + fmt(g.settings.debtLimit) +
          "，你将立即判负。确定继续吗？",
        confirmLabel: "仍然借款",
        danger: true
      }).then(function (ok) {
        if (ok) proceed();
      });
      return;
    }
    proceed();
  }

  function onRepayClick() {
    var g = App.game;
    var p = App.loanPlayerId && g ? g.players[App.loanPlayerId] : null;
    if (!g || !p) return;
    if (!canManageLoans(p.id)) {
      UI.toast("现在不能操作贷款。", { type: "error" });
      return;
    }
    var maxRepay = Math.min(p.chips, p.debt);
    var amount = Number($("loan-repay-input").value);
    if (!Number.isFinite(amount) || Math.floor(amount) !== amount || amount < 1) {
      UI.toast("请输入大于 0 的整数还款金额。", { type: "error" });
      return;
    }
    if (amount > maxRepay) {
      UI.toast("最多还能还 " + fmt(maxRepay) + "。", { type: "error" });
      return;
    }
    UI.closeModal("modal-loan");
    performLocal("loanRepay", { amount: amount });
  }

  /* =========================================================
     Game over / disconnect / reset
     ========================================================= */

  function showGameOver() {
    var g = App.game;
    if (!g || g.phase !== "gameover" || !g.gameOver) return;
    UI.closeModal("modal-loan");
    var draw = !!g.gameOver.draw;
    var won = g.gameOver.winnerId === App.localId;
    setText("result-title", draw ? "平局" : won ? "你赢了" : "你输了");
    setText("result-stamp", draw ? "和" : won ? "胜" : "负");
    setText("result-reason", g.gameOver.detail || "");
    renderResultPlayers();
    renderResultStats();
    var overlay = $("gameover-overlay");
    overlay.classList.remove("hidden");
    document.body.classList.add("has-result");
    App.resultShown = true;
    window.setTimeout(function () {
      var button = $("btn-result-home");
      if (button) button.focus({ preventScroll: true });
    }, 60);
  }

  function renderResultPlayers() {
    var g = App.game;
    var wrap = $("result-duelists");
    if (!wrap) return;
    wrap.innerHTML = "";
    PLAYER_IDS.forEach(function (id) {
      var p = g.players[id];
      var card = document.createElement("div");
      card.className = "result-player";
      var head = document.createElement("div");
      head.className = "result-player__head";
      var seal = document.createElement("span");
      seal.className = "result-seal";
      seal.textContent = id === "host" ? "甲" : "乙";
      var name = document.createElement("span");
      name.className = "result-player__name";
      name.textContent = p.name;
      var tag = document.createElement("span");
      tag.className = "result-player__tag";
      tag.textContent = id === App.localId ? "YOU" : roleLabel(id);
      head.appendChild(seal);
      head.appendChild(name);
      head.appendChild(tag);

      var nums = document.createElement("div");
      nums.className = "result-player__numbers";
      nums.appendChild(makeResultNumber("筹码", fmt(p.chips), false));
      if (g.settings.loansEnabled) {
        nums.appendChild(makeResultNumber("欠款", fmt(p.debt), p.debt > 0));
        nums.appendChild(makeResultNumber("净资产", fmt(p.chips - p.debt), p.chips - p.debt < 0));
      }
      card.appendChild(head);
      card.appendChild(nums);
      wrap.appendChild(card);
    });
  }

  function makeResultNumber(label, value, negative) {
    var div = document.createElement("div");
    if (negative) div.className = "is-negative";
    var span = document.createElement("span");
    var strong = document.createElement("strong");
    span.textContent = label;
    strong.textContent = value;
    div.appendChild(span);
    div.appendChild(strong);
    return div;
  }

  function renderResultStats() {
    var g = App.game;
    var wrap = $("result-stats");
    if (!wrap) return;
    wrap.innerHTML = "";
    var totalBorrowed = 0;
    var totalInterest = 0;
    var totalRepaid = 0;
    PLAYER_IDS.forEach(function (id) {
      totalBorrowed += g.players[id].stats.borrowed || 0;
      totalInterest += g.players[id].stats.interest || 0;
      totalRepaid += g.players[id].stats.repaid || 0;
    });
    var stats = [
      ["本局手数", String(g.handNo)],
      ["累计借款", fmt(totalBorrowed)],
      ["累计利息", fmt(totalInterest)],
      ["累计还款", fmt(totalRepaid)]
    ];
    stats.forEach(function (row) {
      var div = document.createElement("div");
      var span = document.createElement("span");
      var strong = document.createElement("strong");
      span.textContent = row[0];
      strong.textContent = row[1];
      div.appendChild(span);
      div.appendChild(strong);
      wrap.appendChild(div);
    });
  }

  function hideGameOver() {
    var overlay = $("gameover-overlay");
    if (overlay) overlay.classList.add("hidden");
    document.body.classList.remove("has-result");
    App.resultShown = false;
  }

  function confirmLeaveTable() {
    if (!App.game) {
      resetToHome();
      return;
    }
    UI.confirm({
      title: "离开牌桌？",
      message: "连接会断开，本局无法继续或恢复。",
      confirmLabel: "离开",
      danger: true
    }).then(function (ok) {
      if (ok) resetToHome();
    });
  }

  function confirmGoHub() {
    if (!App.connected && !App.game && App.screen === "home") return;
    UI.confirm({
      title: "返回游戏集？",
      message: App.connected || App.game
        ? "离开会断开当前连接，本局无法恢复。"
        : "返回游戏集首页。",
      confirmLabel: "离开",
      danger: !!(App.connected || App.game)
    }).then(function (ok) {
      if (!ok) return;
      sendLeaveSignal();
      App.suppressClose = true;
      window.location.href = "../../index.html";
    });
  }

  function resetToHome() {
    App.opToken += 1;
    sendLeaveSignal();
    App.suppressClose = true;
    if (App.connection) {
      try {
        App.connection.close("离开房间");
      } catch (err) {
        /* noop */
      }
    }
    App.connection = null;
    clearPendingTimer();
    App.connected = false;
    App.role = null;
    App.localId = null;
    App.pending = false;
    App.room = null;
    App.invite = null;
    App.game = null;
    App.roomEntered = false;
    App.resultShown = false;
    App.rackSigs = { banker: "", child: "" };
    App.lastBetKey = "";
    App.lastLogCount = 0;
    App.loanPlayerId = null;
    App._roomToastShown = false;
    hideGameOver();
    UI.closeModal("modal-loan");
    UI.closeModal("modal-disconnect");
    $("invite-out").value = "";
    $("answer-in").value = "";
    $("answer-out").value = "";
    $("answer-error").classList.add("hidden");
    $("create-error").classList.add("hidden");
    $("join-error").classList.add("hidden");
    UI.setButtonBusy($("btn-start-game"), false);
    UI.setButtonBusy($("btn-accept-answer"), false);
    showScreen("home");
    updateHead();
    App.suppressClose = false;
    UI.toast("已返回首页。");
  }

  function leaveConnect() {
    resetToHome();
  }

  /* =========================================================
     Debug-only preview
     ========================================================= */

  function mountDebugPreview() {
    var created = Engine.createGame({
      settings: Engine.DEFAULT_SETTINGS,
      hostName: "阿甲",
      guestName: "阿乙"
    });
    if (!created.ok) return;
    App.role = "host";
    App.localId = "host";
    App.connected = true;
    App.connection = {
      isOpen: true,
      send: function () {
        return true;
      },
      close: function () {}
    };
    App.room = {
      hostName: "阿甲",
      guestName: "阿乙",
      settings: created.state.settings
    };
    App.game = created.state;
    App.rackSigs = { banker: "", child: "" };
    App.lastBetKey = "";
    App.lastLogCount = 0;
    showScreen("table");
    renderAll();
  }
})();

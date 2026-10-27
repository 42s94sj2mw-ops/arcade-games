/* =========================================================
   骰局 — authoritative game engine
   No DOM, no network. The host runs this engine; both clients
   render the resulting plain state.
   ========================================================= */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DiceEngine = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var VERSION = 1;
  var FOLD_RATE = 0.5;
  var MAX_LOG = 64;
  var PLAYERS = ["host", "guest"];
  var CN_NUM = ["零", "一", "二", "三", "四", "五", "六"];
  var PLAYER_LABEL = { host: "房主", guest: "客人" };

  var DEFAULT_SETTINGS = {
    startingChips: 1000,
    loansEnabled: true,
    debtLimit: 2000,
    interestRate: 5,
    allowFold: true
  };

  var LIMITS = {
    startingChips: [1, 100000000],
    debtLimit: [1, 100000000],
    interestRate: [0, 100]
  };

  var HAND_GUIDE = [
    {
      key: "pinzoro",
      dice: "1 · 1 · 1",
      label: "一之豹",
      term: "ピンゾロ",
      strength: "最强",
      odds: "赢 5 倍",
      multiplier: 5
    },
    {
      key: "arashi",
      dice: "2 · 2 · 2 — 6 · 6 · 6",
      label: "豹子",
      term: "アラシ",
      strength: "第二",
      odds: "赢 3 倍",
      multiplier: 3
    },
    {
      key: "shigoro",
      dice: "4 · 5 · 6",
      label: "四五六",
      term: "シゴロ",
      strength: "第三",
      odds: "赢 2 倍",
      multiplier: 2
    },
    {
      key: "point",
      dice: "对子 + 单骰，单骰为点数",
      label: "普通目",
      term: "目",
      strength: "6 > 5 > … > 1",
      odds: "赢 1 倍",
      multiplier: 1
    },
    {
      key: "hifumi",
      dice: "1 · 2 · 3",
      label: "一二三",
      term: "ヒフミ",
      strength: "负牌",
      odds: "输 2 倍",
      multiplier: 2
    },
    {
      key: "bust",
      dice: "三次无目",
      label: "无目",
      term: "目なし",
      strength: "负牌",
      odds: "输 1 倍",
      multiplier: 1
    }
  ];

  function isPlainInt(value) {
    return typeof value === "number" && Number.isFinite(value) && Math.floor(value) === value;
  }

  function isNum(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function fail(message) {
    return { ok: false, error: message };
  }

  function good(state) {
    return { ok: true, state: state };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeName(name, fallback) {
    var text = String(name == null ? "" : name).trim();
    if (!text) text = fallback;
    return text.slice(0, 14);
  }

  function normalizeSettings(raw) {
    raw = raw || {};
    var settings = {
      startingChips: isPlainInt(raw.startingChips) ? raw.startingChips : DEFAULT_SETTINGS.startingChips,
      loansEnabled: raw.loansEnabled !== false,
      debtLimit: isPlainInt(raw.debtLimit) ? raw.debtLimit : DEFAULT_SETTINGS.debtLimit,
      interestRate: isNum(raw.interestRate) ? raw.interestRate : DEFAULT_SETTINGS.interestRate,
      allowFold: raw.allowFold !== false
    };
    if (settings.startingChips < LIMITS.startingChips[0] || settings.startingChips > LIMITS.startingChips[1]) {
      return { error: "初始筹码需在 1 到 100,000,000 之间。" };
    }
    if (settings.debtLimit < LIMITS.debtLimit[0] || settings.debtLimit > LIMITS.debtLimit[1]) {
      return { error: "债务上限需在 1 到 100,000,000 之间。" };
    }
    if (!isNum(settings.interestRate) || settings.interestRate < 0 || settings.interestRate > 100) {
      return { error: "每手利率需在 0% 到 100% 之间。" };
    }
    // Keep interest to one decimal place to match the input.
    settings.interestRate = Math.round(settings.interestRate * 10) / 10;
    if (!settings.loansEnabled) settings.interestRate = 0;
    return { settings: settings };
  }

  function defaultRng(min, max) {
    var range = max - min + 1;
    var cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : null;
    if (!cryptoObj || !cryptoObj.getRandomValues) {
      return min + Math.floor(Math.random() * range);
    }
    var array = new Uint32Array(1);
    var limit = Math.floor(4294967296 / range) * range;
    var value;
    do {
      cryptoObj.getRandomValues(array);
      value = array[0];
    } while (value >= limit);
    return min + (value % range);
  }

  function makeHand(data) {
    return Object.assign(
      {
        resolved: true,
        autoLoss: false,
        point: null,
        combo: ""
      },
      data
    );
  }

  function bustHand() {
    return makeHand({
      kind: "bust",
      label: "无目",
      term: "目なし",
      rank: -200,
      multiplier: 1,
      autoLoss: true
    });
  }

  function noHand() {
    return makeHand({
      kind: "none",
      label: "无目",
      term: "目なし",
      rank: -999,
      multiplier: 0,
      resolved: false,
      autoLoss: false
    });
  }

  /**
   * Evaluate three dice as a hand.
   * rank is only used between resolved, non-automatic hands.
   */
  function evaluateRoll(dice) {
    if (!Array.isArray(dice) || dice.length !== 3) {
      throw new Error("需要三颗骰子。");
    }
    var d = dice.map(function (value) {
      if (!isPlainInt(value) || value < 1 || value > 6) {
        throw new Error("骰子点数必须为 1–6。");
      }
      return value;
    });
    var sorted = d.slice().sort(function (a, b) { return a - b; });
    var key = sorted.join("");
    var combo = sorted.join(" · ");
    var unique = sorted.filter(function (value, index) {
      return index === 0 || value !== sorted[index - 1];
    });
    var counts = {};
    d.forEach(function (value) {
      counts[value] = (counts[value] || 0) + 1;
    });
    var pairs = Object.keys(counts).filter(function (value) {
      return counts[value] === 2;
    });
    var triples = Object.keys(counts).filter(function (value) {
      return counts[value] === 3;
    });

    if (triples.length === 1) {
      var triple = Number(triples[0]);
      if (triple === 1) {
        return makeHand({
          kind: "pinzoro",
          label: "一之豹",
          term: "ピンゾロ",
          rank: 900,
          multiplier: 5,
          combo: combo
        });
      }
      return makeHand({
        kind: "arashi",
        label: CN_NUM[triple] + "之豹",
        term: "アラシ",
        rank: 800 + triple * 10,
        multiplier: 3,
        combo: combo
      });
    }

    if (key === "456") {
      return makeHand({
        kind: "shigoro",
        label: "四五六",
        term: "シゴロ",
        rank: 700,
        multiplier: 2,
        combo: combo
      });
    }

    if (key === "123") {
      return makeHand({
        kind: "hifumi",
        label: "一二三",
        term: "ヒフミ",
        rank: -100,
        multiplier: 2,
        autoLoss: true,
        combo: combo
      });
    }

    if (pairs.length === 1) {
      var point = Number(
        Object.keys(counts).filter(function (value) {
          return counts[value] === 1;
        })[0]
      );
      return makeHand({
        kind: "point",
        label: CN_NUM[point] + "点",
        term: "目",
        rank: 100 + point,
        multiplier: 1,
        point: point,
        combo: combo
      });
    }

    return Object.assign(noHand(), { combo: combo });
  }

  function rollHand(rng) {
    var random = rng || defaultRng;
    var rolls = [];
    var finalHand = null;
    for (var attempt = 0; attempt < 3; attempt += 1) {
      var dice = [random(1, 6), random(1, 6), random(1, 6)];
      var hand = evaluateRoll(dice);
      rolls.push({ dice: dice.slice(), hand: hand });
      if (hand.resolved) {
        finalHand = hand;
        break;
      }
    }
    if (!finalHand) finalHand = bustHand();
    return { rolls: rolls, hand: finalHand };
  }

  function compareHands(a, b) {
    if (!a || !b || !a.resolved || !b.resolved) return 0;
    if (a.rank === b.rank) return 0;
    return a.rank > b.rank ? 1 : -1;
  }

  function addLog(state, text, kind) {
    state.log.push({
      n: state.log.length ? state.log[state.log.length - 1].n + 1 : 1,
      handNo: state.handNo,
      kind: kind || "info",
      text: String(text)
    });
    if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
  }

  function getPlayer(state, playerId) {
    return state.players[playerId] || null;
  }

  function otherPlayerId(playerId) {
    return playerId === "host" ? "guest" : "host";
  }

  function chipsText(n) {
    return Number(n).toLocaleString("zh-CN");
  }

  function createGame(options) {
    options = options || {};
    var normalized = normalizeSettings(options.settings);
    if (normalized.error) return fail(normalized.error);
    var settings = normalized.settings;
    var rng = options.rng || defaultRng;
    var hostName = normalizeName(options.hostName, "房主");
    var guestName = normalizeName(options.guestName, "玩家 2");

    var hostRoll;
    var guestRoll;
    var openingAttempts = [];
    do {
      hostRoll = rng(1, 6);
      guestRoll = rng(1, 6);
      openingAttempts.push([hostRoll, guestRoll]);
    } while (hostRoll === guestRoll);

    var firstBanker = hostRoll > guestRoll ? "host" : "guest";
    var state = {
      v: VERSION,
      phase: "betting",
      handNo: 1,
      bankerId: firstBanker,
      childId: otherPlayerId(firstBanker),
      bet: 0,
      bankerRolls: [],
      bankerHand: null,
      childRolls: [],
      childHand: null,
      outcome: null,
      lastOutcome: null,
      gameOver: null,
      settings: settings,
      opening: {
        hostRoll: hostRoll,
        guestRoll: guestRoll,
        attempts: openingAttempts,
        firstBanker: firstBanker
      },
      players: {
        host: {
          id: "host",
          name: hostName,
          chips: settings.startingChips,
          debt: 0,
          ready: false,
          stats: { borrowed: 0, repaid: 0, interest: 0, won: 0, lost: 0 }
        },
        guest: {
          id: "guest",
          name: guestName,
          chips: settings.startingChips,
          debt: 0,
          ready: false,
          stats: { borrowed: 0, repaid: 0, interest: 0, won: 0, lost: 0 }
        }
      },
      log: []
    };

    addLog(
      state,
      "定庄：" + hostName + " " + hostRoll + " ／ " + guestName + " " + guestRoll + "，" +
        getPlayer(state, firstBanker).name + " 先坐庄。",
      "system"
    );
    addLog(
      state,
      "初始筹码 " + chipsText(settings.startingChips) + "。" +
        (settings.loansEnabled
          ? "贷款开启，债务上限 " + chipsText(settings.debtLimit) +
            "，每手利率 " + settings.interestRate + "%。"
          : "贷款关闭。") +
        (settings.allowFold ? "允许闲家弃权。" : "禁止弃权。"),
      "system"
    );
    addLog(state, "第 1 手 · " + getPlayer(state, state.childId).name + " 下注。", "phase");

    // The RNG is kept on the host-only live state, never serialized.
    Object.defineProperty(state, "_rng", {
      value: rng,
      enumerable: false,
      configurable: true,
      writable: true
    });

    return { ok: true, state: state };
  }

  function rngFor(state, override) {
    if (typeof override === "function") return override;
    return typeof state._rng === "function" ? state._rng : defaultRng;
  }

  function placeBet(state, playerId, amount) {
    if (!state || state.phase === "gameover") return fail("对局已结束。");
    if (state.phase !== "betting") return fail("现在不是下注阶段。");
    if (playerId !== state.childId) return fail("只有闲家可以下注。");
    if (!isPlainInt(amount) || amount < 1) return fail("下注额必须是大于 0 的整数。");
    var child = getPlayer(state, playerId);
    if (amount > child.chips) {
      return fail("下注不能超过当前筹码。" + (state.settings.loansEnabled ? "可以先贷款，再下注。" : ""));
    }
    state.bet = amount;
    state.phase = "banker-turn";
    addLog(state, child.name + " 下注 " + chipsText(amount) + "。", "bet");
    addLog(state, "轮到 " + getPlayer(state, state.bankerId).name + " 掷骰。", "phase");
    return good(state);
  }

  function rollBanker(state, playerId, rngOverride) {
    if (!state || state.phase === "gameover") return fail("对局已结束。");
    if (state.phase !== "banker-turn") return fail("现在不是庄家掷骰阶段。");
    if (playerId !== state.bankerId) return fail("只有庄家可以掷骰。");
    if (!state.bet) return fail("本手尚未下注。");
    var banker = getPlayer(state, state.bankerId);
    var result = rollHand(rngFor(state, rngOverride));
    state.bankerRolls = result.rolls;
    state.bankerHand = result.hand;

    result.rolls.forEach(function (roll, index) {
      var text =
        banker.name + " 第 " + (index + 1) + " 投：" + roll.dice.join(" / ") + " · " +
        roll.hand.label;
      addLog(state, text + (roll.hand.resolved ? "" : index < 2 ? "，重掷。" : "。"), "roll");
    });
    if (!result.rolls.length || !result.rolls[result.rolls.length - 1].hand.resolved) {
      addLog(state, banker.name + " 三投无目，本手自动判负。", "roll");
    }

    if (result.hand.autoLoss) {
      var type = result.hand.kind === "hifumi" ? "banker-hifumi" : "banker-bust";
      settleAutomatic(state, "banker", result.hand, type);
      return good(state);
    }

    state.phase = "child-decision";
    addLog(
      state,
      "庄家成牌：" + result.hand.label + "。轮到闲家" +
        (state.settings.allowFold ? "选择弃权或掷骰。" : "掷骰。"),
      "phase"
    );
    return good(state);
  }

  function childAction(state, playerId, action, rngOverride) {
    if (!state || state.phase === "gameover") return fail("对局已结束。");
    if (state.phase !== "child-decision") return fail("现在不是闲家行动阶段。");
    if (playerId !== state.childId) return fail("只有闲家可以行动。");
    var child = getPlayer(state, state.childId);
    var banker = getPlayer(state, state.bankerId);

    if (action === "fold") {
      if (!state.settings.allowFold) return fail("本局不允许弃权。");
      var fee = Math.max(1, Math.ceil(state.bet * FOLD_RATE));
      var transfer = transferChips(state, child, banker, fee);
      var outcome = {
        type: "fold",
        title: child.name + " 弃权",
        detail:
          child.name + " 放弃本手，支付 " + chipsText(fee) + "（下注的 50%，向上取整）。",
        winnerId: banker.id,
        loserId: child.id,
        amount: fee,
        bet: state.bet,
        foldFee: fee,
        multiplier: 0,
        forcedBorrow: transfer.forcedBorrow,
        unpaid: transfer.unpaid,
        interest: [],
        draw: false
      };
      finishHand(state, outcome);
      return good(state);
    }

    if (action !== "roll") return fail("未知的闲家行动。");

    var result = rollHand(rngFor(state, rngOverride));
    state.childRolls = result.rolls;
    state.childHand = result.hand;
    result.rolls.forEach(function (roll, index) {
      var text =
        child.name + " 第 " + (index + 1) + " 投：" + roll.dice.join(" / ") + " · " +
        roll.hand.label;
      addLog(state, text + (roll.hand.resolved ? "" : index < 2 ? "，重掷。" : "。"), "roll");
    });
    if (!result.rolls.length || !result.rolls[result.rolls.length - 1].hand.resolved) {
      addLog(state, child.name + " 三投无目，本手自动判负。", "roll");
    }

    if (result.hand.autoLoss) {
      if (result.hand.kind === "hifumi") {
        settleAutomatic(state, "child", result.hand, "child-hifumi");
      } else {
        settleAutomatic(state, "child", result.hand, "child-bust");
      }
      return good(state);
    }

    settleComparison(state);
    return good(state);
  }

  function settleAutomatic(state, loserRole, losingHand, type) {
    var loser = getPlayer(state, loserRole === "banker" ? state.bankerId : state.childId);
    var winner = getPlayer(state, loserRole === "banker" ? state.childId : state.bankerId);
    var amount = state.bet * losingHand.multiplier;
    var transfer = transferChips(state, loser, winner, amount);
    var reasonLabel = losingHand.kind === "hifumi" ? "一二三，自动输两倍" : "无目，自动输一倍";
    var outcome = {
      type: type,
      title: winner.name + " 收下本手",
      detail:
        loser.name + " 掷出" + losingHand.label + "（" + reasonLabel + "），支付 " +
        chipsText(amount) + "。",
      winnerId: winner.id,
      loserId: loser.id,
      amount: amount,
      bet: state.bet,
      multiplier: losingHand.multiplier,
      forcedBorrow: transfer.forcedBorrow,
      unpaid: transfer.unpaid,
      interest: [],
      draw: false
    };
    finishHand(state, outcome);
  }

  function settleComparison(state) {
    var banker = getPlayer(state, state.bankerId);
    var child = getPlayer(state, state.childId);
    var cmp = compareHands(state.bankerHand, state.childHand);
    var outcome;
    if (cmp === 0) {
      outcome = {
        type: "tie",
        title: "和局",
        detail:
          banker.name + " 与 " + child.name + " 同为" +
          (state.childHand.kind === "point" ? state.childHand.label : "同等级牌型") +
          "，本手不结算。",
        winnerId: null,
        loserId: null,
        amount: 0,
        bet: state.bet,
        multiplier: 0,
        forcedBorrow: 0,
        unpaid: 0,
        interest: [],
        draw: true
      };
    } else {
      var winner = cmp > 0 ? banker : child;
      var loser = cmp > 0 ? child : banker;
      var winningHand = cmp > 0 ? state.bankerHand : state.childHand;
      var amount = state.bet * winningHand.multiplier;
      var transfer = transferChips(state, loser, winner, amount);
      outcome = {
        type: "compare",
        title: winner.name + " 赢下本手",
        detail:
          winner.name + " 以" + winningHand.label + "战胜 " + loser.name +
          " 的" + (cmp > 0 ? state.childHand.label : state.bankerHand.label) +
          "，按 " + winningHand.multiplier + " 倍收取 " + chipsText(amount) + "。",
        winnerId: winner.id,
        loserId: loser.id,
        amount: amount,
        bet: state.bet,
        multiplier: winningHand.multiplier,
        forcedBorrow: transfer.forcedBorrow,
        unpaid: transfer.unpaid,
        interest: [],
        draw: false
      };
    }
    finishHand(state, outcome);
  }

  /**
   * Move chips between players. If loans are enabled, any shortfall is
   * automatically borrowed so the winner is always paid in full.
   * With loans disabled, a payout is capped by the loser's chips.
   */
  function transferChips(state, loser, winner, amount) {
    var result = { paid: 0, forcedBorrow: 0, unpaid: 0 };
    var required = Math.max(0, Math.round(Number(amount) || 0));
    if (!required) return result;
    var fromChips = Math.min(loser.chips, required);
    loser.chips -= fromChips;
    winner.chips += fromChips;
    result.paid = fromChips;

    var shortfall = required - fromChips;
    if (shortfall > 0) {
      if (state.settings.loansEnabled) {
        loser.debt += shortfall;
        loser.stats.borrowed += shortfall;
        winner.chips += shortfall;
        result.paid += shortfall;
        result.forcedBorrow = shortfall;
        addLog(
          state,
          loser.name + " 筹码不足，自动借款 " + chipsText(shortfall) + " 完成赔付。",
          "loan"
        );
      } else {
        result.unpaid = shortfall;
        addLog(
          state,
          loser.name + " 无力支付剩余 " + chipsText(shortfall) + "，本手结束后终局。",
          "warn"
        );
      }
    }
    if (fromChips > 0) {
      addLog(
        state,
        loser.name + " 支付 " + chipsText(fromChips) + " 给 " + winner.name + "。",
        "pay"
      );
    }
    return result;
  }

  function finishHand(state, outcome) {
    state.outcome = outcome;
    state.lastOutcome = outcome;
    if (outcome.winnerId && !outcome.draw) {
      getPlayer(state, outcome.winnerId).stats.won += 1;
      getPlayer(state, outcome.loserId).stats.lost += 1;
    }
    addLog(state, outcome.title + "。" + outcome.detail, "result");

    var interestLines = [];
    if (state.settings.loansEnabled && state.settings.interestRate > 0) {
      PLAYERS.forEach(function (id) {
        var player = getPlayer(state, id);
        if (player.debt > 0) {
          var interest = Math.ceil((player.debt * state.settings.interestRate) / 100);
          if (interest > 0) {
            player.debt += interest;
            player.stats.interest += interest;
            interestLines.push({ playerId: id, amount: interest });
            addLog(
              state,
              player.name + " 的欠款计息 " + chipsText(interest) + "（" +
                state.settings.interestRate + "%），当前欠款 " +
                chipsText(player.debt) + "。",
              "interest"
            );
          }
        }
      });
    }
    outcome.interest = interestLines;

    var over = checkGameOver(state);
    if (!over) {
      state.phase = "settled";
      getPlayer(state, "host").ready = false;
      getPlayer(state, "guest").ready = false;
      addLog(state, "本手结束。双方可整理贷款，准备下一手。", "phase");
    }
  }

  function checkGameOver(state) {
    if (state.phase === "gameover") return true;
    var host = getPlayer(state, "host");
    var guest = getPlayer(state, "guest");
    if (state.settings.loansEnabled) {
      var overLimit = PLAYERS.filter(function (id) {
        return getPlayer(state, id).debt >= state.settings.debtLimit;
      });
      if (!overLimit.length) return false;
      if (overLimit.length === 2) {
        var hostNet = host.chips - host.debt;
        var guestNet = guest.chips - guest.debt;
        if (hostNet === guestNet) {
          finishGame(state, {
            reason: "debt-limit",
            draw: true,
            winnerId: null,
            loserId: null,
            title: "和局",
            detail: "双方欠款同时达到上限，净资产相同。"
          });
        } else {
          var netWinner = hostNet > guestNet ? "host" : "guest";
          finishGame(state, {
            reason: "debt-limit",
            draw: false,
            winnerId: netWinner,
            loserId: otherPlayerId(netWinner),
            title: getPlayer(state, netWinner).name + " 获胜",
            detail:
              "双方欠款同时达到上限，按净资产比较：" +
              host.name + " " + chipsText(hostNet) + " ／ " +
              guest.name + " " + chipsText(guestNet) + "。"
          });
        }
        return true;
      }
      var loserId = overLimit[0];
      var winnerId = otherPlayerId(loserId);
      finishGame(state, {
        reason: "debt-limit",
        draw: false,
        winnerId: winnerId,
        loserId: loserId,
        title: getPlayer(state, winnerId).name + " 获胜",
        detail:
          getPlayer(state, loserId).name + " 的欠款达到上限 " +
          chipsText(state.settings.debtLimit) + "，对局结束。"
      });
      return true;
    }

    if (host.chips <= 0 || guest.chips <= 0) {
      if (host.chips <= 0 && guest.chips <= 0) {
        finishGame(state, {
          reason: "broke",
          draw: true,
          winnerId: null,
          loserId: null,
          title: "和局",
          detail: "双方筹码同时耗尽。"
        });
      } else {
        var brokeId = host.chips <= 0 ? "host" : "guest";
        var brokeWinner = otherPlayerId(brokeId);
        finishGame(state, {
          reason: "broke",
          draw: false,
          winnerId: brokeWinner,
          loserId: brokeId,
          title: getPlayer(state, brokeWinner).name + " 获胜",
          detail: getPlayer(state, brokeId).name + " 的筹码耗尽，对局结束。"
        });
      }
      return true;
    }
    return false;
  }

  function finishGame(state, result) {
    state.phase = "gameover";
    state.gameOver = Object.assign(
      {
        title: result.title,
        detail: result.detail,
        winnerId: result.winnerId || null,
        loserId: result.loserId || null,
        draw: !!result.draw,
        reason: result.reason
      },
      {
        final: {
          host: {
            chips: state.players.host.chips,
            debt: state.players.host.debt,
            net: state.players.host.chips - state.players.host.debt
          },
          guest: {
            chips: state.players.guest.chips,
            debt: state.players.guest.debt,
            net: state.players.guest.chips - state.players.guest.debt
          }
        }
      }
    );
    getPlayer(state, "host").ready = false;
    getPlayer(state, "guest").ready = false;
    addLog(state, "终局：" + result.detail, "gameover");
  }

  function manageLoan(state, playerId, action) {
    if (!state || state.phase === "gameover") return fail("对局已结束。");
    if (!state.settings.loansEnabled) return fail("本局未开启贷款。");
    if (!getPlayer(state, playerId)) return fail("玩家不存在。");
    if (state.phase !== "betting" && state.phase !== "settled") {
      return fail("只能在下注前或本手结算后操作贷款。");
    }
    var player = getPlayer(state, playerId);
    if (state.phase === "settled" && player.ready) {
      return fail("你已准备下一手，取消准备后才能操作贷款。");
    }
    action = action || {};
    var borrow = action.borrow == null ? 0 : action.borrow;
    var repay = action.repay == null ? 0 : action.repay;
    if (!isPlainInt(borrow) || !isPlainInt(repay) || borrow < 0 || repay < 0) {
      return fail("金额必须是整数。");
    }
    if ((borrow > 0) === (repay > 0)) {
      return fail("一次只能选择借款或还款。");
    }

    if (borrow > 0) {
      var maxBorrow = state.settings.debtLimit - player.debt;
      if (maxBorrow <= 0) return fail("已经达到债务上限，无法继续借款。");
      if (borrow > maxBorrow) {
        return fail("最多还能借 " + chipsText(maxBorrow) + "。");
      }
      player.chips += borrow;
      player.debt += borrow;
      player.stats.borrowed += borrow;
      addLog(
        state,
        player.name + " 借款 " + chipsText(borrow) + "，当前欠款 " +
          chipsText(player.debt) + "。",
        "loan"
      );
      if (checkGameOver(state)) return good(state);
      return good(state);
    }

    var maxRepay = Math.min(player.chips, player.debt);
    if (maxRepay <= 0) return fail("当前没有可还款的筹码或欠款。");
    if (repay > maxRepay) {
      return fail("最多还能还 " + chipsText(maxRepay) + "。");
    }
    player.chips -= repay;
    player.debt -= repay;
    player.stats.repaid += repay;
    addLog(
      state,
      player.name + " 还款 " + chipsText(repay) + "，当前欠款 " +
        chipsText(player.debt) + "。",
      "repay"
    );
    return good(state);
  }

  function setReady(state, playerId, ready) {
    if (!state || state.phase === "gameover") return fail("对局已结束。");
    if (state.phase !== "settled") return fail("本手尚未结束。");
    var player = getPlayer(state, playerId);
    if (!player) return fail("玩家不存在。");
    player.ready = !!ready;
    if (player.ready) addLog(state, player.name + " 已准备下一手。", "phase");
    else addLog(state, player.name + " 取消准备。", "phase");
    var allReady = PLAYERS.every(function (id) {
      return getPlayer(state, id).ready;
    });
    if (allReady) startNextHand(state);
    return good(state);
  }

  function startNextHand(state) {
    if (state.phase !== "settled") return;
    state.handNo += 1;
    var previousBanker = state.bankerId;
    state.bankerId = state.childId;
    state.childId = previousBanker;
    state.bet = 0;
    state.bankerRolls = [];
    state.bankerHand = null;
    state.childRolls = [];
    state.childHand = null;
    state.outcome = null;
    state.phase = "betting";
    getPlayer(state, "host").ready = false;
    getPlayer(state, "guest").ready = false;
    addLog(
      state,
      "第 " + state.handNo + " 手 · 庄家 " + getPlayer(state, state.bankerId).name +
        "，闲家 " + getPlayer(state, state.childId).name + "。",
      "phase"
    );
    addLog(state, getPlayer(state, state.childId).name + " 下注。", "phase");
  }

  function playerNet(player) {
    return player.chips - player.debt;
  }

  function stateForRules() {
    return {
      foldRate: FOLD_RATE,
      defaultSettings: clone(DEFAULT_SETTINGS),
      limits: clone(LIMITS),
      hands: clone(HAND_GUIDE)
    };
  }

  return {
    version: VERSION,
    FOLD_RATE: FOLD_RATE,
    DEFAULT_SETTINGS: clone(DEFAULT_SETTINGS),
    LIMITS: clone(LIMITS),
    HAND_GUIDE: clone(HAND_GUIDE),
    evaluateRoll: evaluateRoll,
    compareHands: compareHands,
    validateSettings: function (raw) {
      var normalized = normalizeSettings(raw);
      if (normalized.error) return fail(normalized.error);
      return { ok: true, settings: normalized.settings };
    },
    createGame: createGame,
    placeBet: placeBet,
    rollBanker: rollBanker,
    childAction: childAction,
    manageLoan: manageLoan,
    setReady: setReady,
    playerNet: playerNet,
    stateForRules: stateForRules,
    clone: clone
  };
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const DiceEngine = require("../games/dice-table/engine.js");

function rngFrom(values) {
  let index = 0;
  return function (min, max) {
    if (index >= values.length) {
      throw new Error(`RNG queue exhausted at ${index}; wanted ${min}..${max}`);
    }
    const value = values[index++];
    assert.ok(value >= min && value <= max, `RNG value ${value} outside ${min}..${max}`);
    return value;
  };
}

function settings(overrides = {}) {
  return Object.assign(
    {
      startingChips: 1000,
      loansEnabled: false,
      debtLimit: 2000,
      interestRate: 0,
      allowFold: false,
      gameMode: "classic"
    },
    overrides
  );
}

function newGame(rngValues, overrides = {}) {
  return DiceEngine.createGame({
    settings: settings(overrides),
    hostName: "阿甲",
    guestName: "阿乙",
    rng: rngFrom(rngValues)
  });
}

test("evaluateRoll recognises every hand family", () => {
  const pin = DiceEngine.evaluateRoll([1, 1, 1]);
  assert.equal(pin.kind, "pinzoro");
  assert.equal(pin.multiplier, 5);
  assert.equal(pin.resolved, true);

  const arashi = DiceEngine.evaluateRoll([6, 6, 6]);
  assert.equal(arashi.kind, "arashi");
  assert.equal(arashi.label, "六之豹");
  assert.equal(arashi.multiplier, 3);

  const shigoro = DiceEngine.evaluateRoll([4, 5, 6]);
  assert.equal(shigoro.kind, "shigoro");
  assert.equal(shigoro.multiplier, 2);

  const hifumi = DiceEngine.evaluateRoll([1, 2, 3]);
  assert.equal(hifumi.kind, "hifumi");
  assert.equal(hifumi.autoLoss, true);
  assert.equal(hifumi.multiplier, 2);

  const point = DiceEngine.evaluateRoll([2, 2, 6]);
  assert.equal(point.kind, "point");
  assert.equal(point.point, 6);
  assert.equal(point.label, "六点");
  assert.equal(point.multiplier, 1);

  const nothing = DiceEngine.evaluateRoll([1, 2, 4]);
  assert.equal(nothing.kind, "none");
  assert.equal(nothing.resolved, false);
});

test("hand ordering: pinzoro > arashi > shigoro > point", () => {
  const pin = DiceEngine.evaluateRoll([1, 1, 1]);
  const arashi = DiceEngine.evaluateRoll([2, 2, 2]);
  const arashiSix = DiceEngine.evaluateRoll([6, 6, 6]);
  const shigoro = DiceEngine.evaluateRoll([4, 5, 6]);
  const pointSix = DiceEngine.evaluateRoll([2, 2, 6]);
  const pointFive = DiceEngine.evaluateRoll([2, 2, 5]);

  assert.equal(DiceEngine.compareHands(pin, arashi), 1);
  assert.equal(DiceEngine.compareHands(arashiSix, arashi), 1);
  assert.equal(DiceEngine.compareHands(arashi, shigoro), 1);
  assert.equal(DiceEngine.compareHands(shigoro, pointSix), 1);
  assert.equal(DiceEngine.compareHands(pointSix, pointFive), 1);
  assert.equal(DiceEngine.compareHands(pointSix, pointSix), 0);
});

test("a full hand settles by winner multiplier and rotates banker", () => {
  const created = newGame([6, 2, 5, 5, 5, 4, 5, 6]);
  assert.equal(created.ok, true);
  const state = created.state;
  assert.equal(state.bankerId, "host");
  assert.equal(state.childId, "guest");

  assert.equal(DiceEngine.placeBet(state, "guest", 100).ok, true);
  assert.equal(DiceEngine.rollBanker(state, "host").ok, true);
  assert.equal(state.bankerHand.label, "五之豹");
  assert.equal(state.phase, "child-decision");
  assert.equal(DiceEngine.childAction(state, "guest", "roll").ok, true);

  assert.equal(state.phase, "settled");
  assert.equal(state.outcome.winnerId, "host");
  assert.equal(state.outcome.amount, 300);
  assert.equal(state.players.host.chips, 1300);
  assert.equal(state.players.guest.chips, 700);

  assert.equal(DiceEngine.setReady(state, "host", true).ok, true);
  assert.equal(DiceEngine.setReady(state, "guest", true).ok, true);
  assert.equal(state.phase, "betting");
  assert.equal(state.handNo, 2);
  assert.equal(state.bankerId, "guest");
  assert.equal(state.childId, "host");
});

test("fold fee is half the bet rounded up and requires fold to be enabled", () => {
  const created = newGame([6, 2, 6, 6, 6], { allowFold: true });
  const state = created.state;
  DiceEngine.placeBet(state, "guest", 101);
  DiceEngine.rollBanker(state, "host");
  assert.equal(state.phase, "child-decision");
  assert.equal(DiceEngine.childAction(state, "guest", "fold").ok, true);
  assert.equal(state.phase, "settled");
  assert.equal(state.outcome.type, "fold");
  assert.equal(state.outcome.foldFee, 51);
  assert.equal(state.players.host.chips, 1051);
  assert.equal(state.players.guest.chips, 949);
  assert.equal(state.childRolls.length, 0);
});

test("banker hifumi loses double without the child rolling", () => {
  const created = newGame([6, 2, 1, 2, 3]);
  const state = created.state;
  DiceEngine.placeBet(state, "guest", 100);
  DiceEngine.rollBanker(state, "host");
  assert.equal(state.phase, "settled");
  assert.equal(state.outcome.type, "banker-hifumi");
  assert.equal(state.players.host.chips, 800);
  assert.equal(state.players.guest.chips, 1200);
  assert.equal(state.childRolls.length, 0);
});

test("single-roll mode settles a no-hand after exactly one throw", () => {
  const created = newGame([6, 2, 1, 2, 4], { gameMode: "single" });
  const state = created.state;
  DiceEngine.placeBet(state, "guest", 100);
  DiceEngine.rollBanker(state, "host");

  assert.equal(state.phase, "settled");
  assert.equal(state.bankerRolls.length, 1);
  assert.equal(state.bankerHand.kind, "bust");
  assert.equal(state.outcome.type, "banker-bust");
  assert.equal(state.childRolls.length, 0);
  assert.equal(state.players.host.chips, 900);
  assert.equal(state.players.guest.chips, 1100);
});

test("single-roll mode compares one banker throw with one child throw", () => {
  const created = newGame([6, 2, 4, 5, 6, 1, 1, 1], { gameMode: "single" });
  const state = created.state;
  DiceEngine.placeBet(state, "guest", 100);
  DiceEngine.rollBanker(state, "host");
  assert.equal(state.bankerRolls.length, 1);
  assert.equal(state.bankerHand.kind, "shigoro");
  DiceEngine.childAction(state, "guest", "roll");

  assert.equal(state.childRolls.length, 1);
  assert.equal(state.childHand.kind, "pinzoro");
  assert.equal(state.phase, "settled");
  assert.equal(state.outcome.winnerId, "guest");
  assert.equal(state.outcome.amount, 500);
  assert.equal(state.players.host.chips, 500);
  assert.equal(state.players.guest.chips, 1500);
});

test("single-roll mode keeps hifumi as an immediate double loss", () => {
  const created = newGame([6, 2, 1, 2, 3], { gameMode: "single" });
  const state = created.state;
  DiceEngine.placeBet(state, "guest", 100);
  DiceEngine.rollBanker(state, "host");

  assert.equal(state.phase, "settled");
  assert.equal(state.outcome.type, "banker-hifumi");
  assert.equal(state.players.host.chips, 800);
  assert.equal(state.players.guest.chips, 1200);
  assert.equal(state.childRolls.length, 0);
});

test("three invalid rolls become a bust worth one bet", () => {
  const created = newGame([
    6, 2,
    1, 2, 4,
    2, 3, 5,
    1, 3, 6
  ]);
  const state = created.state;
  DiceEngine.placeBet(state, "guest", 200);
  DiceEngine.rollBanker(state, "host");
  assert.equal(state.bankerHand.kind, "bust");
  assert.equal(state.bankerRolls.length, 3);
  assert.equal(state.outcome.type, "banker-bust");
  assert.equal(state.players.guest.chips, 1200);
  assert.equal(state.players.host.chips, 800);
});

test("loans can be borrowed, partially repaid and accrue compound interest", () => {
  const created = newGame([6, 2, 5, 5, 5, 4, 5, 6], {
    loansEnabled: true,
    debtLimit: 5000,
    interestRate: 10
  });
  const state = created.state;
  assert.equal(DiceEngine.manageLoan(state, "guest", { borrow: 500 }).ok, true);
  assert.equal(state.players.guest.chips, 1500);
  assert.equal(state.players.guest.debt, 500);
  assert.equal(DiceEngine.manageLoan(state, "guest", { repay: 200 }).ok, true);
  assert.equal(state.players.guest.chips, 1300);
  assert.equal(state.players.guest.debt, 300);

  assert.equal(DiceEngine.placeBet(state, "guest", 100).ok, true);
  // Host is banker with 555; guest rolls 456 and loses 3x.
  DiceEngine.rollBanker(state, "host");
  DiceEngine.childAction(state, "guest", "roll");
  // guest starts 1000, borrows 500, repays 200 => 1300 chips, 300 debt.
  // loses 300 => 1000 chips. Interest = ceil(300 * 10%) = 30 => debt 330.
  assert.equal(state.players.guest.chips, 1000);
  assert.equal(state.players.guest.debt, 330);
  assert.equal(state.players.host.chips, 1300);
});

test("forced borrowing covers a loss and debt cap ends the game", () => {
  const created = newGame([6, 2, 5, 5, 5, 4, 5, 6], {
    loansEnabled: true,
    debtLimit: 2000,
    interestRate: 10
  });
  const state = created.state;
  DiceEngine.manageLoan(state, "guest", { borrow: 500 });
  DiceEngine.placeBet(state, "guest", 1500);
  DiceEngine.rollBanker(state, "host");
  DiceEngine.childAction(state, "guest", "roll");

  // Guest has 1500 and loses 3x = 4500. Chips go to zero, 3000 is borrowed.
  // Interest at 10% is added, far above the 2000 cap.
  assert.equal(state.phase, "gameover");
  assert.equal(state.gameOver.winnerId, "host");
  assert.equal(state.players.guest.chips, 0);
  assert.ok(state.players.guest.debt >= 2000);
  assert.equal(state.gameOver.reason, "debt-limit");
});

test("without loans, an unpayable payout is capped and ends the game", () => {
  const created = newGame([6, 2, 5, 5, 5, 4, 5, 6], {
    startingChips: 100,
    loansEnabled: false
  });
  const state = created.state;
  DiceEngine.placeBet(state, "guest", 100);
  DiceEngine.rollBanker(state, "host");
  DiceEngine.childAction(state, "guest", "roll");
  assert.equal(state.phase, "gameover");
  assert.equal(state.players.guest.chips, 0);
  assert.equal(state.players.host.chips, 200);
  assert.equal(state.outcome.unpaid, 200);
});

test("borrowing up to the debt limit immediately ends the game", () => {
  const created = newGame([6, 2], {
    loansEnabled: true,
    debtLimit: 1000,
    interestRate: 0
  });
  const state = created.state;
  assert.equal(DiceEngine.manageLoan(state, "guest", { borrow: 1000 }).ok, true);
  assert.equal(state.phase, "gameover");
  assert.equal(state.gameOver.winnerId, "host");
});

/* =========================================================
   游戏集 — small shared UI helpers
   Classic script; exposes window.ArcadeUI.
   ========================================================= */
(function (global) {
  "use strict";

  var FOCUSABLE = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "textarea:not([disabled])",
    "select:not([disabled])",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  var lastFocus = null;
  var openStack = [];
  var toastRegion = null;

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  function getModal(id) {
    return typeof id === "string" ? document.getElementById(id) : id;
  }

  function focusables(root) {
    return qsa(FOCUSABLE, root).filter(function (el) {
      return el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement;
    });
  }

  function trapFocus(event, modal) {
    if (event.key !== "Tab") return;
    var items = focusables(modal.querySelector(".modal__panel") || modal);
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openModal(id, options) {
    var modal = getModal(id);
    if (!modal || modal.classList.contains("is-open")) return;
    options = options || {};
    if (!openStack.length) lastFocus = document.activeElement;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    modal.dataset.modalVisible = "1";
    document.body.classList.add("no-scroll");
    openStack.push(modal);
    var focusTarget =
      (options.focus && modal.querySelector(options.focus)) ||
      modal.querySelector("[data-autofocus]") ||
      modal.querySelector(".modal__panel");
    if (focusTarget) {
      if (!focusTarget.hasAttribute("tabindex") && focusTarget === modal.querySelector(".modal__panel")) {
        focusTarget.setAttribute("tabindex", "-1");
      }
      window.setTimeout(function () {
        focusTarget.focus({ preventScroll: true });
      }, 20);
    }
  }

  function closeModal(id) {
    var modal = getModal(id);
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    delete modal.dataset.modalVisible;
    openStack = openStack.filter(function (item) {
      return item !== modal;
    });
    if (!openStack.length) {
      document.body.classList.remove("no-scroll");
      if (lastFocus && typeof lastFocus.focus === "function") {
        lastFocus.focus({ preventScroll: true });
      }
      lastFocus = null;
    }
  }

  function closeTopModal() {
    if (openStack.length) closeModal(openStack[openStack.length - 1]);
  }

  function bindModals() {
    document.addEventListener("click", function (event) {
      var opener = event.target.closest("[data-modal-open]");
      if (opener) {
        event.preventDefault();
        openModal(opener.getAttribute("data-modal-open"));
        return;
      }
      var closer = event.target.closest("[data-modal-close]");
      if (closer) {
        event.preventDefault();
        closeModal(closer.closest(".modal"));
        return;
      }
      if (event.target.classList.contains("modal")) {
        if (event.target.dataset.static === "true") return;
        closeModal(event.target);
      }
    });

    document.addEventListener("keydown", function (event) {
      if (!openStack.length) return;
      var modal = openStack[openStack.length - 1];
      if (event.key === "Escape") {
        event.preventDefault();
        if (modal.dataset.static !== "true") closeModal(modal);
        return;
      }
      trapFocus(event, modal);
    });
  }

  function ensureToastRegion() {
    if (!toastRegion) {
      toastRegion = document.createElement("div");
      toastRegion.className = "toast-region";
      toastRegion.setAttribute("role", "status");
      toastRegion.setAttribute("aria-live", "polite");
      document.body.appendChild(toastRegion);
    }
    return toastRegion;
  }

  function toast(message, options) {
    options = options || {};
    var region = ensureToastRegion();
    var el = document.createElement("div");
    el.className = "toast" + (options.type ? " toast--" + options.type : "");
    var dot = document.createElement("span");
    dot.className = "toast__dot";
    var copy = document.createElement("span");
    copy.textContent = String(message);
    el.appendChild(dot);
    el.appendChild(copy);
    region.appendChild(el);
    var timeout = typeof options.timeout === "number" ? options.timeout : 3200;
    window.setTimeout(function () {
      el.classList.add("is-leaving");
      window.setTimeout(function () {
        el.remove();
      }, 240);
    }, timeout);
  }

  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    area.style.top = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return fallbackCopy(text);
        }
      );
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function copyFrom(source, button) {
    var el = typeof source === "string" ? qs(source) : source;
    if (!el) return Promise.resolve(false);
    var text = "value" in el ? el.value : el.textContent;
    return copyText(text).then(function (ok) {
      if (button) {
        var original = button.innerHTML;
        button.textContent = ok ? "已复制" : "复制失败";
        button.disabled = true;
        window.setTimeout(function () {
          button.innerHTML = original;
          button.disabled = false;
        }, 1500);
      }
      return ok;
    });
  }

  function confirm(options) {
    options = options || {};
    return new Promise(function (resolve) {
      var old = document.getElementById("arcade-confirm");
      if (old) old.remove();
      var modal = document.createElement("div");
      modal.className = "modal is-open";
      modal.id = "arcade-confirm";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-hidden", "false");
      modal.innerHTML =
        '<div class="modal__panel" role="document" tabindex="-1">' +
        '<div class="modal__head"><div><p class="eyebrow">Confirm</p><h2></h2></div>' +
        '<button class="modal__close" type="button" aria-label="关闭" data-confirm-cancel>' +
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
        "</button></div>" +
        '<p class="confirm-copy"></p>' +
        '<div class="modal__foot"><button class="btn btn--ghost" type="button" data-confirm-cancel>取消</button>' +
        '<button class="btn btn--primary" type="button" data-confirm-ok></button></div>' +
        "</div>";
      modal.querySelector("h2").textContent = options.title || "确认";
      modal.querySelector(".confirm-copy").textContent = options.message || "";
      modal.querySelector("[data-confirm-ok]").textContent = options.confirmLabel || "确认";
      if (options.danger) {
        modal.querySelector("[data-confirm-ok]").classList.add("btn--accent");
        modal.querySelector("[data-confirm-ok]").classList.remove("btn--primary");
      }
      document.body.appendChild(modal);
      document.body.classList.add("no-scroll");
      var previousFocus = document.activeElement;
      function finish(value) {
        modal.querySelectorAll("[data-confirm-cancel], [data-confirm-ok]").forEach(function (btn) {
          btn.disabled = true;
        });
        modal.classList.remove("is-open");
        window.setTimeout(function () {
          modal.remove();
          if (!document.querySelector(".modal.is-open")) document.body.classList.remove("no-scroll");
          if (previousFocus && previousFocus.focus) previousFocus.focus({ preventScroll: true });
        }, 160);
        document.removeEventListener("keydown", onKey);
        resolve(value);
      }
      function onKey(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }
      modal.querySelectorAll("[data-confirm-cancel]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          finish(false);
        });
      });
      modal.querySelector("[data-confirm-ok]").addEventListener("click", function () {
        finish(true);
      });
      modal.addEventListener("click", function (event) {
        if (event.target === modal) finish(false);
      });
      document.addEventListener("keydown", onKey);
      window.setTimeout(function () {
        var target = modal.querySelector("[data-confirm-ok]");
        if (target) target.focus();
      }, 30);
    });
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  var PIPS = {
    1: [[2, 2]],
    2: [[1, 1], [3, 3]],
    3: [[1, 1], [2, 2], [3, 3]],
    4: [[1, 1], [1, 3], [3, 1], [3, 3]],
    5: [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]],
    6: [[1, 1], [1, 3], [2, 1], [2, 3], [3, 1], [3, 3]]
  };

  function renderPips(container, value) {
    if (!container) return;
    var safe = Math.max(1, Math.min(6, Number(value) || 1));
    container.innerHTML = "";
    PIPS[safe].forEach(function (pos) {
      var pip = document.createElement("i");
      pip.className = "pip";
      pip.style.gridArea = pos[0] + " / " + pos[1];
      container.appendChild(pip);
    });
  }

  function formatInt(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return "0";
    return Math.round(n).toLocaleString("zh-CN");
  }

  function clampInt(value, min, max) {
    var n = Math.round(Number(value));
    if (!Number.isFinite(n)) n = min;
    return Math.max(min, Math.min(max, n));
  }

  function setButtonBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.originalHtml = button.innerHTML;
      button.disabled = true;
      if (label) button.textContent = label;
    } else {
      button.disabled = false;
      if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
      }
    }
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var context = this;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        fn.apply(context, args);
      }, wait);
    };
  }

  function randomInt(min, max) {
    var range = max - min + 1;
    var array = new Uint32Array(1);
    var limit = Math.floor(4294967296 / range) * range;
    var value;
    do {
      crypto.getRandomValues(array);
      value = array[0];
    } while (value >= limit);
    return min + (value % range);
  }

  global.ArcadeUI = {
    qs: qs,
    qsa: qsa,
    onReady: onReady,
    openModal: openModal,
    closeModal: closeModal,
    closeTopModal: closeTopModal,
    bindModals: bindModals,
    toast: toast,
    copyText: copyText,
    copyFrom: copyFrom,
    confirm: confirm,
    escapeHTML: escapeHTML,
    renderPips: renderPips,
    formatInt: formatInt,
    clampInt: clampInt,
    setButtonBusy: setButtonBusy,
    debounce: debounce,
    randomInt: randomInt
  };

  onReady(function () {
    bindModals();
  });
})(window);

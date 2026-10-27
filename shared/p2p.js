/* =========================================================
   游戏集 — serverless WebRTC room helper
   Two-step manual signalling:
     host invite code  ->  guest answer code  ->  connected
   No backend. No room lookup. Data flows only between peers.
   Classic script; exposes window.ArcadeP2P.
   ========================================================= */
(function (global) {
  "use strict";

  var VERSION = 1;
  var PREFIX_GZIP = "A1z.";
  var PREFIX_JSON = "A1j.";
  var MAX_CODE_LENGTH = 1024 * 1024;
  var MAX_MESSAGE_LENGTH = 1024 * 1024;

  var DEFAULT_ICE_SERVERS = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.miwifi.com:3478" }
  ];

  function isSupported() {
    return !!(
      global.RTCPeerConnection &&
      global.RTCSessionDescription &&
      global.TextEncoder &&
      global.TextDecoder
    );
  }

  function randomId() {
    var bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode.apply(null, bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function bytesToBase64Url(bytes) {
    var binary = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64UrlToBytes(text) {
    var padded = text.replace(/-/g, "+").replace(/_/g, "/");
    while (padded.length % 4) padded += "=";
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function gzipBytes(bytes) {
    if (!global.CompressionStream) return Promise.resolve(null);
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
      return new Response(stream).arrayBuffer().then(function (buffer) {
        return new Uint8Array(buffer);
      });
    } catch (err) {
      return Promise.resolve(null);
    }
  }

  function gunzipBytes(bytes) {
    if (!global.DecompressionStream) {
      throw new Error("当前浏览器不支持解压联机码，请使用最新版 Chrome / Edge / Safari。");
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }

  function encodePayload(payload) {
    var bytes = new TextEncoder().encode(JSON.stringify(payload));
    return gzipBytes(bytes).then(function (compressed) {
      if (compressed && compressed.length < bytes.length) {
        return PREFIX_GZIP + bytesToBase64Url(compressed);
      }
      return PREFIX_JSON + bytesToBase64Url(bytes);
    });
  }

  function decodeCode(code) {
    if (typeof code !== "string" || !code.trim()) {
      return Promise.reject(new Error("联机码为空。"));
    }
    var cleaned = code.replace(/\s+/g, "");
    if (cleaned.length > MAX_CODE_LENGTH) {
      return Promise.reject(new Error("联机码过长，请确认是否粘贴完整。"));
    }
    var prefix;
    var body;
    if (cleaned.indexOf(PREFIX_GZIP) === 0) {
      prefix = PREFIX_GZIP;
      body = cleaned.slice(PREFIX_GZIP.length);
    } else if (cleaned.indexOf(PREFIX_JSON) === 0) {
      prefix = PREFIX_JSON;
      body = cleaned.slice(PREFIX_JSON.length);
    } else {
      return Promise.reject(new Error("这不像是一个有效的联机码。"));
    }
    var bytes;
    try {
      bytes = base64UrlToBytes(body);
    } catch (err) {
      return Promise.reject(new Error("联机码格式损坏，请重新复制。"));
    }
    var parse = prefix === PREFIX_GZIP ? gunzipBytes(bytes) : Promise.resolve(new TextDecoder().decode(bytes));
    return parse
      .then(function (text) {
        var payload = JSON.parse(text);
        if (!payload || payload.v !== VERSION) {
          throw new Error("联机码版本不兼容，请双方使用同一版本的页面。");
        }
        if (!payload.sdp || (payload.k !== "offer" && payload.k !== "answer")) {
          throw new Error("联机码缺少必要的连接信息。");
        }
        return payload;
      })
      .catch(function (err) {
        if (err && /版本|联机码/.test(err.message)) throw err;
        throw new Error("联机码解析失败，可能复制不完整。");
      });
  }

  function createPeer(iceServers) {
    var servers = Array.isArray(iceServers) && iceServers.length ? iceServers : DEFAULT_ICE_SERVERS;
    return new RTCPeerConnection({
      iceServers: servers,
      iceCandidatePoolSize: 0
    });
  }

  function waitForIce(pc, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = null;
      function finish() {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        pc.removeEventListener("icecandidate", onCandidate);
        resolve();
      }
      function onChange() {
        if (pc.iceGatheringState === "complete") finish();
      }
      function onCandidate(event) {
        if (!event.candidate) finish();
      }
      if (!pc || pc.signalingState === "closed") {
        resolve();
        return;
      }
      if (pc.iceGatheringState === "complete") {
        resolve();
        return;
      }
      pc.addEventListener("icegatheringstatechange", onChange);
      pc.addEventListener("icecandidate", onCandidate);
      timer = setTimeout(finish, Math.max(1500, Math.min(10000, timeoutMs || 5500)));
    });
  }

  function safeCall(fn, arg) {
    if (typeof fn !== "function") return;
    try {
      fn(arg);
    } catch (err) {
      // Callback failures should never break the connection lifecycle.
      if (global.console && console.warn) console.warn("[ArcadeP2P callback]", err);
    }
  }

  function normalizeIceServers(servers) {
    if (Array.isArray(servers) && servers.length) return servers;
    return DEFAULT_ICE_SERVERS;
  }

  function createSession(role, pc, initialChannel, callbacks, meta) {
    var closed = false;
    var opened = false;
    var channel = null;
    var listenersBound = false;
    var disconnectTimer = null;
    var openPromiseResolve;
    var openPromiseReject;
    var openPromise = new Promise(function (resolve, reject) {
      openPromiseResolve = resolve;
      openPromiseReject = reject;
    });
    // A session may be closed before anyone waits on it.
    openPromise.catch(function () {});

    callbacks = callbacks || {};
    meta = meta || {};

    function emitState(status, detail) {
      safeCall(callbacks.onState, { status: status, detail: detail || null });
    }

    function markOpen() {
      if (opened || closed) return;
      opened = true;
      emitState("connected");
      safeCall(callbacks.onOpen, session);
      openPromiseResolve(session);
    }

    function clearDisconnectTimer() {
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
    }

    function markClosed(reason) {
      if (closed) return;
      closed = true;
      clearDisconnectTimer();
      emitState("closed", reason || null);
      safeCall(callbacks.onClose, reason || "closed");
      openPromiseReject(new Error(reason || "连接已关闭"));
    }

    function scheduleDisconnectCheck() {
      if (closed || disconnectTimer) return;
      // A transient ICE "disconnected" can recover on its own. Give it a
      // little room, then end the session so both clients can show a clear
      // disconnect state instead of waiting forever.
      disconnectTimer = setTimeout(function () {
        disconnectTimer = null;
        if (closed) return;
        if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
          markClosed("连接已断开");
        }
      }, 7000);
    }

    function bindChannel(nextChannel) {
      if (!nextChannel || channel === nextChannel || closed) return;
      if (channel && channel.readyState === "open") return;
      channel = nextChannel;
      session.channel = channel;
      if (listenersBound) {
        if (channel.readyState === "open") markOpen();
        return;
      }
      listenersBound = true;
      channel.binaryType = "arraybuffer";
      channel.addEventListener("open", markOpen);
      channel.addEventListener("close", function () {
        markClosed("数据通道已关闭");
      });
      channel.addEventListener("error", function () {
        safeCall(callbacks.onError, new Error("数据通道发生错误。"));
      });
      channel.addEventListener("message", function (event) {
        if (closed) return;
        var raw = event.data;
        if (typeof raw !== "string" || raw.length > MAX_MESSAGE_LENGTH) return;
        var message;
        try {
          message = JSON.parse(raw);
        } catch (err) {
          return;
        }
        if (!message || typeof message !== "object") return;
        safeCall(callbacks.onMessage, message);
      });
      if (channel.readyState === "open") markOpen();
      else emitState("channel-ready", "已找到房主的数据通道，等待直连");
    }

    pc.addEventListener("connectionstatechange", function () {
      var state = pc.connectionState;
      if (state === "failed") {
        markClosed("WebRTC 连接失败，可能是网络环境不支持直连");
      } else if (state === "disconnected") {
        emitState("unstable", "网络暂时中断，正在尝试恢复。");
        scheduleDisconnectCheck();
      } else if (state === "connected") {
        clearDisconnectTimer();
        emitState("connected");
      }
    });

    var session = {
      role: role,
      pc: pc,
      channel: null,
      meta: meta,
      get isOpen() {
        return !closed && !!channel && channel.readyState === "open";
      },
      get isClosed() {
        return closed;
      },
      waitUntilOpen: function (timeoutMs) {
        if (opened) return Promise.resolve(session);
        if (closed) return Promise.reject(new Error("连接已关闭"));
        var timeout = Math.max(5000, timeoutMs || 30000);
        return Promise.race([
          openPromise,
          new Promise(function (_, reject) {
            setTimeout(function () {
              reject(new Error("连接超时。请回到房间重新生成联机码。"));
            }, timeout);
          })
        ]);
      },
      send: function (object) {
        if (!session.isOpen) return false;
        try {
          var json = JSON.stringify(object);
          if (json.length > MAX_MESSAGE_LENGTH) return false;
          channel.send(json);
          return true;
        } catch (err) {
          return false;
        }
      },
      close: function (reason) {
        if (closed) return;
        markClosed(reason || "主动关闭");
        try {
          if (channel) channel.close();
        } catch (err) {
          /* noop */
        }
        try {
          pc.close();
        } catch (err) {
          /* noop */
        }
      },
      // Internal: a guest session is created after its answer code, and its
      // incoming data channel may arrive a moment later.
      _bindChannel: bindChannel
    };

    if (initialChannel) bindChannel(initialChannel);
    return session;
  }

  function createHost(options) {
    options = options || {};
    if (!isSupported()) {
      return Promise.reject(new Error("当前浏览器不支持 WebRTC 联机，请使用最新版 Chrome / Edge / Safari。"));
    }
    var callbacks = options.callbacks || {};
    var bridge = {
      onState: function (payload) {
        safeCall(callbacks.onState, payload);
      },
      onOpen: function (session) {
        safeCall(callbacks.onOpen, session);
      },
      onMessage: function (message) {
        safeCall(callbacks.onMessage, message);
      },
      onClose: function (reason) {
        safeCall(callbacks.onClose, reason);
      },
      onError: function (err) {
        safeCall(callbacks.onError, err);
      }
    };
    var pc;
    var session;
    var channel;
    var sid = randomId();
    try {
      pc = createPeer(normalizeIceServers(options.iceServers));
      channel = pc.createDataChannel("arcade", { ordered: true });
      session = createSession("host", pc, channel, bridge, { sid: sid });
    } catch (err) {
      return Promise.reject(err);
    }
    bridge.onState({ status: "preparing", detail: "创建房间" });

    return pc
      .createOffer()
      .then(function (offer) {
        return pc.setLocalDescription(offer);
      })
      .then(function () {
        bridge.onState({ status: "gathering", detail: "收集网络地址" });
        return waitForIce(pc, options.iceTimeout);
      })
      .then(function () {
        var payload = {
          v: VERSION,
          k: "offer",
          sid: sid,
          room: options.room || null,
          sdp: pc.localDescription.sdp
        };
        return encodePayload(payload);
      })
      .then(function (inviteCode) {
        var meta = {
          sid: sid,
          inviteCode: inviteCode,
          room: options.room || null
        };
        session.meta = Object.assign({}, session.meta, meta);
        session.acceptAnswer = function (answerCode) {
          return decodeCode(answerCode).then(function (payload) {
            if (payload.k !== "answer") {
              throw new Error("这是邀请码，不是应答码。");
            }
            if (payload.sid && payload.sid !== sid) {
              throw new Error("这个应答码不属于当前房间。");
            }
            bridge.onState({ status: "connecting", detail: "正在建立直连" });
            return pc.setRemoteDescription({ type: "answer", sdp: payload.sdp }).then(function () {
              session.remoteMeta = {
                sid: payload.sid || null,
                guestName: payload.guestName || "",
                answerCode: answerCode
              };
              return session.waitUntilOpen(options.connectTimeout || 30000).then(function () {
                return session.remoteMeta;
              });
            });
          });
        };
        bridge.onState({ status: "waiting-answer", detail: "等待应答码" });
        return {
          inviteCode: inviteCode,
          session: session,
          room: options.room || null
        };
      })
      .catch(function (err) {
        try {
          pc.close();
        } catch (closeErr) {
          /* noop */
        }
        throw err;
      });
  }

  function joinWithInvite(inviteCode, options) {
    options = options || {};
    if (!isSupported()) {
      return Promise.reject(new Error("当前浏览器不支持 WebRTC 联机，请使用最新版 Chrome / Edge / Safari。"));
    }
    var callbacks = options.callbacks || {};
    var bridge = {
      onState: function (payload) {
        safeCall(callbacks.onState, payload);
      },
      onOpen: function (session) {
        safeCall(callbacks.onOpen, session);
      },
      onMessage: function (message) {
        safeCall(callbacks.onMessage, message);
      },
      onClose: function (reason) {
        safeCall(callbacks.onClose, reason);
      },
      onError: function (err) {
        safeCall(callbacks.onError, err);
      }
    };

    return decodeCode(inviteCode).then(function (payload) {
      if (payload.k !== "offer") throw new Error("这是应答码，不是邀请码。");
      var pc;
      var session = null;
      var pendingChannel = null;
      try {
        pc = createPeer(normalizeIceServers(options.iceServers));
      } catch (err) {
        return Promise.reject(err);
      }
      // The host creates the data channel before making its offer, so this
      // event can arrive before we have finished encoding the answer code.
      pc.addEventListener("datachannel", function (event) {
        if (session) session._bindChannel(event.channel);
        else pendingChannel = event.channel;
      });

      bridge.onState({ status: "connecting", detail: "读取邀请码" });
      return pc
        .setRemoteDescription({ type: "offer", sdp: payload.sdp })
        .then(function () {
          return pc.createAnswer();
        })
        .then(function (answer) {
          return pc.setLocalDescription(answer);
        })
        .then(function () {
          bridge.onState({ status: "gathering", detail: "收集网络地址" });
          return waitForIce(pc, options.iceTimeout);
        })
        .then(function () {
          var answerPayload = {
            v: VERSION,
            k: "answer",
            sid: payload.sid || null,
            guestName: options.guestName || "",
            sdp: pc.localDescription.sdp
          };
          return encodePayload(answerPayload);
        })
        .then(function (answerCode) {
          session = createSession("guest", pc, pendingChannel, bridge, {
            sid: payload.sid || null,
            answerCode: answerCode,
            room: payload.room || null,
            guestName: options.guestName || ""
          });
          bridge.onState({ status: "waiting-host", detail: "等待房主完成连接" });
          return {
            answerCode: answerCode,
            session: session,
            room: payload.room || null,
            inviteMeta: payload
          };
        })
        .catch(function (err) {
          try {
            pc.close();
          } catch (closeErr) {
            /* noop */
          }
          throw err;
        });
    });
  }

  function makeIceServers(urls) {
    return (urls || []).filter(Boolean).map(function (url) {
      return { urls: url };
    });
  }

  global.ArcadeP2P = {
    version: VERSION,
    isSupported: isSupported,
    createHost: createHost,
    joinWithInvite: joinWithInvite,
    decodeCode: decodeCode,
    defaultIceServers: DEFAULT_ICE_SERVERS.slice(),
    makeIceServers: makeIceServers,
    randomId: randomId
  };
})(window);

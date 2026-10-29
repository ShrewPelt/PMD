(function () {
  if (!document.documentElement.classList.contains("touch")) return;

  const style = document.createElement("style");
  style.textContent = [
    "html.touch,html.touch body{position:fixed;inset:0;width:100%;height:100%;overflow:hidden;overscroll-behavior:none;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}",
    "html.touch #game{position:fixed;inset:0;padding:0;display:block}",
    "html.touch #game canvas{touch-action:none}",
    "html.touch #chat{display:none;position:fixed;left:0;right:0;top:0;z-index:80;padding:8px;background:rgba(10,10,20,0.9)}",
    "html.touch.chatOn #chat{display:flex}",
    "html.touch #chatInput{width:100%;font-size:16px}",
    "html.touch #hud{top:calc(env(safe-area-inset-top) + 6px);left:calc(env(safe-area-inset-left) + 212px);width:150px;gap:4px}",
    "html.touch #readout{font-size:9px;padding:4px 6px;line-height:1.25}",
    "html.touch #gmlog{max-height:22vh;font-size:11px}",
    "html.touch #gmlog #gmlogbody{overflow-y:auto}",
    "html.touch #exitWorld{top:calc(env(safe-area-inset-top) + 6px);right:calc(env(safe-area-inset-right) + 6px);padding:5px 9px;font-size:11px}",
    "html.touch #cbOrder{top:calc(env(safe-area-inset-top) + 6px);max-width:50vw;font-size:10px;padding:3px 6px}",
    "html.touch #combat{right:calc(env(safe-area-inset-right) + 6px);top:calc(env(safe-area-inset-top) + 40px);width:min(300px,46vw);max-height:calc(100vh - 190px);overflow-y:auto;padding:7px;font-size:12px}",
    "html.touch #cbLog{max-height:70px}",
    "html.touch .cbmove{padding:7px 8px}",
    "html.touch #cbActions button,html.touch .cbtarget{padding:9px 8px;font-size:13px}",
    "html.touch #inventory{position:fixed;left:calc(env(safe-area-inset-left) + 8px);top:8px;transform:none;width:calc(100vw - 220px - env(safe-area-inset-left));max-height:calc(100vh - 16px);overflow-y:auto;margin:0;z-index:30;background:rgba(24,24,44,0.97);padding:8px;box-sizing:border-box}",
    "html.touch #invTop{margin-bottom:6px;gap:10px}",
    "html.touch #invPortrait{width:48px;height:48px}",
    "html.touch #invPortrait img{width:42px;height:42px}",
    "html.touch #invStats{font-size:12px;line-height:1.5}",
    "html.touch #invGrid{padding:6px;gap:5px;grid-template-columns:repeat(6,minmax(0,64px));justify-content:center}",
    "html.touch #itemMenu,html.touch #lootPanel{max-height:88vh;overflow-y:auto;min-width:240px}",
    "html.touch .imbtn{padding:10px 9px;font-size:14px}",
    "html.touch #itemToast{bottom:auto;top:calc(env(safe-area-inset-top) + 44px);max-width:80vw}",
    "html.touch #worldMusic{z-index:25;bottom:auto;top:calc(env(safe-area-inset-top) + 6px);left:50%;padding:2px 8px}",
    "html.touch #worldMusic .mLabel{max-width:90px}",
    "html.touch #worldMusic input[type=range]{width:50px}",
    "#mControls{position:fixed;inset:0;z-index:35;pointer-events:none;touch-action:none}",
    "#mControls .mJoy{position:absolute;left:calc(env(safe-area-inset-left) + 22px);bottom:calc(env(safe-area-inset-bottom) + 24px);width:132px;height:132px;border-radius:50%;background:rgba(255,255,255,0.1);border:2px solid rgba(255,255,255,0.35);pointer-events:auto;touch-action:none}",
    "#mControls .mKnob{position:absolute;left:50%;top:50%;width:58px;height:58px;margin:-29px 0 0 -29px;border-radius:50%;background:rgba(255,255,255,0.45);border:2px solid rgba(255,255,255,0.8)}",
    "#mControls .mBtn{position:absolute;pointer-events:auto;touch-action:none;border-radius:50%;border:2px solid rgba(255,255,255,0.55);background:rgba(40,40,70,0.7);color:#fff;font-family:sans-serif;font-weight:bold;display:flex;align-items:center;justify-content:center;text-align:center;line-height:1.05}",
    "#mControls .mBtn:active,#mControls .mBtn.down{background:rgba(74,108,255,0.85)}",
    "#mControls .mBig{width:76px;height:76px;font-size:14px;right:calc(env(safe-area-inset-right) + 20px);bottom:calc(env(safe-area-inset-bottom) + 30px);background:rgba(60,150,80,0.75)}",
    "#mControls .mBag{width:54px;height:54px;font-size:12px;right:calc(env(safe-area-inset-right) + 106px);bottom:calc(env(safe-area-inset-bottom) + 24px)}",
    "#mControls .mPick{width:48px;height:48px;font-size:11px;right:calc(env(safe-area-inset-right) + 100px);bottom:calc(env(safe-area-inset-bottom) + 86px)}",
    "#mControls .mDrop{width:48px;height:48px;font-size:11px;right:calc(env(safe-area-inset-right) + 36px);bottom:calc(env(safe-area-inset-bottom) + 116px)}",
    "#mControls .mSmall{width:38px;height:38px;font-size:15px;top:calc(env(safe-area-inset-top) + 44px)}",
    "#mControls .mRotL{right:calc(env(safe-area-inset-right) + 6px)}",
    "#mControls .mRotR{right:calc(env(safe-area-inset-right) + 50px)}",
    "#mControls .mChat{right:calc(env(safe-area-inset-right) + 94px);font-size:11px}",
    "html.touch #chestPanel{right:6px;top:8px;width:208px;padding:6px}",
    "html.touch #chestPanel .chGrid{gap:3px}",
    "html.touch #chestPanel .chHint{display:none}",
    "#mControls .mCraft{right:calc(env(safe-area-inset-right) + 182px);font-size:10px}",
    "#mControls .mFull{right:calc(env(safe-area-inset-right) + 138px);font-size:11px}",
    "#mControls.inCombat .mJoy,#mControls.inCombat .mPick,#mControls.inCombat .mDrop,#mControls.inCombat .mSmall{display:none}",
    "#mControls.invOpen .mJoy,#mControls.invOpen .mPick,#mControls.invOpen .mDrop,#mControls.invOpen .mSmall{display:none}",
    "#mControls.chatting .mJoy,#mControls.chatting .mBtn{display:none}",
    "#mRotate{position:fixed;inset:0;z-index:90;background:#12121f;color:#fff;font-family:sans-serif;display:none;align-items:center;justify-content:center;text-align:center;padding:24px;font-size:18px}",
    "@media (orientation:portrait){html.touch #mRotate{display:flex}}"
  ].join("\n");
  document.head.appendChild(style);

  const rotateHint = document.createElement("div");
  rotateHint.id = "mRotate";
  rotateHint.textContent = "Turn your phone sideways to play.";
  document.body.appendChild(rotateHint);

  let built = false;
  let root = null;

  function toast(text) {
    if (typeof itemToast === "function") itemToast(text);
  }

  function setKeys(sx, sy) {
    if (typeof moveKeys === "undefined" || !moveKeys) return;
    moveKeys.A.isDown = sx < 0;
    moveKeys.D.isDown = sx > 0;
    moveKeys.W.isDown = sy < 0;
    moveKeys.S.isDown = sy > 0;
  }

  function makeButton(cls, label, onTap) {
    const b = document.createElement("div");
    b.className = "mBtn " + cls;
    b.textContent = label;
    b.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      b.classList.add("down");
      onTap();
    });
    const up = () => b.classList.remove("down");
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("pointerleave", up);
    root.appendChild(b);
    return b;
  }

  function buildJoystick() {
    const base = document.createElement("div");
    base.className = "mJoy";
    const knob = document.createElement("div");
    knob.className = "mKnob";
    base.appendChild(knob);
    root.appendChild(base);
    let activeId = null;
    const radius = 66;
    const update = (ev) => {
      const rect = base.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dx = ev.clientX - cx;
      let dy = ev.clientY - cy;
      const mag = Math.sqrt(dx * dx + dy * dy);
      const limit = radius - 20;
      const shownX = mag > limit ? dx / mag * limit : dx;
      const shownY = mag > limit ? dy / mag * limit : dy;
      knob.style.transform = "translate(" + shownX + "px," + shownY + "px)";
      if (mag < 22) {
        setKeys(0, 0);
        return;
      }
      const sx = Math.abs(dx) / mag > 0.38 ? (dx > 0 ? 1 : -1) : 0;
      const sy = Math.abs(dy) / mag > 0.38 ? (dy > 0 ? 1 : -1) : 0;
      setKeys(sx, sy);
    };
    const release = () => {
      activeId = null;
      knob.style.transform = "translate(0,0)";
      setKeys(0, 0);
    };
    base.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      if (activeId !== null) return;
      activeId = ev.pointerId;
      try { base.setPointerCapture(ev.pointerId); } catch (e) {}
      update(ev);
    });
    base.addEventListener("pointermove", (ev) => {
      if (ev.pointerId !== activeId) return;
      ev.preventDefault();
      update(ev);
    });
    base.addEventListener("pointerup", (ev) => { if (ev.pointerId === activeId) release(); });
    base.addEventListener("pointercancel", (ev) => { if (ev.pointerId === activeId) release(); });
  }

  function toggleChat(force) {
    const on = typeof force === "boolean" ? force : !document.documentElement.classList.contains("chatOn");
    document.documentElement.classList.toggle("chatOn", on);
    root.classList.toggle("chatting", on);
    const input = document.getElementById("chatInput");
    if (on) {
      input.focus();
    } else {
      input.blur();
    }
  }

  function goFullscreen() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        req.call(el).catch(() => {});
      }
      return;
    }
    toast("On iPhone: tap Share, then Add to Home Screen, then open it from there to play full screen.");
  }

  function build() {
    root = document.createElement("div");
    root.id = "mControls";
    document.body.appendChild(root);
    buildJoystick();
    makeButton("mBig", "Interact", () => {
      if (typeof itemMenuTry === "function" && itemMenuTry()) return;
      if (typeof worldInteract === "function") worldInteract();
    });
    makeButton("mBag", "Bag", () => { if (typeof toggleInventory === "function") toggleInventory(); });
    makeButton("mPick", "Pick up", () => { if (typeof attemptPickup === "function") attemptPickup(); });
    makeButton("mDrop", "Drop", () => { if (typeof attemptDrop === "function") attemptDrop(); });
    makeButton("mSmall mRotL", "↺", () => { if (typeof rotateView === "function") rotateView(1); });
    makeButton("mSmall mRotR", "↻", () => { if (typeof rotateView === "function") rotateView(-1); });
    makeButton("mSmall mChat", "Chat", () => toggleChat());
    makeButton("mSmall mCraft", "Craft", () => { if (typeof craftToggle === "function") craftToggle(); });
    makeButton("mSmall mFull", "Full", goFullscreen);
    const input = document.getElementById("chatInput");
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") setTimeout(() => toggleChat(false), 30);
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (document.activeElement !== input) toggleChat(false);
      }, 120);
    });
    document.addEventListener("contextmenu", (ev) => ev.preventDefault());
    document.addEventListener("gesturestart", (ev) => ev.preventDefault());
    let lastTouchEnd = 0;
    document.addEventListener("touchend", (ev) => {
      const now = Date.now();
      if (now - lastTouchEnd < 350) ev.preventDefault();
      lastTouchEnd = now;
    }, { passive: false });
    setInterval(() => {
      const combat = document.getElementById("combat");
      root.classList.toggle("inCombat", !!combat && !combat.classList.contains("hidden"));
      root.classList.toggle("invOpen", typeof inventoryOpen !== "undefined" && !!inventoryOpen);
      if (typeof worldPlayerMode !== "undefined" && !worldPlayerMode) root.style.display = "none";
    }, 250);
  }

  setInterval(() => {
    if (built) return;
    if (typeof worldPlayerMode !== "undefined" && worldPlayerMode) {
      built = true;
      build();
    }
  }, 300);
})();
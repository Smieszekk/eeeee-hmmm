(() => {
  // ===== SETTINGS =====
  // Tiles to click, by the name shown on the page (e.g. 'Music Video', 'Viral').
  const CLICKS = [
    { name: 'Music Video', everyMs: 100 },
  ];
  const BOOST = { name: 'Boost', everyMs: 152500 };       // page shows 2m 30s cooldown
  const COLLAB = {
    everyMs: 602000,                                       // cooldown seen in logs: 600 s
    target: window.COLLAB_TARGET_CHANNEL_ID || 'UCg0qWTbn3R6j5K7YWbrMLNw',
    waitAfterTypeMs: 1500,
  };
  const DISSTRACK = {
    everyMs: 1802000,                                       // set to the real Disstrack cooldown
    target: window.DISSTRACK_TARGET_CHANNEL_ID || 'UCt_yPcT2JiSM0PMAwiyUzGw',   // <- put the target channel ID here
    waitAfterTypeMs: 1500,
  };
  // ====================

  const log = (...a) => console.log('[grind]', ...a);
  const warn = (...a) => console.warn('[grind]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (window.stopAutoGrind) window.stopAutoGrind();
  const timers = [];
  window.stopAutoGrind = () => {
    timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    delete window.stopAutoGrind;
    log('all loops stopped');
  };

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }

  function isDisabled(el) {
    return el.disabled || el.getAttribute('aria-disabled') === 'true';
  }

  function clickableOf(el, buttonOnly) {
    const btn = el.closest('button, [role="button"]');
    if (btn) return btn;
    if (buttonOnly) return null;
    let cur = el;
    for (let i = 0; i < 5 && cur && cur !== document.body; i++, cur = cur.parentElement) {
      if (getComputedStyle(cur).cursor === 'pointer') return cur;
    }
    return null;
  }

  // Finds a clickable element by the text it shows (the tile name, or the button label)
  function findByText(text, buttonOnly) {
    const want = text.trim().toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.nodeValue.trim().toLowerCase();
      if (t !== want && !t.startsWith(want + ' ')) continue;
      const el = node.parentElement;
      if (!el || !isVisible(el)) continue;
      const target = clickableOf(el, buttonOnly);
      if (target) return target;
    }
    return null;
  }

  function clickNamed(name) {
    const el = findByText(name, false);
    if (!el) return warn('not found on the page:', name);
    if (isDisabled(el)) return;
    el.click();
  }

  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findCollabInput(btn) {
    let box = btn;
    for (let i = 0; i < 5 && box; i++, box = box.parentElement) {
      const inp = box.querySelector('input');
      if (inp) return inp;
    }
    return null;
  }

  // Types a channel ID into the field next to the button and clicks it.
  // label = text on the button ('Collab' or 'Disstrack').
  async function doTargeted(label, cfg) {
    if (!cfg.target || cfg.target.startsWith('WPISZ')) {
      return warn(label + ': no target channel ID set, skipping');
    }
    const btn = findByText(label, true);
    if (!btn) return warn(label + ' button not found');
    const input = findCollabInput(btn);
    if (!input) return warn(label + ' input not found');

    setValue(input, cfg.target);
    await sleep(cfg.waitAfterTypeMs);

    const btn2 = findByText(label, true) || btn;
    if (isDisabled(btn2)) {
      return warn(label + ' button is still disabled after typing the ID. The site probably wants a search result to be picked first.');
    }
    btn2.click();
    log(label + ' clicked for', cfg.target);
  }

  const doCollab = () => doTargeted('Collab', COLLAB);
  const doDisstrack = () => doTargeted('Disstrack', DISSTRACK);

  function every(ms, fn, delayMs = 0) {
    timers.push(setTimeout(() => {
      fn();
      timers.push(setInterval(fn, ms));
    }, delayMs));
  }

  function start() {
    CLICKS.forEach((c) => every(c.everyMs, () => clickNamed(c.name)));
    every(BOOST.everyMs, () => clickNamed(BOOST.name));
    every(COLLAB.everyMs, doCollab);
    every(DISSTRACK.everyMs, doDisstrack, 10000);
    log('loops started:', CLICKS.map((c) => c.name).join(', '), '+ Boost + Collab + Disstrack');
  }

  // Wait until the page has rendered the tiles, then start
  let waited = 0;
  const poll = setInterval(() => {
    waited++;
    if (findByText(CLICKS[0].name, false)) {
      clearInterval(poll);
      start();
    } else if (waited % 30 === 0) {
      warn('still waiting for "' + CLICKS[0].name + '" to appear on the page (' + waited + 's)');
    }
  }, 1000);
  timers.push(poll);
})();

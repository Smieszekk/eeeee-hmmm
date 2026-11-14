(() => {
  // Captcha ("grind check") solver for the redesigned page.
  // Works from what is visible on the page, not from internal function names.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const OPS = '[+\\-\\u2212\\u00d7x*]';
  const QUESTION_RE = new RegExp('(-?\\d+)\\s*(' + OPS + ')\\s*(-?\\d+)', 'i');
  const WALKER_RE = new RegExp('(-?\\d+)\\s*(' + OPS + ')\\s*(-?\\d+)\\s*[=?]', 'i');
  const CONTAINERS =
    '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="captcha" i], ' +
    '[class*="check" i], [id*="check" i], [id*="captcha" i]';
  const INPUTS = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])';
  let busy = false;

  function visible(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }

  function solve(a, op, b) {
    const x = parseInt(a, 10);
    const y = parseInt(b, 10);
    if (op === '+') return x + y;
    if (op === '-' || op === '\u2212') return x - y;
    return x * y;
  }

  function findByWalker() {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const m = n.nodeValue.match(WALKER_RE);
      if (m && n.parentElement && visible(n.parentElement)) return { el: n.parentElement, m };
    }
    return null;
  }

  function findQuestion() {
    const legacy = document.getElementById('checkQuestion') || document.getElementById('grindCheckQuestion');
    const pool = legacy ? [legacy] : Array.from(document.querySelectorAll(CONTAINERS)).filter(visible);
    let best = null;
    for (const el of pool) {
      const text = (el.innerText || '').trim();
      const m = text.match(QUESTION_RE);
      if (m && (!best || text.length < best.len)) best = { el, m, len: text.length };
    }
    return best || findByWalker();
  }

  function findInput(from) {
    let el = from;
    for (let i = 0; el && i < 7; i++, el = el.parentElement) {
      const inp = Array.from(el.querySelectorAll(INPUTS)).find(visible);
      if (inp) return { inp, box: el };
    }
    return null;
  }

  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function submit(box, inp) {
    const buttons = Array.from(box.querySelectorAll('button, [role="button"], input[type="submit"]')).filter(visible);
    const btn = buttons.find((b) => /\b(submit|verify|check|confirm|continue|send|ok|done)\b/i.test(b.innerText || b.value || ''));
    if (btn) {
      btn.click();
      return 'button "' + (btn.innerText || btn.value || '').trim() + '"';
    }
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    if (inp.form && inp.form.requestSubmit) inp.form.requestSubmit();
    return 'Enter key';
  }

  async function handleCheck() {
    if (busy) return;
    busy = true;
    try {
      console.log('[captcha] HTTP 428 detected, solving in 1s...');
      await sleep(1000);
      if (typeof window.showGrindCheck === 'function') window.showGrindCheck();

      let q = null;
      for (let i = 0; i < 20 && !q; i++) {
        q = findQuestion();
        if (!q) await sleep(500);
      }
      if (!q) {
        console.error('[captcha] question not found on the page');
        return;
      }

      const answer = solve(q.m[1], q.m[2], q.m[3]);
      console.log('[captcha] solved: ' + q.m[1] + ' ' + q.m[2] + ' ' + q.m[3] + ' = ' + answer);

      const found = findInput(q.el);
      if (!found) {
        console.error('[captcha] answer input not found. Text near the question:', (q.el.innerText || '').slice(0, 300));
        return;
      }

      setValue(found.inp, String(answer));
      await sleep(300);

      let how;
      if (typeof window.submitGrindCheck === 'function') {
        window.submitGrindCheck();
        how = 'submitGrindCheck()';
      } else {
        how = submit(found.box, found.inp);
      }
      console.log('[captcha] submitted via ' + how);
    } catch (err) {
      console.error('[captcha] error:', err);
    } finally {
      setTimeout(() => { busy = false; }, 5000);
    }
  }

  // Catch HTTP 428 on fetch and XHR (responses pass through unchanged)
  if (!window.__captchaHooked) {
    window.__captchaHooked = true;

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      if (response.status === 428) handleCheck();
      return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () {
      this.addEventListener('load', () => {
        if (this.status === 428) handleCheck();
      });
      return originalOpen.apply(this, arguments);
    };
  }

  console.log('[captcha] 428 interceptor active');
})();

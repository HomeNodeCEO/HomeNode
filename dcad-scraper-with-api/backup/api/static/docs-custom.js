// Trigger "Execute" when pressing Enter in any parameter input/textarea/select.
(function () {
  function findClosest(el, selector) {
    while (el && el !== document && !el.matches(selector)) el = el.parentNode;
    return el && el.matches && el.matches(selector) ? el : null;
  }

  function enableTryItOut(opblock) {
    const btn = opblock.querySelector('.try-out__btn');
    if (btn && btn.innerText.toLowerCase().includes('try it out')) {
      btn.click();
    }
  }

  function execute(opblock) {
    const execBtn = opblock.querySelector('.execute-wrapper .btn.execute');
    if (execBtn) execBtn.click();
  }

  function onKeyDown(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;

    const target = e.target;
    if (!target) return;
    if (!target.matches('input, textarea, select')) return;

    const opblock = findClosest(target, '.opblock');
    if (!opblock) return;

    e.preventDefault();
    // Ensure "try it out" is enabled, then execute
    enableTryItOut(opblock);
    // Small delay lets Swagger UI enable the fields if needed
    setTimeout(() => execute(opblock), 50);
  }

  window.addEventListener('keydown', onKeyDown, true);
})();
